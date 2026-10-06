import {
  relayControlPlaneBoundedText,
  relayControlPlaneDigest,
  relayControlPlaneIntegerAtLeast,
} from "./relay-control-plane-primitives";

const RESERVATION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const RESERVATION_CLEANUP_BATCH_SIZE = 256;
const RESERVATION_CLEANUP_RETRY_DELAY_MS = 1_000;

function text(value: unknown, field: string): string {
  return relayControlPlaneBoundedText(value, field);
}

function integer(value: unknown, field: string, minimum = 0): number {
  return relayControlPlaneIntegerAtLeast(value, minimum, field);
}

/**
 * Legacy per-Channel ordering coordinator for PostgreSQL-backed message facts.
 *
 * New PostgreSQL-authority appends allocate and confirm their sequence in
 * PostgreSQL. This class and binding remain deployable while historical
 * reservations age out and rolling clients/workers converge; the live append
 * path must not call it.
 */
export class RelayPostgresChannelCoordinatorStore {
  constructor(private readonly ctx: DurableObjectState) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sequence_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      channel_id TEXT NOT NULL,
      allocated_sequence INTEGER NOT NULL CHECK (allocated_sequence >= 0),
      confirmed_sequence INTEGER NOT NULL CHECK (confirmed_sequence >= 0),
      updated_at TEXT NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sequence_reservations (
      command_id TEXT PRIMARY KEY,
      sequence INTEGER NOT NULL UNIQUE CHECK (sequence >= 1),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'committed')),
      fact_digest TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    ) STRICT`);
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS sequence_reservations_expiry_idx
      ON sequence_reservations (expires_at, command_id)`);
    ctx.storage.sql.exec(`CREATE INDEX IF NOT EXISTS sequence_reservations_created_idx
      ON sequence_reservations (created_at, command_id)`);
  }

  private earliestReservationExpiry(): number | undefined {
    const expiresAt = this.ctx.storage.sql.exec<{
      expires_at: string;
    } & Record<string, SqlStorageValue>>(
      "SELECT expires_at FROM sequence_reservations ORDER BY expires_at, command_id LIMIT 1",
    ).toArray()[0]?.expires_at;
    if (!expiresAt) return undefined;
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) throw new Error("Reservation expiry is invalid");
    return expiry;
  }

  private async preserveEarliestAlarm(nowMs: number): Promise<void> {
    const expiry = this.earliestReservationExpiry();
    if (expiry === undefined) return;
    const target = Math.max(expiry, nowMs + RESERVATION_CLEANUP_RETRY_DELAY_MS);
    const current = await this.ctx.storage.getAlarm();
    if (current === null || target < current) await this.ctx.storage.setAlarm(target);
  }

  async reserve(input: {
    channelId: string;
    commandId: string;
    observedPostgresHead: number;
    now?: string;
  }): Promise<{ channelId: string; commandId: string; sequence: number; state: "reserved" | "committed" }> {
    const channelId = text(input.channelId, "channelId");
    const commandId = text(input.commandId, "commandId");
    const observed = integer(input.observedPostgresHead, "observedPostgresHead");
    const now = input.now ? new Date(input.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("now is invalid");
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS).toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const state = this.ctx.storage.sql.exec<{
        channel_id: string; allocated_sequence: number; confirmed_sequence: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT channel_id, allocated_sequence, confirmed_sequence FROM sequence_state WHERE singleton = 1",
      ).toArray()[0];
      if (state && state.channel_id !== channelId) throw new Error("Channel coordinator identity mismatch");
      const existing = this.ctx.storage.sql.exec<{
        sequence: number; state: "reserved" | "committed";
      } & Record<string, SqlStorageValue>>(
        "SELECT sequence, state FROM sequence_reservations WHERE command_id = ?",
        commandId,
      ).toArray()[0];
      if (existing) return { channelId, commandId, sequence: existing.sequence, state: existing.state };
      const sequence = Math.max(
        observed,
        Number(state?.allocated_sequence ?? 0),
        Number(state?.confirmed_sequence ?? 0),
      ) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("Channel sequence is exhausted");
      if (state) {
        this.ctx.storage.sql.exec(
          `UPDATE sequence_state SET allocated_sequence = ?, updated_at = ? WHERE singleton = 1`,
          sequence, nowIso,
        );
      } else {
        this.ctx.storage.sql.exec(
          `INSERT INTO sequence_state
            (singleton, channel_id, allocated_sequence, confirmed_sequence, updated_at)
           VALUES (1, ?, ?, ?, ?)`,
          channelId, sequence, observed, nowIso,
        );
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO sequence_reservations
          (command_id, sequence, state, fact_digest, created_at, updated_at, expires_at)
         VALUES (?, ?, 'reserved', NULL, ?, ?, ?)`,
        commandId, sequence, nowIso, nowIso, expiresAt,
      );
      return { channelId, commandId, sequence, state: "reserved" as const };
    });
    await this.preserveEarliestAlarm(now.getTime());
    return result;
  }

  confirm(input: {
    channelId: string;
    commandId: string;
    sequence: number;
    factDigest: string;
    now?: string;
  }): { channelId: string; commandId: string; sequence: number; state: "committed" } {
    const channelId = text(input.channelId, "channelId");
    const commandId = text(input.commandId, "commandId");
    const sequence = integer(input.sequence, "sequence", 1);
    const factDigest = relayControlPlaneDigest(input.factDigest, "factDigest");
    const now = input.now ? new Date(input.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("now is invalid");
    const nowIso = now.toISOString();
    return this.ctx.storage.transactionSync(() => {
      const state = this.ctx.storage.sql.exec<{
        channel_id: string; confirmed_sequence: number;
      } & Record<string, SqlStorageValue>>(
        "SELECT channel_id, confirmed_sequence FROM sequence_state WHERE singleton = 1",
      ).toArray()[0];
      if (!state || state.channel_id !== channelId) throw new Error("Channel coordinator identity mismatch");
      const reservation = this.ctx.storage.sql.exec<{
        sequence: number; state: "reserved" | "committed"; fact_digest: string | null;
      } & Record<string, SqlStorageValue>>(
        "SELECT sequence, state, fact_digest FROM sequence_reservations WHERE command_id = ?",
        commandId,
      ).toArray()[0];
      if (!reservation || reservation.sequence !== sequence) throw new Error("Sequence reservation differs");
      if (reservation.state === "committed" && reservation.fact_digest !== factDigest) {
        throw new Error("Committed fact digest differs");
      }
      this.ctx.storage.sql.exec(
        `UPDATE sequence_reservations SET state = 'committed', fact_digest = ?, updated_at = ?
          WHERE command_id = ?`,
        factDigest, nowIso, commandId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE sequence_state SET confirmed_sequence = MAX(confirmed_sequence, ?), updated_at = ?
          WHERE singleton = 1`,
        sequence, nowIso,
      );
      return { channelId, commandId, sequence, state: "committed" };
    });
  }

  status(input: { channelId: string }): {
    channelId: string;
    allocatedSequence: number;
    confirmedSequence: number;
    reservationCount: number;
  } {
    const channelId = text(input.channelId, "channelId");
    const row = this.ctx.storage.sql.exec<{
      channel_id: string; allocated_sequence: number; confirmed_sequence: number;
    } & Record<string, SqlStorageValue>>(
      "SELECT channel_id, allocated_sequence, confirmed_sequence FROM sequence_state WHERE singleton = 1",
    ).toArray()[0];
    if (row && row.channel_id !== channelId) throw new Error("Channel coordinator identity mismatch");
    const count = this.ctx.storage.sql.exec<{ count: number } & Record<string, SqlStorageValue>>(
      "SELECT COUNT(*) AS count FROM sequence_reservations",
    ).toArray()[0]?.count ?? 0;
    return {
      channelId,
      allocatedSequence: Number(row?.allocated_sequence ?? 0),
      confirmedSequence: Number(row?.confirmed_sequence ?? 0),
      reservationCount: Number(count),
    };
  }

  async alarm(): Promise<{
    deleted: number; remaining: number; oldestAgeMs: number; durationMs: number;
  }> {
    const startedAt = performance.now();
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    this.ctx.storage.sql.exec(
      `DELETE FROM sequence_reservations WHERE command_id IN (
        SELECT command_id FROM sequence_reservations
        WHERE expires_at <= ? ORDER BY expires_at, command_id LIMIT ?
      )`,
      now, RESERVATION_CLEANUP_BATCH_SIZE,
    );
    const deleted = Number(this.ctx.storage.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      "SELECT changes() AS count",
    ).toArray()[0]?.count ?? 0);
    const next = this.earliestReservationExpiry();
    if (next !== undefined) {
      await this.ctx.storage.setAlarm(
        Math.max(next, nowMs + RESERVATION_CLEANUP_RETRY_DELAY_MS),
      );
    }
    const remaining = Number(this.ctx.storage.sql.exec<{
      count: number;
    } & Record<string, SqlStorageValue>>(
      `SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM sequence_reservations ORDER BY expires_at, command_id LIMIT ?
      )`,
      RESERVATION_CLEANUP_BATCH_SIZE + 1,
    ).toArray()[0]?.count ?? 0);
    const oldestCreatedAt = this.ctx.storage.sql.exec<{
      created_at: string;
    } & Record<string, SqlStorageValue>>(
      "SELECT created_at FROM sequence_reservations ORDER BY created_at, command_id LIMIT 1",
    ).toArray()[0]?.created_at;
    const oldestAt = oldestCreatedAt ? Date.parse(oldestCreatedAt) : nowMs;
    return {
      deleted,
      remaining,
      oldestAgeMs: Number.isFinite(oldestAt) ? Math.max(0, nowMs - oldestAt) : 0,
      durationMs: performance.now() - startedAt,
    };
  }
}
