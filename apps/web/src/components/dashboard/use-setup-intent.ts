"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES, type OnboardingLocale, type SetupIntentStatus } from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";

const POLL_MS = 2_000;

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

/** The command this tab shows for a Space; a setup link opened on another
 * device hands its command over here. */
export function rememberSetupIntent(spaceId: string, intentId: string | null): void {
  try {
    if (intentId) window.sessionStorage.setItem(storageKey(spaceId), intentId);
    else window.sessionStorage.removeItem(storageKey(spaceId));
  } catch {
    /* A page without storage simply makes a new command after a reload. */
  }
}

/**
 * The setup command this page shows for a Space and what has happened since:
 * one intent per Space and tab, kept across a reload, replaced once expired.
 * It is read every two seconds while the page waits, and not once the machine
 * reports an installed harness: from there the installed-harness switches,
 * which read the same machine report, carry on.
 */
export function useSetupIntent(spaceId: string | null, token: string | undefined, userId: string | undefined) {
  const [intentId, setIntentId] = useState<string | null>(() => (spaceId ? rememberedIntent(spaceId) : null));
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparationAttempt, setPreparationAttempt] = useState(0);
  const queryClient = useQueryClient();

  useEffect(() => {
    setIntentId(spaceId ? rememberedIntent(spaceId) : null);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !token || intentId) return;
    let cancelled = false;
    setError(null);
    void xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intents, token, method: "POST", body: { spaceId },
    }).then((created) => {
      if (cancelled) return;
      rememberSetupIntent(spaceId, created.intentId);
      setIntentId(created.intentId);
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
    refetchInterval: (query) => (query.state.error || reported(query.state.data) ? false : POLL_MS),
  });

  const machineReported = reported(status.data);
  useEffect(() => {
    if (!machineReported || !userId) return;
    void queryClient.invalidateQueries({ queryKey: xmatrixQueryKeys.domain({ userId }, "machine-daemons") });
  }, [machineReported, queryClient, userId]);

  // An expired or unknown command is replaced by a fresh one.
  const expired = status.error instanceof XMatrixApiError && status.error.status === 404;
  useEffect(() => {
    if (!expired || !spaceId) return;
    rememberSetupIntent(spaceId, null);
    setIntentId(null);
  }, [expired, spaceId]);

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
  /** Emails the command's link to the person's own address, in `locale`; the reason it failed, or null. */
  const emailLink = async (locale: OnboardingLocale): Promise<string | null> => {
    try {
      await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.setup_intent_email(intentId!), token, method: "POST", body: { locale } });
      return null;
    } catch (reason) {
      // The day's three are spent: the Hub's own sentence, not "busy, try again".
      if (reason instanceof XMatrixApiError && reason.code === "setup_link_email_limited") return reason.message;
      return userErrorMessage(reason, "Couldn't send the email");
    }
  };
  const retry = () => {
    setError(null);
    if (intentId) void status.refetch();
    else setPreparationAttempt((attempt) => attempt + 1);
  };
  return {
    intentId, status: status.error ? undefined : status.data, shownAt,
    error: error || (!expired && status.error ? userErrorMessage(status.error, "Couldn't prepare a setup command", "Couldn't check the connection") : null),
    busy, retrying: status.isFetching, approve, decline, emailLink, retry,
  };
}

function reported(status: SetupIntentStatus | undefined): boolean {
  return status?.phase === "connected" && Boolean(status.machine?.harnesses?.some((harness) => harness.installed));
}
