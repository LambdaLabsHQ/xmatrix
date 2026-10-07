"use client";

import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AGENT_PRESETS, WEB_PROXY_ROUTES, agentLaunchExecutable, canonicalRegistrationHarness,
  type SetupIntentStatus,
} from "@xmatrix/protocol";
import { XMatrixApiError, xmatrixApiRequest } from "@/lib/query/api-client";
import { defaultAgentName } from "./workspace-shell-formatters";

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
 * one intent per Space and tab, kept across a reload, replaced once expired.
 * It is read every two seconds while the page waits, and not once it is done.
 */
export function useSetupIntent(spaceId: string | null, token: string | undefined, userId: string | undefined) {
  const [intentId, setIntentId] = useState<string | null>(() => (spaceId ? rememberedIntent(spaceId) : null));
  const [shownAt, setShownAt] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setIntentId(spaceId ? rememberedIntent(spaceId) : null);
  }, [spaceId]);

  useEffect(() => {
    if (!spaceId || !token || intentId) return;
    let cancelled = false;
    void xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intents, token, method: "POST", body: { spaceId },
    }).then((created) => {
      if (cancelled) return;
      remember(spaceId, created.intentId);
      setIntentId(created.intentId);
      setShownAt(Date.now());
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not prepare a setup command");
    });
    return () => { cancelled = true; };
  }, [spaceId, token, intentId]);

  const status = useQuery({
    queryKey: ["setup-intent", intentId],
    queryFn: ({ signal }) => xmatrixApiRequest<SetupIntentStatus>({
      url: WEB_PROXY_ROUTES.setup_intent(intentId!), token, signal,
    }),
    enabled: Boolean(intentId && token),
    refetchInterval: (query) => {
      const data = query.state.data;
      const settled = data?.phase === "connected" && data.machine?.harnesses &&
        data.machine.harnesses.filter((harness) => harness.installed)
          .every((harness) => data.registeredHarnesses.includes(harness.id));
      return settled ? false : POLL_MS;
    },
    retry: (count, reason) => !(reason instanceof XMatrixApiError && reason.status === 404) && count < 3,
  });

  // An expired or unknown command is replaced by a fresh one.
  const expired = status.error instanceof XMatrixApiError && status.error.status === 404;
  useEffect(() => {
    if (!expired || !spaceId) return;
    remember(spaceId, null);
    setIntentId(null);
  }, [expired, spaceId]);

  const act = useCallback(async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      await status.refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That did not work. Try again.");
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
  /* Each detected harness becomes this owner's agent on that machine, the way
     the desktop app's Bind adds one; the Space's policy still decides. */
  const bringIn = (harnessIds: string[]) => act(async () => {
    const machineId = status.data?.machine?.machineId;
    if (!spaceId || !userId || !machineId) return;
    for (const harnessId of harnessIds) {
      const preset = AGENT_PRESETS.find((candidate) => candidate.id === harnessId);
      if (!preset) continue;
      await xmatrixApiRequest({
        url: WEB_PROXY_ROUTES.space_agent_registration_command(spaceId), token, method: "POST",
        body: {
          action: "create",
          commandId: `registration-connect:${crypto.randomUUID()}`,
          key: { spaceId, ownerUserId: userId, machineId, harness: canonicalRegistrationHarness(preset.id) },
          displayName: defaultAgentName(preset),
          environment: {
            schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
            launch: {
              runtime: agentLaunchExecutable(preset.runtime),
              runtimeArgs: preset.defaultArgs,
              ...(preset.backend ? { backend: preset.backend } : {}),
            },
          },
        },
      });
    }
  });

  return { intentId, status: status.data, shownAt, error, busy, approve, decline, bringIn };
}
