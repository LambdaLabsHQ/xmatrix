import type { ObservabilityEvent } from "@xmatrix/protocol";

export const AGENT_TRACE_ON_DEMAND_LIMIT = 500;
export const AGENT_TRACE_ON_DEMAND_MAX_INSTANCES = 16;
export const AGENT_TRACE_ON_DEMAND_CONCURRENCY = 4;
export const AGENT_TRACE_ON_DEMAND_TIMEOUT_MS = 10_000;
/** Refresh only while the corresponding trace detail remains open. */
export const AGENT_TRACE_LIVE_SYNC_INTERVAL_MS = 1_000;
const AGENT_TRACE_LIVE_SYNC_MAX_BACKOFF_MS = 30_000;
const AGENT_TRACE_LIVE_SYNC_HIDDEN_MS = 15_000;

/**
 * The next live read's delay. A failing read backs off (offline, or the Hub
 * redeploying) instead of asking every second, and a hidden tab asks rarely.
 */
export function liveSyncDelayMs(input: {
  held: boolean;
  failed: boolean;
  refreshIntervalMs: number;
  failures: Map<string, number>;
  instanceId: string;
  hidden: boolean;
}): number {
  const failures = input.failed ? (input.failures.get(input.instanceId) ?? 0) + 1 : 0;
  input.failures.set(input.instanceId, failures);
  const delay = failures > 0
    ? Math.min(AGENT_TRACE_LIVE_SYNC_MAX_BACKOFF_MS, input.refreshIntervalMs * 2 ** failures)
    : input.held ? 0 : input.refreshIntervalMs;
  return input.hidden ? Math.max(delay, AGENT_TRACE_LIVE_SYNC_HIDDEN_MS) : delay;
}
/** Matches the Agent host's retention, so loaded earlier pages are kept. */
export const AGENT_TRACE_REPLICA_MAX_EVENTS = 5_000;
/** A live delta larger than one page follows its cursor at most this far. */
export const AGENT_TRACE_DELTA_MAX_PAGES = 10;
/**
 * A live delta asks the Agent host to hold the read until a newer event lands
 * (long-poll), so steps arrive as they happen instead of on a timer. A host
 * that cannot wait answers at once and the sync falls back to its interval.
 */
export const AGENT_TRACE_LIVE_WAIT_MS = 25_000;
/** The first read asks for a short head page so the newest steps paint fast. */
export const AGENT_TRACE_HEAD_PAGE_LIMIT = 100;
/**
 * How long an authorized trace stays on screen while later reads fail for a
 * reason other than authorization. Past this bound it is cleared as before.
 */
export const AGENT_TRACE_STALE_GRACE_MS = 30_000;

type AgentTraceWireAvailability = "available" | "unavailable" | "expired";

export type AgentTraceHistoryReadState = {
  instanceId: string;
  phase: "loading" | AgentTraceWireAvailability | "error";
  complete: boolean;
  eventCount: number;
  reason?: string;
  /**
   * Cursor for the page before the oldest loaded event; null once the oldest
   * retained event is loaded. Absent on a delta read, which never moves it.
   */
  nextCursor?: string | null;
  /** Epoch ms of the first failed read since the last authorized one. */
  staleSince?: number;
};

/** Outcome of one "load earlier" read; failures never clear loaded history. */
export type AgentTraceOlderPageResult =
  | { phase: "available"; nextCursor: string | null; complete: boolean; eventCount: number }
  | { phase: "unavailable" | "expired" | "error"; reason?: string };

export type AgentTraceHistoryRequestPlan = {
  instanceIds: string[];
  omittedCount: number;
};

export type AgentTraceHistoryBootstrap = {
  plan: AgentTraceHistoryRequestPlan;
  done: Promise<void>;
  cancel: () => void;
};

export type AgentTraceHistorySync = {
  plan: AgentTraceHistoryRequestPlan;
  firstDone: Promise<void>;
  /** Read the page before `before` for one instance; overlapping calls join. */
  loadOlder: (instanceId: string, before: string) => Promise<AgentTraceOlderPageResult>;
  cancel: () => void;
};

