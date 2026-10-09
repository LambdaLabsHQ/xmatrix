import { DurableObject } from "cloudflare:workers";

import { RelayPostgresAgentLaunchCoordinatorService, type CoordinatorPassPlan } from "./postgres-agent-launch-coordinator";
import {
  MIN_RECHECK_MS, alarmAt, effectiveDue, isScheduledStep, mergeWake, nextStalls, stallBackoff, stepsToRun,
  type PendingWake, type ScheduledStep, type StepDue, type StepStalls,
} from "./postgres-agent-launch-schedule";
import { AgentLaunchCoordinatorLanes } from "./postgres-agent-launch-coordinator-lanes";
import { backgroundAdmissionFor } from "./postgres-background-admission-do";
import { recordAgentLaunchCoordinator } from "./postgres-coordination-observability";
import type { Env } from "./types";

/** How long a pass waits when the shard's permits cannot be asked at all. */
const ADMISSION_UNAVAILABLE_RETRY_MS = 5_000;

/**
 * One Channel's coordinator for work that waits on the outside world:
 * Launches, reborns, terminal reports, registration preparations and routing
 * retries. The writer of such work wakes this object before answering; the
 * alarm is only ever the Channel's next due item, never a period.
 *
 * A wake is an event: it names the kinds of work it may have moved (a caller
 * that names none means every kind). A woken pass reads when each kind is due
 * and runs only those due and those named; a timed pass runs only those due
 * when its alarm was set. A kind a pass ran and left due waits on the outside
 * world and backs off on its own (`postgres-agent-launch-schedule.ts`), so it
 * neither spins nor holds back the Channel's other work.
 *
 * Storage holds only what the alarm needs: which Channel and shard this object
 * serves, the effective due time of each kind, each stalled kind's retry, and
 * wakes no pass has taken yet. Every business fact stays in PostgreSQL.
 */
export class RelayPostgresAgentLaunchChannel extends DurableObject<Env> {
  private readonly lanes: AgentLaunchCoordinatorLanes;
  private readonly service: RelayPostgresAgentLaunchCoordinatorService;
  private route: { channelId: string; shardId?: string } | undefined;
  /** What the last pass ran, and the due times it read if it ran nothing. */
  private lastPass: { ran: ReadonlySet<ScheduledStep> | undefined; due?: StepDue } | undefined;
  /** Consecutive due reads that failed; the next try backs off with them. */
  private readFailures = 0;
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
        // A wake since the last pass makes this pass interactive.
        const wake = await this.state.storage.get<PendingWake>("wake");
        if (wake) await this.state.storage.delete("wake");
        const woken = wake !== undefined;
        const admission = backgroundAdmissionFor(this.env,
          route.shardId ?? this.env.RELAY_POSTGRES_SHARD_ID ?? "default", route.channelId);
        const holder = `${route.channelId}:${crypto.randomUUID()}`;
        if (admission) {
          // Refused, or the shard's permits cannot be asked: either way this
          // pass waits rather than reach PostgreSQL outside the bound.
          const decision = await admission.acquire(holder, woken ? "interactive" : "maintenance")
            .catch(() => ({ granted: false as const, retryAfterMs: ADMISSION_UNAVAILABLE_RETRY_MS }));
          if (!decision.granted) {
            if (wake) await this.state.storage.put("wake", mergeWake(await this.state.storage.get<PendingWake>("wake"),
              wake.all ? undefined : wake.named));
            this.admissionRetryAt = Date.now() + decision.retryAfterMs +
              Math.floor(Math.random() * decision.retryAfterMs);
            return 0;
          }
        }
        const startedAt = performance.now();
        try {
          const plan = await this.plan(route, wake);
          this.lastPass = { ran: plan.plan.steps, ...(plan.due && plan.plan.steps?.size === 0 ? { due: plan.due } : {}) };
          // Nothing due and nothing named: the read was the whole pass.
          if (plan.plan.steps?.size === 0) return 0;
          return await this.service.runChannel(route, plan.plan).catch((error: unknown) => {
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

  /**
   * What this pass runs. Every kind when a wake named none, or when the due
   * times are unknown. A woken pass reads them now (a named kind forgets its
   * stall: the event may have moved it); a timed pass uses the effective times
   * its alarm was set from.
   */
  private async plan(route: { channelId: string; shardId?: string }, wake: PendingWake | undefined):
    Promise<{ plan: CoordinatorPassPlan; due?: StepDue }> {
    if (wake?.all) return { plan: { includeParked: true } };
    const now = Date.now();
    const named = new Set(wake?.named ?? []);
    if (!wake) {
      const effective = await this.state.storage.get<StepDue>("due");
      return { plan: { steps: stepsToRun(effective, named, now), includeParked: false } };
    }
    let due: StepDue;
    try { due = await this.service.nextDue(route); }
    catch { return { plan: { includeParked: true } }; }
    const stalls: StepStalls = { ...(await this.state.storage.get<StepStalls>("stalls")) };
    for (const step of named) delete stalls[step];
    await this.state.storage.put("stalls", stalls);
    return { due, plan: { steps: stepsToRun(effectiveDue(due, stalls), named, now),
      includeParked: named.has("registrationStop"),
      ...(due.automation !== undefined ? { automationDue: due.automation } : {}) } };
  }

  /** The alarm follows the Channel's work: each kind's due time, or its retry
   *  while no pass can move it. A pass that ran nothing reuses the due times
   *  it read instead of reading them again. */
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
    const last = this.lastPass;
    this.lastPass = undefined;
    let due = last?.due;
    if (!due) {
      try { due = route ? await this.service.nextDue(route) : {}; }
      catch { due = undefined; }
    }
    if (!due) {
      // Unreadable: the next pass runs every kind, after a backoff of its own.
      this.readFailures += 1;
      await this.state.storage.delete("due");
      await this.state.storage.setAlarm(now + stallBackoff(this.readFailures));
      return;
    }
    this.readFailures = 0;
    const stalls = nextStalls({ now, due, ran: last ? last.ran : undefined,
      stalls: (await this.state.storage.get<StepStalls>("stalls")) ?? {} });
    const effective = effectiveDue(due, stalls);
    await this.state.storage.put({ stalls, due: effective });
    const next = alarmAt(effective, now);
    if (next === null) await this.state.storage.deleteAlarm();
    else await this.state.storage.setAlarm(next);
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
    // The kinds of work this event may have moved; a caller that names none
    // (or an unknown kind) wakes every kind.
    const work = Array.isArray(body.work) && body.work.every(isScheduledStep) ? body.work as ScheduledStep[] : undefined;
    await this.remember({ channelId, ...(shardId ? { shardId } : {}) });
    // The wake is durable before it is answered: a pass lost with this isolate
    // still takes it on the fallback alarm, which the pass replaces.
    await this.state.storage.put("wake", mergeWake(await this.state.storage.get<PendingWake>("wake"), work));
    await this.state.storage.setAlarm(Date.now() + 5_000);
    void this.lanes.claim();
    return Response.json({ ok: true });
  }

  async alarm(): Promise<void> {
    await this.lanes.claim();
  }
}
