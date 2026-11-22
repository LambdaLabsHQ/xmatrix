import { enqueueNornEventDeliveries, PostgresNornProgramRepository, readWaitingNornPrograms } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { githubRepositoryDelegated } from "./app-connectors";
import { findAppConnection } from "./apps";
import { isNornStream, nornStep, type NornStream } from "./norn-host";
import { createPostgresAuthorityFleet } from "./postgres-authority-fleet";
import { postgresMessageRoute } from "./postgres-message-authority";
import type { Env } from "./types";
import type { CloudEventInput } from "./vendor/norn/runtime/ledger";

const WAITING_PAGE_LIMIT = 200;
const MAX_WAITING_PAGES_PER_SHARD = 50;

/** Current-grant evidence checked again when the Channel coordinator retries an owed event delivery. */
export type NornEventGrant =
  | { kind: "github"; repository: string; installationId: string }
  | { kind: "connector"; provider: string; authorizedUserId?: string };

/** Durable delivery payload stored in `data.norn_event_deliveries.payload_json`. */
export interface NornEventDeliveryPayload {
  what: string;
  streams: NornStream[];
  cloudEvent?: CloudEventInput;
  grant?: NornEventGrant;
}

/** Parse a stored delivery payload; malformed rows settle without advancing the ledger. */
export function parseNornEventDeliveryPayload(raw: unknown): NornEventDeliveryPayload | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as Record<string, unknown>;
  if (typeof row.what !== "string" || !Array.isArray(row.streams)) return undefined;
  const streams = row.streams.filter(isNornStream);
  if (!streams.length) return undefined;
  let grant: NornEventGrant | undefined;
  if (row.grant && typeof row.grant === "object" && !Array.isArray(row.grant)) {
    const g = row.grant as Record<string, unknown>;
    if (g.kind === "github" && typeof g.repository === "string" && typeof g.installationId === "string") {
      grant = { kind: "github", repository: g.repository, installationId: g.installationId };
    } else if (g.kind === "connector" && typeof g.provider === "string") {
      grant = { kind: "connector", provider: g.provider,
        ...(typeof g.authorizedUserId === "string" ? { authorizedUserId: g.authorizedUserId } : {}) };
    }
  }
  const cloudEvent = row.cloudEvent && typeof row.cloudEvent === "object" && !Array.isArray(row.cloudEvent)
    ? row.cloudEvent as CloudEventInput : undefined;
  return { what: row.what, streams, ...(cloudEvent ? { cloudEvent } : {}), ...(grant ? { grant } : {}) };
}

/** Recheck current grant before delivering an owed outside event from the Channel coordinator. */
export async function nornEventDeliveryAllowed(env: Env, input: {
  spaceId: string; authorityUserId: string; grant?: NornEventGrant;
}): Promise<boolean> {
  if (!input.grant) return true;
  if (input.grant.kind === "connector") {
    return !input.grant.authorizedUserId || input.authorityUserId === input.grant.authorizedUserId;
  }
  const [owner, repo] = input.grant.repository.split("/");
  if (!owner || !repo) return false;
  try {
    const connection = await findAppConnection(env, {
      spaceId: input.spaceId, providerId: "github", actorUserId: input.authorityUserId,
    });
    return connection?.status === "configured" &&
      await githubRepositoryDelegated(env, connection, input.grant.installationId, owner, repo);
  } catch {
    return false;
  }
}

/**
 * An outside event reaches the Norn programs that wait for it
 * (docs/architecture/norn-host.md): each eligible running program gets a
 * durable delivery obligation first (paged boundedly across each shard), then
 * an isolated immediate delivery attempt. If any program fails (e.g. a lock
 * timeout), it is never thrown into other programs or other webhook effects;
 * its durable obligation stays due for its Channel coordinator to retry with
 * current grant rechecks. Returns how many programs heard it immediately.
 */