export type AgentTraceHistoryFetch = (
  instanceId: string,
  options: { limit: number; signal: AbortSignal; since?: string; before?: string; waitMs?: number }
) => Promise<Response>;

export type AgentTraceHistoryWireResponse = {
  availability: AgentTraceWireAvailability;
  complete: boolean;
  events: ObservabilityEvent[];
  reason?: string;
  /** Legacy field, always null. */
  cursor: null;
  /** Older page cursor; a Hub that predates paging sends none (read as null). */
  nextCursor: string | null;
};

export type AgentTraceHistoryMergedResponse = {
  complete: boolean;
  events: ObservabilityEvent[];
};

export function planAgentTraceHistoryRequests(
  candidates: readonly string[],
  maxInstances = AGENT_TRACE_ON_DEMAND_MAX_INSTANCES
): AgentTraceHistoryRequestPlan {
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 1) {
    throw new TypeError("Agent trace instance request bound is invalid");
  }
  const unique = Array.from(new Set(candidates.filter(isExactInstanceId)));
  return {
    instanceIds: unique.slice(0, maxInstances),
    omittedCount: Math.max(0, unique.length - maxInstances),
  };
}

export function parseAgentTraceHistoryResponse(
  candidate: unknown,
  expectedInstanceId: string,
  limit = AGENT_TRACE_ON_DEMAND_LIMIT
): AgentTraceHistoryWireResponse {
  if (!isExactInstanceId(expectedInstanceId)) {
    throw new TypeError("Agent trace instance id is invalid");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_TRACE_ON_DEMAND_LIMIT) {
    throw new TypeError("Agent trace event limit is invalid");
  }
  const record = plainRecord(candidate);
  if (!record) throw new TypeError("Agent host trace response is invalid");
  const availability = record.availability;
  if (
    availability !== "available" &&
    availability !== "unavailable" &&
    availability !== "expired"
  ) {
    throw new TypeError("Agent host trace availability is invalid");
  }
  if (typeof record.complete !== "boolean" || record.cursor !== null || !Array.isArray(record.events)) {
    throw new TypeError("Agent host trace response is incomplete");
  }
  const reason = boundedReason(record.reason);
  if (record.reason !== undefined && reason === undefined) {
    throw new TypeError("Agent host trace reason is invalid");
  }
  const nextCursor = record.nextCursor ?? null;
  if (nextCursor !== null && (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 240)) {
    throw new TypeError("Agent host trace cursor is invalid");
  }
  if (availability !== "available") {
    if (record.complete || record.events.length !== 0) {
      throw new TypeError("Unavailable Agent host trace cannot claim retained history");
    }
    return {
      availability,
      complete: false,
      events: [],
      ...(reason ? { reason } : {}),
      cursor: null,
      nextCursor: null,
    };
  }
  if (record.events.length > limit) {
    throw new TypeError("Agent host trace response exceeds the requested bound");
  }
  const eventIds = new Set<string>();
  const events: ObservabilityEvent[] = [];
  for (const event of record.events) {
    if (!isExactAgentTraceEvent(event, expectedInstanceId) || eventIds.has(event.id)) {
      throw new TypeError("Agent host trace response contains an invalid event");
    }
    eventIds.add(event.id);
    events.push(event);
  }
  return {
    availability,
    complete: record.complete && nextCursor === null,
    events,
    ...(reason ? { reason } : {}),
    cursor: null,
    nextCursor,
  };
}

