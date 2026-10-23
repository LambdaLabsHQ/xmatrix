"use client";

import type { AgentListGroup } from "./agent-list-groups";
import { HarnessProfileSection } from "./harness-profile-section";
import { Face } from "./face";
import { MachineGlyph } from "./machine-glyph";
import { machineOs } from "./machine-os";
import { ToolDetail, ToolDetailSection } from "./tool-split";

/**
 * An agent as the Space has it: what is set on the runtime itself and holds on
 * every machine it runs on, then those machines. What differs per machine
 * (its switch, model, sign-in, usage) is on the machine's own row.
 */
export function AgentHarnessDetail({ group, token, onBack, onOpenLocation, onSaved }: {
  group: AgentListGroup;
  token: string | undefined;
  onBack: () => void;
  onOpenLocation: (id: string) => void;
  onSaved: () => Promise<unknown>;
}) {
  const { harness, rows } = group;
  const running = rows.filter((row) => row.activity.state === "running").length;
  // The description is the runtime's, so every location reports the same one.
  const described = rows.find((row) => row.registration.canDescribe) ?? rows[0];
  return (
    <ToolDetail
      onBack={onBack}
      backLabel="Agents"
      context={<span className="flex items-center gap-1.5">
        <Face of={{ kind: "agent", name: harness, harness }} size="xs" />
        <span>Agent</span>
      </span>}
      title={harness}
      status={<span className="text-foreground">
        {rows.length === 1 ? "On 1 machine" : `On ${rows.length} machines`}{running ? ` · ${running} running` : ""}
      </span>}
    >
      {described && <HarnessProfileSection registration={described.registration} token={token} onSaved={onSaved} />}
      <ToolDetailSection title={`Where it runs · ${rows.length}`}>
        <ul className="app-tool-lines">
          {rows.map((row) => (
            <li key={row.id} className="flex min-w-0 items-center gap-2 py-1.5 text-sm">
              <span className="app-tool-state-icon shrink-0" data-state={row.activity.state} aria-hidden="true">
                <MachineGlyph os={machineOs(row.registration.live?.machine.platform)} className="size-4" /></span>
              <button type="button" onClick={() => onOpenLocation(row.id)} data-testid="agent-location"
                className="min-w-0 truncate text-left font-semibold hover:underline">
                {row.machineInLine ? `${row.title} · ${row.registration.machineName}` : row.title}
              </button>
              <span className="ml-auto min-w-0 shrink truncate text-xs text-muted-foreground">{row.activity.line}</span>
            </li>
          ))}
        </ul>
      </ToolDetailSection>
    </ToolDetail>
  );
}
