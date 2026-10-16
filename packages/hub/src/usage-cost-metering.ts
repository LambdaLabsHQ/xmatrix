import type { Env } from "./types";
import type { PaidCallKind } from "@xmatrix/billing";

/**
 * Operator-paid variable cost (docs/operations/usage-cost-metering.md): one
 * Analytics Engine datapoint per upstream call the hosted operator pays for —
 * Jev on the operator's AI Gateway key, Composio on the shared project key, X
 * on the company app — so cost can be summed per Space.
 *
 * Layout `usage_cost_v1`. Slots are append-only: a changed meaning is a new
 * layout version, written beside the old one until readers move.
 *   index1   Space id; the owner user id when the call has no Space
 *   blob1    layout version (`usage_cost_v1`)
 *   blob2    source, who bills the operator: `jev` | `composio` | `x`
 *   blob3    scope kind: `space` | `user`
 *   blob4    Jev feature, or the connector (`gmail`, `x`)
 *   blob5    connector action or lifecycle step (`search`, `post`, `connect`, `verify`, …); `none` for Jev
 *   blob6    upstream operation (`proxy`, `posts_create`, `oauth_token`, …); the model for Jev
 *   blob7    outcome: `ok` | `error` | `timeout`
 *   blob8    error code: an allowlisted Jev code, `http_<status>`, `network`; `none`
 *   blob9    Hub version
 *   double1  calls (always 1; sum it weighted by `_sample_interval`)
 *   double2  input tokens (Jev; 0 otherwise or when not reported)
 *   double3  output tokens (Jev; 0 otherwise or when not reported)
 *   double4  latency in milliseconds
 *
 * Only ids, enums and numbers cross this boundary: never prompts, message
 * text, mail, addresses, provider responses or credentials. Writing is
 * synchronous and buffered by the runtime: no await, no database round trip.
 * A missing binding or a failed write changes nothing for the call.
 */
export const USAGE_COST_LAYOUT = "usage_cost_v1";

export type UsageCostEnv = Pick<Env, "XMATRIX_USAGE_COST_AE" | "CF_VERSION_METADATA">;

/** Whose cost a call is: its Space, or its owner when it has none. */
export type UsageScope = { spaceId: string } | { ownerUserId: string };

/** What a Jev call was for. */
export type JevFeature = "summon_intent" | "launch_choice" | "input_launch" | "start_intent" | "supersession"
  | "page_attachment" | "evaluate";

export type UpstreamSource = "composio" | "x";

/**
 * Runs one upstream call the operator pays for and records it, bound to one
 * Space, connector and action. The call's result or error is unchanged.
 */
export interface UpstreamCallPrice { kind: PaidCallKind; maximumUnits: number }
export type UpstreamMeter = <T>(source: UpstreamSource, operation: string, call: () => Promise<T>,
  price?: UpstreamCallPrice) => Promise<T>;

type Outcome = "ok" | "error" | "timeout";

const ID = /^[A-Za-z0-9_.:@-]{1,96}$/u;
const LABEL = /^[a-z][a-z0-9_.:/-]{0,63}$/u;
const JEV_CODES = new Set(["jev_aborted", "jev_invalid_input", "jev_customer_verification_required",
  "jev_auth_failed", "jev_permission_denied", "jev_rate_limited", "jev_evaluation_failed"]);

const label = (value: string) => LABEL.test(value) ? value : "other";
const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;

function write(env: UsageCostEnv | undefined, scope: UsageScope, point: {
  source: "jev" | UpstreamSource; feature: string; action: string; operation: string; outcome: Outcome;
  code: string; inputTokens?: number; outputTokens?: number; latencyMs: number;
}): void {
  const dataset = env?.XMATRIX_USAGE_COST_AE;
  if (!dataset) return;
  const id = "spaceId" in scope ? scope.spaceId : scope.ownerUserId;
  try {
    dataset.writeDataPoint({
      indexes: [ID.test(id) ? id : "invalid"],
      blobs: [USAGE_COST_LAYOUT, point.source, "spaceId" in scope ? "space" : "user", label(point.feature),
        label(point.action), label(point.operation), point.outcome, label(point.code),
        env.CF_VERSION_METADATA?.id?.trim().slice(0, 40) || "unknown"],
      doubles: [1, count(point.inputTokens), count(point.outputTokens), Math.max(0, Math.round(point.latencyMs))],
    });
  } catch {
    // Metering is derived evidence; it never fails the call it describes.
  }
}

type Evaluate<I, R> = (input: I, options?: { signal?: AbortSignal }) => Promise<R>;

/** One datapoint per Jev call: its tokens when it answers, its failure code when not. */
export function meterJev<I, R>(env: UsageCostEnv | undefined, usage: { feature: JevFeature; scope: UsageScope },
  evaluate: Evaluate<I, R>): Evaluate<I, R> {
  return async (input, options) => {
    const started = Date.now();
    try {
      const result = await evaluate(input, options);
      const answered = result as { model?: unknown; usage?: { inputTokens?: unknown; outputTokens?: unknown } };
      write(env, usage.scope, { source: "jev", feature: usage.feature, action: "none",
        operation: typeof answered?.model === "string" ? answered.model : "unknown", outcome: "ok", code: "none",
        inputTokens: count(answered?.usage?.inputTokens), outputTokens: count(answered?.usage?.outputTokens),
        latencyMs: Date.now() - started });
      return result;
    } catch (error) {
      const raw = (error as { code?: unknown } | null)?.code;
      const code = typeof raw === "string" && JEV_CODES.has(raw) ? raw : "jev_evaluation_failed";
      write(env, usage.scope, { source: "jev", feature: usage.feature, action: "none", operation: "unknown",
        outcome: code === "jev_aborted" ? "timeout" : "error", code, latencyMs: Date.now() - started });
      throw error;
    }
  };
}

function upstreamFailure(error: unknown): { outcome: Outcome; code: string } {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { outcome: "timeout", code: "timeout" };
  }
  const status = (error as { status?: unknown } | null)?.status;
  return Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599
    ? { outcome: "error", code: `http_${status}` } : { outcome: "error", code: "network" };
}

/** A meter for the upstream calls one connector action or lifecycle step makes in a Space. */
export function upstreamMeter(env: UsageCostEnv | undefined,
  usage: { spaceId: string; connector: string; action: string }): UpstreamMeter {
  return async (source, operation, call) => {
    const started = Date.now();
    const point = { source, feature: usage.connector, action: usage.action, operation };
    try {
      const result = await call();
      write(env, { spaceId: usage.spaceId }, { ...point, outcome: "ok", code: "none", latencyMs: Date.now() - started });
      return result;
    } catch (error) {
      write(env, { spaceId: usage.spaceId }, { ...point, ...upstreamFailure(error), latencyMs: Date.now() - started });
      throw error;
    }
  };
}

/** Runs `call` through `meter` when the caller has one. */
export function metered<T>(meter: UpstreamMeter | undefined, source: UpstreamSource, operation: string,
  call: () => Promise<T>, price?: UpstreamCallPrice): Promise<T> {
  return meter ? meter(source, operation, call, price) : call();
}