export function mergeTraceInstanceHistoryResponses(
  requestedInstanceIds: readonly string[],
  responses: readonly { instanceId: string; response: AgentTraceHistoryWireResponse }[]
): AgentTraceHistoryMergedResponse {
  const requested = Array.from(new Set(requestedInstanceIds.filter(isExactInstanceId)));
  const byInstance = new Map<string, AgentTraceHistoryWireResponse>();
  let duplicateResponse = false;
  for (const item of responses) {
    if (!requested.includes(item.instanceId)) continue;
    if (byInstance.has(item.instanceId)) duplicateResponse = true;
    byInstance.set(item.instanceId, item.response);
  }
  const eventsById = new Map<string, ObservabilityEvent>();
  for (const instanceId of requested) {
    const response = byInstance.get(instanceId);
    if (response?.availability !== "available") continue;
    for (const event of response.events) {
      if (!eventsById.has(event.id)) eventsById.set(event.id, event);
    }
  }
  return {
    complete: Boolean(
      requested.length > 0 &&
        !duplicateResponse &&
        byInstance.size === requested.length &&
        requested.every((instanceId) => {
          const response = byInstance.get(instanceId);
          return response?.availability === "available" && response.complete;
        })
    ),
    events: Array.from(eventsById.values()),
  };
}

type AgentTraceHistoryPageRead =
  | { ok: true; response: AgentTraceHistoryWireResponse }
  | { ok: false; reason: string };

/** One bounded page. Throws only on transport or parse failure. */
async function readAgentTraceHistoryPage(
  fetchHistory: AgentTraceHistoryFetch,
  instanceId: string,
  options: { limit: number; signal: AbortSignal; since?: string; before?: string },
): Promise<AgentTraceHistoryPageRead> {
  const response = await fetchHistory(instanceId, options);
  if (!response.ok) return { ok: false, reason: await boundedHttpFailureCode(response) };
  return {
    ok: true,
    response: parseAgentTraceHistoryResponse(await response.json(), instanceId, options.limit),
  };
}

export type AgentTraceHistoryBootstrapInput = {
  instanceIds: readonly string[];
  fetchHistory: AgentTraceHistoryFetch;
  onState: (state: AgentTraceHistoryReadState) => void;
  onEvents: (instanceId: string, events: ObservabilityEvent[]) => void;
  onComplete?: (result: AgentTraceHistoryMergedResponse) => void;
  limit?: number;
  /** Page size of a head read (no `since`); defaults to `limit`. */
  headLimit?: number;
  /** A `since` read may wait this long on the host for a newer event. */
  waitMs?: number;
  maxInstances?: number;
  concurrency?: number;
  timeoutMs?: number;
  /** Per-instance inclusive watermarks for a delta read. */
  sinceByInstance?: ReadonlyMap<string, string>;
  /** The first complete read reports loading; incremental refreshes do not. */
  reportLoading?: boolean;
};

