"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type SetupIntentStatus } from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { setupIntentPollIntervalMs, setupIntentReported } from "./connect-machine";

function storageKey(spaceId: string): string {
  return `xmatrix:setup-intent:${spaceId}`;
}

function rememberedIntent(spaceId: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(spaceId));
  } catch {
    return null;
  }
}

function remember(spaceId: string, intentId: string | null): void {
  try {
    if (intentId) window.sessionStorage.setItem(storageKey(spaceId), intentId);
    else window.sessionStorage.removeItem(storageKey(spaceId));
  } catch {
    /* A page without storage simply makes a new command after a reload. */
  }
}

/**
 * The setup command this page shows for a Space and what has happened since:
 * one intent per Space and tab, kept across a reload. A stale intent restored
 * from sessionStorage is replaced once on reload; an intent created in this
 * session stops polling when it expires after 30 minutes rather than minting
 * new intents indefinitely in an unattended tab. Polling slows while waiting
 * idle and stops once the machine reports an installed harness.
 */
export function useSetupIntent(spaceId: string | null, token: string | undefined, userId: string | undefined) {
  const [intentId, setIntentId] = useState<string | null>(() => (spaceId ? rememberedIntent(spaceId) : null));
  const [restoredFromStorage, setRestoredFromStorage] = useState<boolean>(() => Boolean(spaceId && rememberedIntent(spaceId)));
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    const saved = spaceId ? rememberedIntent(spaceId) : null;
    setIntentId(saved);
    setRestoredFromStorage(Boolean(saved));
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !token || intentId) return;
    let cancelled = false;
    setError(null);
    void xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intents, token, method: "POST", body: { spaceId },
    }).then((created) => {
      if (cancelled) return;
      remember(spaceId, created.intentId);
      setIntentId(created.intentId);
      setRestoredFromStorage(false);
      setShownAt(Date.now());
    }).catch((reason: unknown) => {
      if (!cancelled) setError(userErrorMessage(reason, "Couldn't prepare a setup command"));
    });
    return () => { cancelled = true; };
  }, [spaceId, token, intentId, preparationAttempt]);

  const status = useQuery({
    queryKey: ["setup-intent", intentId],
    queryFn: ({ signal }) => xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intent(intentId!), token, signal,
    }),
    enabled: Boolean(intentId && token),
    refetchInterval: (query) => (query.state.error ? false : setupIntentPollIntervalMs(query.state.data, Date.now() - shownAt)),
  });

  const machineReported = setupIntentReported(status.data);
  useEffect(() => {
    if (!machineReported || !userId) return;
    void queryClient.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "machine-daemons") });
  }, [machineReported, queryClient, userId]);

  // A stale remembered command from a reload is replaced once; a freshly
  // created command that sat idle until expiry stops until the user asks again.
  const statusExpired = status.error instanceof XMatrixApiError && status.error.status === 404;
  const expired = statusExpired && !restoredFromStorage;
  useEffect(() => {
    if (!statusExpired || !spaceId) return;
    remember(spaceId, null);
    if (restoredFromStorage) {
      setIntentId(null);
      setRestoredFromStorage(false);
    }
  }, [statusExpired, restoredFromStorage, spaceId]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await status.refetch();
    } catch (reason) {
      setError(userErrorMessage(reason, "Couldn't answer the connection request"));
    } finally {
      setBusy(false);
    }
  }, [status]);

  const approve = (userCode: string) => act(() => xmatrixApiRequest({
    url: WEB_PROXY_ROUTES.setup_intent_approve(intentId!), token, method: "POST", body: { userCode },
  }));
  const decline = () => act(() => xmatrixApiRequest({
    url: WEB_PROXY_ROUTES.setup_intent_decline(intentId!), token, method: "POST",
  }));
  const retry = () => {
    setError(null);
    if (expired) {
      if (spaceId) remember(spaceId, null);
      if (intentId) queryClient.removeQueries({ queryKey: ["setup-intent", intentId] });
      setIntentId(null);
      setPreparationAttempt((attempt) => attempt + 1);
      return;
    }
    if (intentId) void status.refetch();
    else setPreparationAttempt((attempt) => attempt + 1);
  };
  return {
    intentId, status: status.error ? undefined : status.data, shownAt, expired,
    error: error || (!statusExpired && status.error ? userErrorMessage(status.error, "Couldn't prepare a setup command", "Couldn't check the connection") : null),
    busy, retrying: status.isFetching, approve, decline, retry,
  };
}
