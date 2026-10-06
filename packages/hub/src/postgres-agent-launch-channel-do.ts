import { DurableObject } from "cloudflare:workers";

import { RelayPostgresAgentLaunchCoordinatorService } from "./postgres-agent-launch-coordinator";
import { AgentLaunchCoordinatorLanes } from "./postgres-agent-launch-coordinator-lanes";
import { backgroundAdmissionFor } from "./postgres-background-admission-do";
import { recordAgentLaunchCoordinator } from "./postgres-coordination-observability";
import type { Env } from "./types";

/** The soonest a Channel re-checks work that is already due. */
const MIN_RECHECK_MS = 1_000;
/** The longest a due item that made no progress waits before the next try. */
const MAX_STALLED_BACKOFF_MS = 60_000;
/** How long a pass waits when the shard's permits cannot be asked at all. */
const ADMISSION_UNAVAILABLE_RETRY_MS = 5_000;

/**
 * One Channel's coordinator for work that waits on the outside world:
 * Launches, reborns, terminal reports, registration preparations and routing
 * retries. The writer of such work wakes this object before answering; the
 * alarm is only ever the Channel's next due item, never a period.
 *
 * Storage holds only the routing key the alarm needs — which Channel and shard
 * this object serves. Every business fact stays in PostgreSQL.
 */
export class RelayPostgresAgentLaunchChannel extends DurableObject<Env> {
  private readonly lanes: AgentLaunchCoordinatorLanes;
  private readonly service: RelayPostgresAgentLaunchCoordinatorService;
  private route: { channelId: string; shardId?: string } | undefined;
  /** Consecutive passes after which the earliest item was still already due. */
  private stalled = 0;
  /** A writer woke this Channel since its last pass began. */
  private woken = false;
  /** Set when the shard refused this Channel a pass permit: retry then. */
  private admissionRetryAt: number | undefined;

  constructor(private readonly state: DurableObjectState, env: Env) {
    super(state, env);
    this.service = new RelayPostgresAgentLaunchCoordinatorService(env, undefined,
      (task) => state.waitUntil(task));
    this.lanes = new AgentLaunchCoordinatorLanes({
      claim: async () => {
        const route = await this.routeKey();
        if (!route) return 0;
        // A wake since the last pass makes this pass interactive; it also
        // lets the pass recheck stops parked on their host.
        const woken = this.woken;
        this.woken = false;
        const admission = backgroundAdmissionFor(this.env,
          route.shardId ?? this.env.RELAY_POSTGRES_SHARD_ID ?? "default", route.channelId);
        const holder = `${route.channelId}:${crypto.randomUUID()}`;
        if (admission) {
          // Refused, or the shard's permits cannot be asked: either way this
          // pass waits rather than reach PostgreSQL outside the bound.
          const decision = await admission.acquire(holder, woken ? "interactive" : "maintenance")
            .catch(() => ({ granted: false as const, retryAfterMs: ADMISSION_UNAVAILABLE_RETRY_MS }));
          if (!decision.granted) {
            this.woken ||= woken;
            this.admissionRetryAt = Date.now() + decision.retryAfterMs +
              Math.floor(Math.random() * decision.retryAfterMs);
            return 0;
          }
        }
        const startedAt = performance.now();
        try {
          return await this.service.runChannel(route, woken).catch((error: unknown) => {
            recordAgentLaunchCoordinator({
              env: this.env, outcome: "error", preparedToWakeMs: 0, wakeToClaimMs: 0,
              claimBatchSize: 0, eligibleCount: 0, oldestEligibleAgeMs: 0,
              maintainMs: performance.now() - startedAt,
            });
            throw error;
          });
        } finally {
          if (admission) await admission.release(holder).catch(() => undefined);
        }
      },
      schedule: () => this.scheduleNextDue(),
      keepAlive: task => this.state.waitUntil(task),
      onClaimOverrun: () => console.warn("PostgreSQL Agent Launch Channel pass overran its deadline", {
        channelId: this.route?.channelId ?? "unknown",
      }),
      onClaimError: error => console.warn("PostgreSQL Agent Launch Channel pass failed", {
        channelId: this.route?.channelId ?? "unknown",
        errorCode: error instanceof Error ? error.name : "unknown",
      }),
    });
  }

  /** The alarm follows the Channel's next due item. An item still due after a
   *  pass made no progress (a dependency is down); it backs off instead of
   *  spinning, and the backoff resets as soon as the due time moves forward. */
  private async scheduleNextDue(): Promise<void> {
    const route = await this.routeKey();
    const now = Date.now();
    const admissionRetryAt = this.admissionRetryAt;
    this.admissionRetryAt = undefined;
    if (admissionRetryAt !== undefined) {
      // The pass never ran, so nothing moved: come back when a permit frees,
      // without a PostgreSQL read or a stall count.
      await this.state.storage.setAlarm(Math.max(admissionRetryAt, now + MIN_RECHECK_MS));
      return;
    }
    let due: number | undefined;
    try { due = route ? await this.service.nextDueAt(route) : undefined; }
    catch { due = now; }
    if (due === undefined) {
      this.stalled = 0;
      await this.state.storage.deleteAlarm();
      return;
    }
    if (due <= now) this.stalled++; else this.stalled = 0;
    const backoff = this.stalled > 0
      ? Math.min(MAX_STALLED_BACKOFF_MS, MIN_RECHECK_MS * 2 ** (this.stalled - 1)) : 0;
    await this.state.storage.setAlarm(Math.max(due, now + MIN_RECHECK_MS, now + backoff));
  }

  private async routeKey(): Promise<{ channelId: string; shardId?: string } | undefined> {
    this.route ??= await this.state.storage.get<{ channelId: string; shardId?: string }>("route");
    return this.route;
  }

  private async remember(route: { channelId: string; shardId?: string }): Promise<void> {
    const known = await this.routeKey();
    if (known?.channelId === route.channelId && (known.shardId ?? "") === (route.shardId ?? "")) return;
    this.route = { channelId: route.channelId, ...(route.shardId ? { shardId: route.shardId } : {}) };
    await this.state.storage.put("route", this.route);
  }

  /**
   * The writer's handoff. It resolves once this object has durably recorded
   * which Channel it serves, so a writer that awaits it knows the work has an
   * owner; the pass itself runs after the response.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/wake") {
      return new Response("Not found", { status: 404 });
    }
    const body = await request.json().catch(() => ({})) as Record<string, unknown>;
    const channelId = typeof body.channelId === "string" ? body.channelId.trim() : "";
    const shardId = typeof body.shardId === "string" ? body.shardId.trim() : "";
    if (!channelId || channelId.length > 300 || shardId.length > 160) {
      return Response.json({ error: "channelId is required" }, { status: 400 });
    }
    await this.remember({ channelId, ...(shardId ? { shardId } : {}) });
    // A durable alarm shortly after, so a pass lost with this isolate still
    // runs; the pass itself replaces it with the Channel's next due time.
    await this.state.storage.setAlarm(Date.now() + 5_000);
    this.woken = true;
    void this.lanes.claim();
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    await this.lanes.claim();
  }
}