export function startAgentTraceHistoryBootstrap(
  input: AgentTraceHistoryBootstrapInput,
): AgentTraceHistoryBootstrap {
  const limit = input.limit ?? AGENT_TRACE_ON_DEMAND_LIMIT;
  const headLimit = input.headLimit ?? limit;
  const waitMs = input.waitMs ?? 0;
  const concurrency = input.concurrency ?? AGENT_TRACE_ON_DEMAND_CONCURRENCY;
  const timeoutMs = input.timeoutMs ?? AGENT_TRACE_ON_DEMAND_TIMEOUT_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > AGENT_TRACE_ON_DEMAND_LIMIT ||
      !Number.isSafeInteger(headLimit) || headLimit < 1 || headLimit > limit) {
    throw new TypeError("Agent trace event limit is invalid");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new TypeError("Agent trace request concurrency is invalid");
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError("Agent trace request timeout is invalid");
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > AGENT_TRACE_LIVE_WAIT_MS) {
    throw new TypeError("Agent trace wait is invalid");
  }

  const plan = planAgentTraceHistoryRequests(
    input.instanceIds,
    input.maxInstances ?? AGENT_TRACE_ON_DEMAND_MAX_INSTANCES
  );
  let active = true;
  let nextIndex = 0;
  const controllers = new Set<AbortController>();
  const responses = new Map<string, AgentTraceHistoryWireResponse>();

  if (input.reportLoading !== false) {
    for (const instanceId of plan.instanceIds) {
      input.onState({ instanceId, phase: "loading", complete: false, eventCount: 0 });
    }
  }

  async function requestOne(instanceId: string): Promise<void> {
    const controller = new AbortController();
    controllers.add(controller);
    let timedOut = false;
    const since = input.sinceByInstance?.get(instanceId);
    const wait = since ? waitMs : 0;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs + wait);
    try {
      const read = (before?: string) => readAgentTraceHistoryPage(input.fetchHistory, instanceId, {
        limit: since ? limit : headLimit,
        signal: controller.signal,
        ...(since ? { since } : {}),
        ...(before ? { before } : {}),
      });
      // Only the live delta waits; the pages that fill a gap below it do not.
      let page = await readAgentTraceHistoryPage(input.fetchHistory, instanceId, {
        limit: since ? limit : headLimit,
        signal: controller.signal,
        ...(since ? { since } : {}),
        ...(wait ? { waitMs: wait } : {}),
      });
      if (!active) return;
      if (!page.ok) {
        input.onState({ instanceId, phase: "error", complete: false, eventCount: 0, reason: page.reason });
        return;
      }
      const payload = page.response;
      responses.set(instanceId, payload);
      if (payload.availability === "available" && payload.events.length > 0) {
        input.onEvents(instanceId, payload.events);
      }
      let eventCount = payload.events.length;
      let complete = payload.complete;
      // A delta larger than one page must not leave a hole between the new
      // head and what is already shown: follow its cursor down to `since`.
      let gapCursor = since ? payload.nextCursor : null;
      for (let pages = 1; gapCursor && pages < AGENT_TRACE_DELTA_MAX_PAGES; pages += 1) {
        page = await read(gapCursor);
        if (!active) return;
        if (!page.ok) {
          input.onState({ instanceId, phase: "error", complete: false, eventCount: 0, reason: page.reason });
          return;
        }
        if (page.response.availability !== "available") break;
        if (page.response.events.length > 0) input.onEvents(instanceId, page.response.events);
        eventCount += page.response.events.length;
        gapCursor = page.response.nextCursor;
        complete = complete && page.response.complete;
      }
      input.onState({
        instanceId,
        phase: payload.availability,
        complete: complete && !gapCursor,
        eventCount,
        ...(payload.reason ? { reason: payload.reason } : {}),
        ...(since || payload.availability !== "available" ? {} : { nextCursor: payload.nextCursor }),
      });
    } catch {
      if (!active) return;
      input.onState({
        instanceId,
        phase: timedOut ? "unavailable" : "error",
        complete: false,
        eventCount: 0,
        reason: timedOut ? "request_timeout" : "request_failed",
      });
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  }

  async function worker(): Promise<void> {
    while (active) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= plan.instanceIds.length) return;
      await requestOne(plan.instanceIds[index]!);
    }
  }

  const done = Promise.all(
    Array.from(
      { length: Math.min(concurrency, plan.instanceIds.length) },
      () => worker()
    )
  ).then(() => {
    if (!active) return;
    const merged = mergeTraceInstanceHistoryResponses(
      plan.instanceIds,
      Array.from(responses, ([instanceId, response]) => ({ instanceId, response }))
    );
    input.onComplete?.({
      ...merged,
      complete: plan.omittedCount === 0 && merged.complete,
    });
  });

  return {
    plan,
    done,
    cancel() {
      if (!active) return;
      active = false;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    },
  };
}

/**
 * Pull retained trace history only while its detail is open. Reads never
 * overlap: a next delta starts after the previous exact-host request settles.
 */
