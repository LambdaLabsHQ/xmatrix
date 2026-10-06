"use client";

import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import {
  useCallback,
  useEffect,
  useMemo,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import {
  AGENT_TRACE_HEAD_PAGE_LIMIT,
  AGENT_TRACE_LIVE_WAIT_MS,
  AGENT_TRACE_REPLICA_MAX_EVENTS,
  agentTraceOlderPageErrorCopy,
  holdAgentTraceReadThroughFailure,
  planAgentTraceHistoryRequests,
  startAgentTraceHistorySync,
  type AgentTraceHistoryReadState,
  type AgentTraceHistorySync,
} from "./agent-trace-on-demand";
import {
  mergeAgentTraceReplicas,
  purgeAgentTraceReplicas,
  type AgentTraceReplica,
} from "./agent-trace-replica";
import { agentTraceExactInstanceIds } from "./agent-trace-target";
import {
  agentTraceTargetRequestKey,
  type AgentTraceHistoryPanelState,
  type AgentTraceTarget,
} from "./workspace-composer-dialogs";

type UseAgentTraceHistorySyncInput = {
  target: AgentTraceTarget | null;
  token: string | undefined;
  revision: number;
  cancel: () => void;
  syncRef: MutableRefObject<AgentTraceHistorySync | null>;
  setReplicas: Dispatch<SetStateAction<AgentTraceReplica[]>>;
  setPanelState: Dispatch<SetStateAction<AgentTraceHistoryPanelState | null>>;
};

/**
 * While a trace detail panel is open, hydrate the newest page of its
 * authorized host history and then serially fetch deltas; `loadOlder` pages
 * further back on request. The sync has no websocket fallback: the Agent
 * remains the trace authority, and closing the detail panel cancels the read.
 */
export function useAgentTraceHistorySync({
  target,
  token,
  revision,
  cancel,
  syncRef,
  setReplicas,
  setPanelState,
}: UseAgentTraceHistorySyncInput): {
  targetKey: string;
  loadOlder: (state: AgentTraceHistoryPanelState | null) => void;
} {
  const { user } = useAuth();
  const fetch = useXMatrixQueryFetch(user?.id);
  const targetKey = useMemo(
    () => target ? agentTraceTargetRequestKey(target) : "",
    [target]
  );

  useEffect(() => {
    cancel();
    if (!target || !token) {
      setPanelState(null);
      return undefined;
    }

    const exactInstanceIds = agentTraceExactInstanceIds(target);
    const plan = planAgentTraceHistoryRequests(exactInstanceIds);
    if (plan.instanceIds.length === 0) {
      setPanelState({
        targetKey,
        reads: [],
        complete: false,
        omittedCount: 0,
        missingExactInstance: true,
      });
      return undefined;
    }

    // A retained replica is only a cache of the last authorized host response.
    // Hide it before every reauthorization read.
    setReplicas((current) => purgeAgentTraceReplicas(current, {
      instanceIds: plan.instanceIds,
    }));
    setPanelState({
      targetKey,
      reads: plan.instanceIds.map((instanceId) => ({
        instanceId,
        phase: "loading",
        complete: false,
        eventCount: 0,
      })),
      complete: false,
      omittedCount: plan.omittedCount,
      missingExactInstance: false,
    });

    const lastReads = new Map<string, AgentTraceHistoryReadState>();
    const traceSync = startAgentTraceHistorySync({
      instanceIds: exactInstanceIds,
      headLimit: AGENT_TRACE_HEAD_PAGE_LIMIT,
      waitMs: AGENT_TRACE_LIVE_WAIT_MS,
      fetchHistory: (instanceId, options) => {
        const params = new URLSearchParams({ limit: String(options.limit) });
        if (options.since) params.set("since", options.since);
        if (options.before) params.set("before", options.before);
        if (options.waitMs) params.set("waitMs", String(options.waitMs));
        return fetch(`${WEB_PROXY_ROUTES.trace_instance_events(instanceId)}?${params.toString()}`, {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
          signal: options.signal,
        });
      },
      onEvents: (_instanceId, nextEvents) => {
        setReplicas((current) => mergeAgentTraceReplicas(current, nextEvents, {
          maxEventsPerReplica: AGENT_TRACE_REPLICA_MAX_EVENTS,
          source: "history",
        }));
      },
      onState: (reported) => {
        const held = holdAgentTraceReadThroughFailure(
          lastReads.get(reported.instanceId), reported, Date.now());
        const nextState = held ?? reported;
        lastReads.set(nextState.instanceId, nextState);
        if (
          nextState.phase === "unavailable" ||
          nextState.phase === "expired" ||
          nextState.phase === "error"
        ) {
          setReplicas((current) => purgeAgentTraceReplicas(current, {
            instanceIds: [nextState.instanceId],
          }));
        }
        setPanelState((current) => {
          if (!current || current.targetKey !== targetKey) return current;
          const reads = current.reads.some((state) => state.instanceId === nextState.instanceId)
            ? current.reads.map((state) => {
                if (state.instanceId !== nextState.instanceId) return state;
                // A delta never moves the older-page cursor; keep it.
                const merged = nextState.nextCursor === undefined && nextState.phase === "available"
                  ? { ...nextState, nextCursor: state.nextCursor }
                  : nextState;
                // A delta response cannot repair known incomplete history.
                // Only a full reload or the oldest page may establish completeness.
                return state.phase === "available" && !state.complete &&
                    nextState.phase === "available"
                  ? { ...merged, complete: false }
                  : merged;
              })
            : [...current.reads, nextState];
          return { ...current, reads };
        });
      },
      onComplete: (result) => {
        setPanelState((current) =>
          current?.targetKey === targetKey
            ? { ...current, complete: result.complete }
            : current
        );
      },
    });
    syncRef.current = traceSync;
    void traceSync.firstDone;
    return () => {
      traceSync.cancel();
      if (syncRef.current === traceSync) syncRef.current = null;
    };
  }, [cancel, fetch, revision, setPanelState, setReplicas, syncRef, target, targetKey, token]);

  const loadOlder = useCallback((state: AgentTraceHistoryPanelState | null) => {
    const sync = syncRef.current;
    if (!sync || !state || state.targetKey !== targetKey || state.older?.loading) return;
    const pending = state.reads.flatMap((read) =>
      read.phase === "available" && typeof read.nextCursor === "string"
        ? [{ instanceId: read.instanceId, before: read.nextCursor }]
        : []);
    if (pending.length === 0) return;
    setPanelState((current) => current?.targetKey === targetKey
      ? { ...current, older: { loading: true } }
      : current);
    void Promise.all(pending.map(async ({ instanceId, before }) =>
      ({ instanceId, before, result: await sync.loadOlder(instanceId, before) }))).then((outcomes) => {
      setPanelState((current) => {
        if (!current || current.targetKey !== targetKey) return current;
        const failure = outcomes.find(({ result }) => result.phase !== "available");
        const reads = current.reads.map((read) => {
          const outcome = outcomes.find((item) => item.instanceId === read.instanceId);
          // A reload since the click rebuilt this read; its cursor is newer.
          if (!outcome || outcome.result.phase !== "available" || read.phase !== "available" ||
              read.nextCursor !== outcome.before) return read;
          return { ...read, nextCursor: outcome.result.nextCursor, complete: outcome.result.complete,
            eventCount: read.eventCount + outcome.result.eventCount };
        });
        return {
          ...current,
          reads,
          complete: reads.length > 0 && reads.every((read) => read.phase === "available" && read.complete) &&
            current.omittedCount === 0,
          older: failure && failure.result.phase !== "available"
            ? { loading: false, error: agentTraceOlderPageErrorCopy(failure.result) }
            : { loading: false },
        };
      });
    });
  }, [setPanelState, syncRef, targetKey]);

  return { targetKey, loadOlder };
}
