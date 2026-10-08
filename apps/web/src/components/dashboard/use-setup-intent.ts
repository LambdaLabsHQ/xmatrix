"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_PRESETS, WEB_PROXY_ROUTES, type SetupIntentStatus } from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { connectStep } from "./connect-machine";
import { harnessSpaceKey } from "./harness-space-switch";
import { useHarnessSpaceControl } from "./use-harness-space-control";

const POLL_MS = 2_000;

function storageKey(userId: string, spaceId: string): string {
  return `xmatrix:setup-intent:${userId}:${spaceId}`;
}

function rememberedIntent(key: string): string | null {
  try {
    const id = window.sessionStorage.getItem(key);
    return id && /^[a-f0-9]{32}$/u.test(id) ? id : null;
  } catch {
    return null;
  }
}

function remember(key: string, intentId: string | null): void {
  try {
    if (intentId) window.sessionStorage.setItem(key, intentId);
    else window.sessionStorage.removeItem(key);
  } catch {
    /* A page without storage simply makes a new command after a reload. */
  }
}

/** One owner-scoped command per Space and tab, shared by all setup surfaces.
 * The Hub supplies progress; an expired command is replaced, failures can be
 * retried, and polling ends only when the agents have come into the Space. */
export function useSetupIntent(spaceId: string | null, token: string | undefined, userId: string | undefined) {
  const key = storageKey(userId ?? "", spaceId ?? "");
  const ready = Boolean(spaceId && token && userId);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const command = useQuery({
    queryKey: ["setup-intent-command", userId, spaceId],
    queryFn: async ({ signal }) => {
      const remembered = rememberedIntent(key);
      if (remembered) return remembered;
      const created = await xmatrixApiRequest<SetupIntentStatus>({
        url: WEB_PROXY_ROUTES.setup_intents, token, method: "POST", body: { spaceId }, signal,
      });
      if (!/^[a-f0-9]{32}$/u.test(created.intentId ?? "")) throw new Error("Could not prepare a setup command. Try again.");
      remember(key, created.intentId);
      return created.intentId;
    },
    enabled: ready,
    staleTime: Infinity,
  });
  const intentId = ready ? command.data ?? null : null;
  const status = useQuery({
    queryKey: ["setup-intent", userId, spaceId, intentId],
    queryFn: ({ signal }) => xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intent(intentId!), token, signal,
    }),
    enabled: Boolean(intentId),
    refetchInterval: (query) => query.state.data && connectStep(query.state.data, 0).kind === "done" ? false : POLL_MS,
  });

  const { refetch: refetchCommand } = command;
  const expired = status.error instanceof XMatrixApiError && status.error.status === 404;
  useEffect(() => {
    if (!expired) return;
    remember(key, null);
    void refetchCommand();
  }, [expired, key, refetchCommand]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    if (locked.current || !intentId) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
      const fresh = await status.refetch();
      if (fresh.isError) throw fresh.error;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }, [intentId, status]);

  const approve = (userCode: string) => act(() => xmatrixApiRequest({
    url: WEB_PROXY_ROUTES.setup_intent_approve(intentId!), token, method: "POST", body: { userCode },
  }));
  const decline = () => act(() => xmatrixApiRequest({
    url: WEB_PROXY_ROUTES.setup_intent_decline(intentId!), token, method: "POST",
  }));
  /* Reuse the owner switches and their server-authorized catalog, including
     partial success: a retry only enables pairs that are still off. */
  const control = useHarnessSpaceControl(spaceId, token, userId);
  const bringIn = (harnessIds: string[]) => act(async () => {
    const machineId = status.data?.machine?.machineId;
    if (!spaceId || !userId || !machineId) return;
    for (const harnessId of harnessIds) {
      const preset = AGENT_PRESETS.find((candidate) => candidate.id === harnessId);
      if (!preset) continue;
      if (!(await control.set(harnessSpaceKey(spaceId, userId, machineId, preset.id), preset, true))) {
        throw new Error(`${preset.displayName} could not be brought in. Try again.`);
      }
    }
  });
  const retry = () => {
    setError(null);
    if (command.isError || !intentId) void command.refetch();
    else void status.refetch();
  };
  const startAnother = () => {
    remember(key, null);
    setError(null);
    void command.refetch();
  };
  const readError = command.error ?? (expired ? null : status.error);
  return {
    intentId: expired || command.isFetching ? null : intentId,
    status: expired || command.isFetching ? undefined : status.data,
    shownAt: command.dataUpdatedAt,
    error: control.error ?? error ?? readError?.message,
    busy: busy || Boolean(control.pending) || command.isFetching || status.isError,
    approve, decline, bringIn, retry, startAnother,
  };
}