export function startAgentTraceHistorySync(
  input: AgentTraceHistoryBootstrapInput & { refreshIntervalMs?: number },
): AgentTraceHistorySync {
  const refreshIntervalMs = input.refreshIntervalMs ?? AGENT_TRACE_LIVE_SYNC_INTERVAL_MS;
  if (!Number.isSafeInteger(refreshIntervalMs) || refreshIntervalMs < 250 || refreshIntervalMs > 60_000) {
    throw new TypeError("Agent trace refresh interval is invalid");
  }
  const plan = planAgentTraceHistoryRequests(
    input.instanceIds,
    input.maxInstances ?? AGENT_TRACE_ON_DEMAND_MAX_INSTANCES,
  );
  if (plan.instanceIds.length === 0) {
    return {
      plan,
      firstDone: Promise.resolve(),
      loadOlder: () => Promise.resolve({ phase: "error", reason: "trace_detail_closed" }),
      cancel() {},
    };
  }

  let active = true;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const bootstraps = new Map<string, AgentTraceHistoryBootstrap>();
  const sinceByInstance = new Map<string, string>();
  let resolveFirstRead!: () => void;
  const firstDone = new Promise<void>((resolve) => {
    resolveFirstRead = resolve;
  });

  const trackSince = {
    onState: (state: AgentTraceHistoryReadState) => {
      // Replicas are purged on a failed read, so the next read must rebuild
      // the head page (and its older cursor) instead of a delta over a hole.
      if (state.phase !== "loading" && state.phase !== "available") {
        sinceByInstance.delete(state.instanceId);
      }
      input.onState(state);
    },
    onEvents: (instanceId: string, events: ObservabilityEvent[]) => {
      const newest = newestTraceTimestamp(events);
      if (newest) sinceByInstance.set(instanceId, newest);
      input.onEvents(instanceId, events);
    },
  };

  const failures = new Map<string, number>();
  const schedule = (instanceId: string, delayMs: number) => {
    if (!active) return;
    timers.set(instanceId, setTimeout(() => follow(instanceId), delayMs));
  };

  // Each instance follows its own live reads, so one host holding a read open
  // never delays another's steps.
  const follow = (instanceId: string) => {
    if (!active) return;
    const waitMs = sinceByInstance.has(instanceId) ? input.waitMs ?? 0 : 0;
    const startedAt = Date.now();
    let received = false;
    let failed = false;
    const current = startAgentTraceHistoryBootstrap({
      ...input,
      instanceIds: [instanceId],
      maxInstances: 1,
      sinceByInstance,
      waitMs,
      reportLoading: false,
      onState: (state) => {
        if (state.phase === "error") failed = true;
        trackSince.onState(state);
      },
      onEvents: (id, events) => {
        received = true;
        trackSince.onEvents(id, events);
      },
      onComplete: undefined,
    });
    bootstraps.set(instanceId, current);
    const next = () => {
      if (!active || bootstraps.get(instanceId) !== current) return;
      // A host that held the read answered on news or at its deadline: ask
      // again at once. One that answered an empty read early cannot wait.
      const held = waitMs > 0 && (received || Date.now() - startedAt >= waitMs / 2);
      schedule(instanceId, liveSyncDelayMs({
        held, failed, refreshIntervalMs, failures, instanceId,
        hidden: typeof document !== "undefined" && document.hidden,
      }));
    };
    void current.done.then(next, next);
  };

  const refresh = () => {
    const first = startAgentTraceHistoryBootstrap({
      ...input,
      instanceIds: plan.instanceIds,
      maxInstances: plan.instanceIds.length,
      sinceByInstance,
      waitMs: 0,
      reportLoading: true,
      ...trackSince,
      onComplete: (result) => input.onComplete?.({
        ...result,
        complete: plan.omittedCount === 0 && result.complete,
      }),
    });
    for (const instanceId of plan.instanceIds) bootstraps.set(instanceId, first);
    const finish = () => {
      resolveFirstRead();
      for (const instanceId of plan.instanceIds) {
        if (bootstraps.get(instanceId) === first) schedule(instanceId, input.waitMs ? 0 : refreshIntervalMs);
      }
    };
    void first.done.then(finish, finish);
  };

  const olderReads = new Map<string, Promise<AgentTraceOlderPageResult>>();
  const olderControllers = new Set<AbortController>();
  const loadOlder = (instanceId: string, before: string): Promise<AgentTraceOlderPageResult> => {
    const key = `${instanceId}\n${before}`;
    const pending = olderReads.get(key);
    if (pending) return pending;
    if (!active || !plan.instanceIds.includes(instanceId)) {
      return Promise.resolve({ phase: "error", reason: "trace_detail_closed" });
    }
    const controller = new AbortController();
    olderControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? AGENT_TRACE_ON_DEMAND_TIMEOUT_MS);
    const read = (async (): Promise<AgentTraceOlderPageResult> => {
      try {
        const page = await readAgentTraceHistoryPage(input.fetchHistory, instanceId, {
          limit: input.limit ?? AGENT_TRACE_ON_DEMAND_LIMIT,
          signal: controller.signal,
          before,
        });
        if (!page.ok) return { phase: "error", reason: page.reason };
        const { response } = page;
        if (response.availability !== "available") {
          return { phase: response.availability, ...(response.reason ? { reason: response.reason } : {}) };
        }
        // A Hub or host that cannot page answers with a reason and no events.
        if (response.reason) return { phase: "error", reason: response.reason };
        if (active && response.events.length > 0) input.onEvents(instanceId, response.events);
        return {
          phase: "available",
          nextCursor: response.nextCursor,
          complete: response.complete,
          eventCount: response.events.length,
        };
      } catch {
        return { phase: "error", reason: controller.signal.aborted ? "request_timeout" : "request_failed" };
      } finally {
        clearTimeout(timeout);
        olderControllers.delete(controller);
        olderReads.delete(key);
      }
    })();
    olderReads.set(key, read);
    return read;
  };

  refresh();
  return {
    plan,
    firstDone,
    loadOlder,
    cancel() {
      if (!active) return;
      active = false;
      for (const timer of timers.values()) clearTimeout(timer);
      for (const bootstrap of new Set(bootstraps.values())) bootstrap.cancel();
      for (const controller of olderControllers) controller.abort();
      olderControllers.clear();
      resolveFirstRead();
    },
  };
}

