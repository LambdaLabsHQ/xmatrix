"use client";

import { useCallback, useMemo, useState } from "react";
import { useAgentRegistrationCatalog } from "@/components/dashboard/agent-capability-select";
import type { WriteAgent } from "./page-write-with";
import { useAuth } from "@/lib/auth-context";
import { userSpaceLocalState } from "@/lib/user-space-local-state";

const writer = userSpaceLocalState<string>("page-writer", (value) => typeof value === "string" ? value : undefined);

/**
 * The Agents a person can call to write a page with them: each runtime the Space can start now, by its
 * face, the one they last wrote with first. Which one that was is this device's memory of a choice,
 * not a fact anyone else reads.
 */
export function usePageWriters(spaceId: string | null, token: string, enabled: boolean) {
  const { user } = useAuth();
  const userId = user?.id;
  const catalog = useAgentRegistrationCatalog(spaceId ?? "", token, enabled && Boolean(spaceId && token));
  const stored = useMemo(() => writer.read({ userId, spaceId }), [userId, spaceId]);
  const [chosen, setChosen] = useState<{ userId: string | undefined; spaceId: string | null; harness: string } | null>(null);
  const favourite = chosen?.userId === userId && chosen?.spaceId === spaceId ? chosen?.harness : stored;
  const agents = useMemo<WriteAgent[]>(() => {
    const harnesses = new Set<string>();
    for (const registration of catalog.data?.registrations ?? []) {
      if (registration.state === "enabled" && registration.routingReady) harnesses.add(registration.key.harness);
    }
    return [...harnesses].map((harness) => ({ harness }))
      .sort((a, b) => Number(b.harness === favourite) - Number(a.harness === favourite));
  }, [catalog.data, favourite]);
  const choose = useCallback((harness: string) => {
    setChosen({ userId, spaceId, harness });
    writer.write({ userId, spaceId }, harness);
  }, [spaceId, userId]);
  return { agents, favourite: agents[0]?.harness ?? null, choose };
}
