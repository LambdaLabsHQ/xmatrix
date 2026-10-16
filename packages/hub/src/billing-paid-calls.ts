import { PostgresPaidCallRepository, type PaidCallReceipt } from "@xmatrix/db";
import { sha256Hex } from "@xmatrix/protocol";
import type { Env } from "./types";
import { platformAdminSpaceId } from "./admin-platform-access";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_AUTHORITY_TIMEOUTS } from "./postgres-authority-http";
import { upstreamMeter, type UpstreamCallPrice, type UpstreamMeter } from "./usage-cost-metering";
import { ProviderRequestError } from "./connectors/http";
import { postBillingNotice } from "./billing-notice";

export function paidCallRepository(env: Env): PostgresPaidCallRepository {
  return new PostgresPaidCallRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-paid-calls", ...POSTGRES_AUTHORITY_TIMEOUTS,
  }));
}

interface PaidXScope {
  spaceId: string; actorUserId: string; billingKey: string; creditsWaived: boolean;
  announce?: (receipt: PaidCallReceipt) => Promise<void>;
  beforeCall?: (operation: string) => Promise<void>;
}
interface MediaReservation {
  id: string; maximum: number; attempted: number; billed: number;
  outcome: "ok" | "rejected" | "uncertain";
}

/** One actual command execution owns this object. Its permanent PostgreSQL
 * attempts survive retries; only public kinds and counts cross into billing.
 */
export class PaidXCalls {
  private ordinal = 0;
  private group?: MediaReservation;
  private charged = 0;
  private remaining = 0;
  private used = false;
  private pending = false;
  constructor(private readonly repository: PostgresPaidCallRepository, private readonly scope: PaidXScope,
    private readonly telemetry: UpstreamMeter) {}

  summary(): string {
    return this.used ? `X API: ${this.charged} credits ${this.pending ? "reserved (settlement pending)" : "charged"}; ` +
      `${this.remaining} remaining.` : "";
  }

  private async reserve(kind: UpstreamCallPrice["kind"], units: number, label: string) {
    const callId = `x:${await sha256Hex(`${this.scope.billingKey}\0${label}\0${this.ordinal++}`)}`;
    let receipt: PaidCallReceipt;
    try {
      receipt = await this.repository.reserve({ ...this.scope, callId, kind, units });
    } catch (error) {
      if (error && typeof error === "object" && "status" in error && typeof error.status === "number") {
        throw new ProviderRequestError(error.status, error instanceof Error ? error.message : "X credit admission failed");
      }
      throw error;
    }
    if (receipt.replayed) {
      await this.scope.announce?.(receipt);
      throw new ProviderRequestError(409, `This X request was already attempted; no second call or credit charge was made. ` +
        `${receipt.chargedCredits} credits were charged or reserved; see its original result.`);
    }
    this.used = true;
    this.charged += receipt.reservedCredits;
    this.remaining = receipt.remainingCredits;
    return receipt;
  }

  private async settle(id: string, actualUnits: number, outcome: MediaReservation["outcome"], reserved: number) {
    // Settlement is idempotent. If its COMMIT acknowledgement is lost, a
    // bounded retry reads the permanent receipt rather than refunding twice.
    let settled: PaidCallReceipt | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        settled = await this.repository.settle({ spaceId: this.scope.spaceId, callId: id,
          actualUnits, outcome, announce: Boolean(this.scope.announce) && !this.scope.creditsWaived });
        break;
      } catch {
        if (attempt === 1) {
          // Keep the original outcome: an unconfirmed local settlement never
          // resends an upstream write or turns it into a purported X failure.
          this.pending = true;
          console.error("Paid X settlement remains reserved", { callId: id });
        }
      }
    }
    if (settled) {
      this.charged -= reserved - settled.chargedCredits;
      this.remaining = settled.remainingCredits;
      try { await this.scope.announce?.(settled); }
      catch { console.error("Paid X notice delivery failed", { callId: id }); }
    }
  }

  async reserveMedia(maximum: number): Promise<() => Promise<void>> {
    if (this.group) throw new ProviderRequestError(409, "An X media reservation is already active");
    const receipt = await this.reserve("x_media", maximum, "media-upload");
    const group: MediaReservation = { id: receipt.callId, maximum, attempted: 0, billed: 0, outcome: "ok" };
    this.group = group;
    return async () => {
      if (this.group !== group) return;
      this.group = undefined;
      await this.settle(group.id, group.billed, group.outcome, receipt.reservedCredits);
    };
  }

  readonly meter: UpstreamMeter = async (source, operation, call, price) => {
    if (source !== "x" || operation === "oauth_token") return this.telemetry(source, operation, call, price);
    if (!price) throw new ProviderRequestError(503, "This X operation has no configured credit price");
    const group = price.kind === "x_media" ? this.group : undefined;
    if (group && group.attempted >= group.maximum) throw new ProviderRequestError(409, "X media exceeded its reserved request count");
    const receipt = group ? null : await this.reserve(price.kind, price.maximumUnits, operation);
    let sent = false, actual = price.maximumUnits, outcome: MediaReservation["outcome"] = "ok";
    try {
      await this.scope.beforeCall?.(operation);
      if (group) { group.attempted++; group.billed++; }
      sent = true;
      const result = await this.telemetry(source, operation, call, price);
      if (operation === "user_posts_read") {
        const data = (result as { data?: unknown }).data;
        actual = Array.isArray(data) ? Math.min(data.length, price.maximumUnits)
          : data === undefined && !(result as { errors?: unknown }).errors ? 0 : price.maximumUnits;
      }
      return result;
    } catch (error) {
      // A definite request rejection returned by X has no successful resource.
      // A timeout, transport loss or 5xx may have completed: retain its reserve.
      const rejected = error instanceof ProviderRequestError && [400,401,402,403,404,422,429].includes(error.status);
      outcome = !sent || rejected ? "rejected" : "uncertain";
      if (outcome === "rejected") { actual = 0; if (group && sent) group.billed--; }
      if (group) group.outcome = outcome;
      throw error;
    } finally {
      if (receipt) await this.settle(receipt.callId, actual, outcome, receipt.reservedCredits);
    }
  };
}

export function paidXCalls(env: Env, input: { spaceId: string; actorUserId: string; billingKey: string;
  action: string; channelId?: string; beforeCall?: (operation: string) => Promise<void> }): PaidXCalls {
  return new PaidXCalls(paidCallRepository(env), { ...input,
    creditsWaived: input.spaceId === platformAdminSpaceId(env),
    ...(input.channelId ? { announce: (receipt: PaidCallReceipt) => postBillingNotice(env, input.channelId!,
      receipt.notice ? { ...receipt.notice, userId: input.actorUserId } : undefined) } : {}) },
  upstreamMeter(env, { spaceId: input.spaceId, connector: "x", action: input.action }));
}
