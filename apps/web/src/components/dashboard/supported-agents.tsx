"use client";

import { useState } from "react";
import { agentFaceUrl, type AgentPreset } from "@xmatrix/protocol";
import { GlassSelect } from "@/components/ui/glass-select";
import { ONBOARDING_COPY, type OnboardingCopy } from "@/lib/onboarding-copy";
import { cn } from "@/lib/utils";
import { CommandBlock } from "./command-block";
import type { InstallPlatform } from "./connect-machine";
import { SUPPORTED_AGENTS, agentInstallCommand } from "./supported-agents-catalog";

function AgentMark({ preset }: { preset: AgentPreset }) {
  // eslint-disable-next-line @next/next/no-img-element -- a 20px harness preset icon, as on summon chips.
  return <img src={agentFaceUrl(preset.id)} alt="" aria-hidden="true" className="size-full object-contain" />;
}

/** How many marks lead the line: the agents most people arrive with. */
const LEADING_MARKS = 6;
/** How many agents the line names before it counts the rest. */
const NAMED = 3;

/* One line that answers "does it work with mine?": the leading marks
   overlapped, the first names, and how many more, which unfold into every
   name on request. */
export function AgentsLine({ className, copy = ONBOARDING_COPY.en }: { className?: string; copy?: OnboardingCopy }) {
  const [all, setAll] = useState(false);
  const names = SUPPORTED_AGENTS.map((preset) => preset.displayName);
  return (
    <div className={cn("flex items-start gap-2 text-[13px] leading-5 text-muted-foreground", className)} data-testid="supported-agents">
      <span aria-hidden="true" className="flex shrink-0 gap-1 py-0.5">
        {SUPPORTED_AGENTS.slice(0, LEADING_MARKS).map((preset) => (
          <span key={preset.id} className="flex size-4 items-center justify-center overflow-hidden rounded-[4px]">
            <AgentMark preset={preset} />
          </span>
        ))}
      </span>
      <p className="min-w-0">
        {all ? copy.worksWith(copy.listNames(names), true) : copy.worksWith(names.slice(0, NAMED).join(copy.comma), false)}
        {!all && (
          <button type="button" onClick={() => setAll(true)}
            className="font-semibold text-foreground underline-offset-2 hover:underline">{copy.more(names.length - NAMED)}</button>
        )}{copy.period}
      </p>
    </div>
  );
}

/** A machine with no agent yet: choose the one to install, then paste its own installer there. */
export function AgentInstallPicker({ platform, className, copy = ONBOARDING_COPY.en }: {
  platform: InstallPlatform; className?: string; copy?: OnboardingCopy;
}) {
  const installable = SUPPORTED_AGENTS.filter((preset) => agentInstallCommand(preset, platform));
  const [pickedId, setPickedId] = useState<string>(installable[0]?.id ?? "");
  const picked = installable.find((preset) => preset.id === pickedId) ?? installable[0];
  if (!picked) return null;
  return (
    <div className={className} data-testid="agent-install-picker">
      <GlassSelect aria-label={copy.agentToInstall} className="w-full max-w-xs" value={picked.id} onChange={setPickedId}
        options={installable.map((preset) => ({ value: preset.id, label: preset.displayName }))} />
      <div className="mt-2"><CommandBlock command={agentInstallCommand(picked, platform) ?? null} copy={copy} /></div>
    </div>
  );
}
