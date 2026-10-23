"use client";

import type { AgentCapabilitySummary } from "@xmatrix/protocol";

import { agentUsageGlance } from "./agent-quota-usage";
import { Face } from "./face";
import { MachineGlyph } from "./machine-glyph";
import { MachineLoadGlanceBars } from "./machine-load-panel";
import { machineOs } from "./machine-os";
import { registrationActivity, registrationListed, registrationRowTitle } from "./my-agents-registrations";
import { ToolListGroup, ToolListRow } from "./tool-split";
import { registrationTupleId } from "./use-registration-command";

export type AgentListGroup = ReturnType<typeof agentListGroups>[number];

/** The list item that is a runtime itself, beside the ids of its locations. */
export function agentHarnessItemId(harness: string): string {
  return `agent:${harness}`;
}

/** The Space's registrations under their runtime; within one, what is working comes first and what cannot work last. */
export function agentListGroups(catalog: { capabilities: AgentCapabilitySummary[] } | undefined,
  { conversationTitle, now }: { conversationTitle: (channelId: string) => string | undefined; now: number }) {
  return (catalog?.capabilities ?? []).map((group) => ({
    harness: group.harness,
    rows: group.locations.filter(registrationListed).map((registration) => ({
      registration,
      harness: group.harness,
      usage: agentUsageGlance(registration.live?.quota, now),
      id: registrationTupleId(registration.key),
      activity: registrationActivity(registration, { conversationTitle, now }),
      ...registrationRowTitle(registration),
    })).sort((left, right) => left.activity.rank - right.activity.rank || left.title.localeCompare(right.title)),
  })).filter((group) => group.rows.length > 0);
}

/** Agents as the Agents list shows them: each runtime as a heading, one row per location under it. */
export function AgentListGroups({ groups, selectedId, shownId, currentUserId, limit, headingsOpen, onSelect }: {
  groups: AgentListGroup[];
  selectedId: string | null;
  /** The row shown on the paper beside the list without being chosen. */
  shownId?: string;
  currentUserId: string;
  /** Rows each runtime shows before the rest are asked for (see ToolListGroup). */
  limit?: number;
  /** A heading is an item of its own (`agentHarnessItemId`): what is set on the runtime, not on a location. */
  headingsOpen?: boolean;
  onSelect: (id: string) => void;
}) {
  return groups.map((group) => {
    const headingId = agentHarnessItemId(group.harness);
    return (
      <ToolListGroup key={group.harness} title={group.harness} count={group.rows.length} identity limit={limit}
        onTitle={headingsOpen ? () => onSelect(headingId) : undefined}
        selected={headingId === selectedId} shownBeside={!selectedId && shownId === headingId}
        icon={<Face of={{ kind: "agent", name: group.harness, harness: group.harness }} size="sm" className="shrink-0" />}>
        {group.rows.map((row) => (
          <ToolListRow key={row.id} testId="agent-row" state={row.activity.state}
            selected={row.id === selectedId}
            shownBeside={!selectedId && shownId === row.id}
            onSelect={() => onSelect(row.id)}
            leading={<span className="app-tool-state-icon" data-state={row.activity.state} aria-hidden="true">
              <MachineGlyph os={machineOs(row.registration.live?.machine.platform)} className="size-4" /></span>}
            trailing={<MachineLoadGlanceBars glance={row.usage}
              testId="agent-usage-glance" label={row.usage.map((reading) => reading.detail).join(", ")} />}
            title={row.title}
            end={row.registration.key.ownerUserId === currentUserId ? undefined : row.registration.ownerName}
            subtitle={row.machineInLine ? `${row.registration.machineName} · ${row.activity.line}` : row.activity.line} />
        ))}
      </ToolListGroup>
    );
  });
}