export function agentTraceHistoryStatusCopy(
  state: AgentTraceHistoryReadState
): { title: string; detail: string } | null {
  // The timeline shows its own skeleton while the first page loads, and its
  // own reconnecting line while a stale page stays on screen.
  if (state.phase === "loading" || state.staleSince !== undefined) return null;
  if (state.phase === "available" && state.complete) return null;
  // Earlier pages are one "Load earlier" away; that is not a gap to report.
  if (state.phase === "available" && typeof state.nextCursor === "string") return null;
  if (state.phase === "available") {
    return {
      title: "Only recent trace history is available",
      detail: "The Agent host has no earlier page: older steps fell outside its retention window, or the host predates trace paging (update it with xmatrix update). Live sync continues while this detail stays open.",
    };
  }
  if (state.phase === "expired") {
    return {
      title: "Local trace retention expired",
      detail: "This instance no longer retains the requested history. Hub and R2 do not keep a fallback trace copy.",
    };
  }
  if (state.phase === "unavailable" && state.reason?.includes("timeout")) {
    return {
      title: "Agent host timed out",
      detail: "The exact Agent host did not answer the latest live-sync request. Sync retries while this detail stays open; Hub and R2 provide no fallback history.",
    };
  }
  if (state.phase === "unavailable" && state.reason === "host_overloaded") {
    return {
      title: "Agent host is busy",
      detail: "Too many trace reads are open for this instance right now. Sync retries while this detail stays open; Hub and R2 provide no fallback history.",
    };
  }
  // Only a Hub that holds no connection for the instance knows its host is
  // offline; any other unavailable answer comes from a host that is connected.
  if (state.phase === "unavailable" && state.reason === "host_offline") {
    return {
      title: "Agent host is offline",
      detail: "Local trace history is unavailable until the exact Agent host can answer. Sync retries while this detail stays open; Hub and R2 provide no fallback history.",
    };
  }
  if (state.phase === "unavailable") {
    return {
      title: "Agent host could not read its trace",
      detail: "The Agent host is connected but did not return this instance's trace history. Sync retries while this detail stays open; Hub and R2 provide no fallback history.",
    };
  }
  if (state.phase === "error" &&
      (state.reason === "trace_access_denied" || state.reason === "http_403")) {
    return {
      title: "You cannot view this trace",
      detail: "A trace is visible to the Agent's owner and to people who can read its Channel in the owner's Space. Previously loaded history for this instance was cleared.",
    };
  }
  if (state.phase === "error" && state.reason === "http_401") {
    return {
      title: "Your session expired",
      detail: "Sign in again to reload this trace. Previously loaded history for this instance was cleared.",
    };
  }
  return {
    title: "Agent host trace request failed",
    detail: "No history was accepted. Live sync will retry while this detail stays open.",
  };
}

