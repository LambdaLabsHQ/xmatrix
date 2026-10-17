"use client";

import { useState } from "react";
import type { AgentPreset } from "@xmatrix/protocol";
import { GlassSelect } from "@/components/ui/glass-select";
import { cn } from "@/lib/utils";
import { CommandBlock } from "./command-block";
import type { InstallPlatform } from "./connect-machine";
import { SUPPORTED_AGENTS, agentInstallCommand } from "./supported-agents-catalog";

function AgentMark({ preset }: { preset: AgentPreset }) {
  // eslint-disable-next-line @next/next/no-img-element -- a 20px harness preset icon, as on summon chips.
  return <img src={preset.avatarUrl} alt="" aria-hidden="true" className="size-5 object-contain" />;
}

/** The leading agents that fit one line of a phone, by their marks. */
const FIRST_LINE = 8;

/** The agents by their marks, the leading ones first; the rest unfold on request. */
export function SupportedAgents({ className }: { className?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? SUPPORTED_AGENTS : SUPPORTED_AGENTS.slice(0, FIRST_LINE);
  const more = SUPPORTED_AGENTS.length - shown.length;
  return (
    <div className={cn("flex flex-wrap items-center gap-2.5", className)} data-testid="supported-agents">
      <ul aria-label="Agents xMatrix brings in" className="contents">
        {shown.map((preset) => (
          <li key={preset.id} title={preset.displayName} aria-label={preset.displayName}>
            <AgentMark preset={preset} />
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" onClick={() => setAll(true)} aria-label={`Show ${more} more agents`}
          className="text-xs font-semibold text-muted-foreground hover:text-foreground">
          +{more}
        </button>
      )}
    </div>
  );
}

/** A machine with no agent yet: choose the one to install, then paste its own installer there. */
export function AgentInstallPicker({ platform, className }: { platform: InstallPlatform; className?: string }) {
  const installable = SUPPORTED_AGENTS.filter((preset) => agentInstallCommand(preset, platform));
  const [pickedId, setPickedId] = useState<string>(installable[0]?.id ?? "");
  const picked = installable.find((preset) => preset.id === pickedId) ?? installable[0];
  if (!picked) return null;
  return (
    <div className={className} data-testid="agent-install-picker">
      <GlassSelect aria-label="Agent to install" className="w-full max-w-xs" value={picked.id} onChange={setPickedId}
        options={installable.map((preset) => ({ value: preset.id, label: preset.displayName }))} />
      <div className="mt-2"><CommandBlock command={agentInstallCommand(picked, platform) ?? null} /></div>
    </div>
  );
}
