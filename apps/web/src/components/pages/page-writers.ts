"use client";

import { useCallback, useMemo, useState } from "react";
import { useAgentRegistrationCatalog } from "@/components/dashboard/agent-capability-select";
import type { WriteAgent } from "./page-write-with";

const storageKey = (spaceId: string) => `xmatrix.page-writer.${spaceId}`;

/**
 * The Agents a person can call to write a page with them: each runtime the Space can start now, by its
 * face, the one they last wrote with first. Which one that was is this device's memory of a choice,
 * not a fact anyone else reads.
 */
export function usePageWriters(spaceId: string | null, token: string, enabled: boolean) {
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token, enabled && Boolean(spaceId && token));
  const [favourite, setFavourite] = useState<string | null>(() =>
    spaceId && typeof window !== "undefined" ? window.localStorage.getItem(storageKey(spaceId)) : null);
  const agents = useMemo<WriteAgent[]>(() => {
    const harnesses = new Set<string>();
    for (const registration of catalog.data?.registrations ?? []) {
      if (registration.state === "enabled" && registration.routingReady) harnesses.add(registration.key.harness);
    }
    return [...harnesses].map((harness) => ({ harness }))
      .sort((a, b) => Number(b.harness === favourite) - Number(a.harness === favourite));
  }, [catalog.data, favourite]);
  const choose = useCallback((harness: string) => {
    setFavourite(harness);
    if (spaceId) window.localStorage.setItem(storageKey(spaceId), harness);
  }, [spaceId]);
  return { agents, favourite: agents[0]?.harness ?? null, choose };
}