const AGENT_TRACE_AUTHORIZATION_FAILURES = new Set(["trace_access_denied", "http_401", "http_403"]);

/**
 * A read that fails after an authorized one keeps that history on screen as
 * stale, instead of clearing it for the second or two until the next read
 * succeeds. Only a transient failure qualifies: an authorization failure or an
 * ended Run still clears it, and so does a failure lasting past the grace.
 * Returns the state to show, or null to apply `next` as it is.
 */
export function holdAgentTraceReadThroughFailure(
  previous: AgentTraceHistoryReadState | undefined,
  next: AgentTraceHistoryReadState,
  now: number,
  graceMs = AGENT_TRACE_STALE_GRACE_MS,
): AgentTraceHistoryReadState | null {
  if (previous?.phase !== "available") return null;
  const transient = next.phase === "unavailable" ||
    (next.phase === "error" && !AGENT_TRACE_AUTHORIZATION_FAILURES.has(next.reason ?? ""));
  if (!transient) return null;
  const staleSince = previous.staleSince ?? now;
  if (now - staleSince >= graceMs) return null;
  return {
    instanceId: next.instanceId,
    phase: "available",
    complete: previous.complete,
    eventCount: 0,
    ...(next.reason ? { reason: next.reason } : {}),
    staleSince,
  };
}

export function agentTraceOlderPageErrorCopy(
  result: Exclude<AgentTraceOlderPageResult, { phase: "available" }>,
): string {
  if (result.reason === "host_paging_unsupported") {
    return "This Agent host predates trace paging. Update it with xmatrix update to load earlier steps.";
  }
  if (result.reason === "trace_access_denied" || result.reason === "http_403") {
    return "You can no longer view this trace.";
  }
  if (result.phase === "expired") return "This instance no longer retains its trace history.";
  if (result.phase === "unavailable" || result.reason?.includes("timeout")) {
    return "The Agent host did not answer. Try again.";
  }
  return "Earlier trace could not be loaded. Try again.";
}

function newestTraceTimestamp(events: readonly ObservabilityEvent[]): string | undefined {
  let newest: { timestamp: string; milliseconds: number } | undefined;
  for (const event of events) {
    const milliseconds = Date.parse(event.timestamp);
    if (!Number.isFinite(milliseconds) ||
        !newest || milliseconds > newest.milliseconds ||
        (milliseconds === newest.milliseconds && event.timestamp > newest.timestamp)) {
      newest = { timestamp: event.timestamp, milliseconds };
    }
  }
  return newest?.timestamp;
}

function isExactAgentTraceEvent(candidate: unknown, expectedInstanceId: string): candidate is ObservabilityEvent {
  const event = plainRecord(candidate);
  const metadata = plainRecord(event?.metadata);
  const payload = plainRecord(metadata?.payload);
  const agent = plainRecord(payload?.agent);
  const channelId = nonEmptyString(event?.channelId) ?? nonEmptyString(payload?.channelId);
  const agentId =
    nonEmptyString(event?.agentId) ??
    nonEmptyString(event?.targetAgentId) ??
    nonEmptyString(agent?.id);
  return Boolean(
    event &&
      nonEmptyString(event.id) &&
      event.type === "event_published" &&
      channelId &&
      agentId &&
      metadata?.eventType === "llm_trace" &&
      agent?.instanceId === expectedInstanceId &&
      typeof event.timestamp === "string" &&
      event.timestamp.length <= 64 &&
      Number.isFinite(Date.parse(event.timestamp))
  );
}

async function boundedHttpFailureCode(response: Response): Promise<string> {
  const payload = await response.clone().json().catch(() => null);
  const code = nonEmptyString(plainRecord(payload)?.code);
  return code && code.length <= 120 ? code : `http_${response.status}`;
}

function isExactInstanceId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 160;
}

function boundedReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const reason = nonEmptyString(value);
  return reason && reason.length <= 160 ? reason : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
