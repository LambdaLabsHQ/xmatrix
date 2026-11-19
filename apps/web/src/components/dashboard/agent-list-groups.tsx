"use client";

import type { AgentCapabilitySummary } from "@xmatrix/protocol";

import { agentUsageGlance } from "./agent-quota-usage";
import { registrationActivity, registrationListed, registrationRowTitle } from "./my-agents-registrations";
import { registrationTupleId } from "./use-registration-command";

export type AgentListGroup = ReturnType<typeof agentListGroups>[number];

/** The list item that is a runtime itself, beside the ids of its locations. */
export function agentHarnessSelectionId(harness: string): string {
  return `agent:${harness}`;
}

/** The Space's registrations under their runtime; within one, what is working comes first and what cannot work last. */
export function agentListGroups(catalog: { capabilities: AgentCapabilitySummary[] } | undefined,
  { conversationTitle, now, working }: {
    conversationTitle: (channelId: string) => string | undefined; now: number;
    /** The Instances with work in hand (see `registrationActivity`). */
    working: ReadonlySet<string>;
  }) {
  return (catalog?.capabilities ?? []).map((group) => ({
    harness: group.harness,
    rows: group.locations.filter(registrationListed).map((registration) => ({
      registration,
      harness: group.harness,
      usage: agentUsageGlance(registration.live?.quota, now),
      id: registrationTupleId(registration.key),
      activity: registrationActivity(registration, { conversationTitle, now, working }),
      ...registrationRowTitle(registration),
    })).sort((left, right) => left.activity.rank - right.activity.rank || left.title.localeCompare(right.title)),
  })).filter((group) => group.rows.length > 0);
}