export async function occurNornEvent(env: Env, input: {
  id: string; spaceId?: string; what: string;
  cloudEvent?: CloudEventInput;
  grant?: NornEventGrant;
  matches: (stream: NornStream) => boolean;
  allowed?: (program: { spaceId: string; authorityUserId: string }) => Promise<boolean>;
}): Promise<number> {
  let heard = 0;
  const id = await sha256Hex(input.id);
  for (const shard of createPostgresAuthorityFleet(env, { applicationName: "xmatrix-norn-events", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 }).physicalShards) {
    let afterProgramId: string | undefined;
    for (let page = 0; page < MAX_WAITING_PAGES_PER_SHARD; page++) {
      let programs: Awaited<ReturnType<typeof readWaitingNornPrograms>>;
      try {
        programs = await readWaitingNornPrograms(shard.database, {
          requestId: crypto.randomUUID(),
          ...(input.spaceId ? { spaceId: input.spaceId } : {}),
          ...(afterProgramId ? { afterProgramId } : {}),
          limit: WAITING_PAGE_LIMIT,
        });
      } catch (error) {
        console.warn("Norn outside-event shard scan failed", {
          shardId: shard.shardId, error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
      if (!programs.length) break;
      afterProgramId = programs.at(-1)!.programId;
      const eligible: Array<{ program: (typeof programs)[number]; payload: NornEventDeliveryPayload }> = [];
      for (const program of programs) {
        const streams = program.waits.filter(isNornStream).filter(input.matches);
        if (!streams.length) continue;
        const ok = input.allowed ? await input.allowed(program).catch(() => false) : true;
        if (!ok) continue;
        eligible.push({
          program,
          payload: {
            what: input.what,
            streams,
            ...(input.cloudEvent ? { cloudEvent: input.cloudEvent } : {}),
            ...(input.grant ? { grant: input.grant } : {}),
          },
        });
      }
      if (eligible.length) {
        try {
          await enqueueNornEventDeliveries(shard.database, {
            requestId: `norn-event-enqueue:${id}:${page}`.slice(0, 200),
            deliveries: eligible.map(({ program, payload }) => ({
              spaceId: program.spaceId, channelId: program.channelId,
              programId: program.programId, eventId: id, payload,
            })),
          });
        } catch (error) {
          console.warn("Norn outside-event obligation enqueue failed", {
            shardId: shard.shardId, error: error instanceof Error ? error.message : String(error),
          });
        }
        for (const { program, payload } of eligible) {
          const requestId = `norn-event:${id}:${program.programId}`;
          try {
            const repository = new PostgresNornProgramRepository(shard.database,
              await postgresMessageRoute(env, program.channelId, requestId, { database: shard.database }));
            await repository.deliverEvent(
              { requestId, channelId: program.channelId, programId: program.programId, eventId: id },
              nornStep(undefined, { id, streams: payload.streams, what: payload.what,
                ...(payload.cloudEvent ? { cloudEvent: payload.cloudEvent } : {}) }),
            );
            heard++;
          } catch (error) {
            console.warn("Norn outside-event immediate delivery deferred to coordinator", {
              channelId: program.channelId, programId: program.programId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await wakeAgentLaunchCoordinator(env, program.channelId, ["norn"]).catch((error: unknown) => {
            console.warn("Norn outside-event coordinator wake failed", {
              channelId: program.channelId, programId: program.programId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        }
      }
      if (programs.length < WAITING_PAGE_LIMIT) break;
    }
  }
  return heard;
}

/**
 * Checks whether at least one authorized running Norn program is currently
 * waiting on a stream matching `input.matches` (e.g. so Gmail notification
 * drain reads structured message headers even when no ordinary Channel
 * subscription exists).
 */
export async function hasWaitingNornProgram(env: Env, input: {
  spaceId?: string;
  matches: (stream: NornStream) => boolean;
  allowed?: (program: { spaceId: string; authorityUserId: string }) => Promise<boolean>;
}): Promise<boolean> {
  for (const shard of createPostgresAuthorityFleet(env, { applicationName: "xmatrix-norn-events", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000 }).physicalShards) {
    const programs = await readWaitingNornPrograms(shard.database, { requestId: crypto.randomUUID(),
      ...(input.spaceId ? { spaceId: input.spaceId } : {}) });
    for (const program of programs) {
      if (!program.waits.filter(isNornStream).some(input.matches)) continue;
      if (input.allowed && !await input.allowed(program)) continue;
      return true;
    }
  }
  return false;
}
