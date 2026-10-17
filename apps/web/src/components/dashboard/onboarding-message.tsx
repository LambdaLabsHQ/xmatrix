"use client";

import { Check, Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { cn } from "@/lib/utils";
import { listNames } from "./connect-machine";
import { InstalledHarnessSwitchList } from "./installed-harness-switch-list";
import { ConnectMachine } from "./space-agent-setup-card";
import { SupportedAgents } from "./supported-agents";
import { useInstalledHarnesses } from "./use-installed-harnesses";

/* Onboarding is a conversation xMatrix has with a new person: it says the
   three sentences xMatrix teaches as messages, each where it is about to
   become true. A message only names its step; what the step shows is read
   from the facts (the Space's agents, the machine's report), so reopening
   the conversation later shows what happened, never a stale command. */

export const ONBOARDING_MESSAGE_KIND = "xmatrix.onboarding.v1";

export type OnboardingStage = "bring-agents" | "just-talk";

export function onboardingMessageStage(metadata: Record<string, unknown> | undefined): OnboardingStage | null {
  if (!metadata || metadata.kind !== ONBOARDING_MESSAGE_KIND) return null;
  return metadata.stage === "bring-agents" || metadata.stage === "just-talk" ? metadata.stage : null;
}

/* The first task should end in a Page: seeing a conclusion written into a
   page is the moment the product makes sense. Each starter asks for one. */
export const FIRST_TASK_STARTERS = [
  { id: "project", label: "My project",
    message: "Write a page about a project I'm working on: what it is, where it stands and what is still open. Ask me which project first." },
  { id: "plan", label: "A plan",
    message: "Help me plan something I'm working on, and keep the plan in a page as we go." },
  /* It names the canonical runbook on purpose: an agent asked to explain
     xMatrix from memory invents an answer. */
  { id: "xmatrix", label: "Learn xMatrix",
    message: "Read https://xmatrix.sh/start.md and write a page on how I should hand you work through xMatrix." },
] as const;

export function OnboardingMessage({ stage, spaceId, token, userId, onSend }: {
  stage: OnboardingStage;
  spaceId: string | null;
  token: string | null;
  userId: string;
  /** Sends a starter as the person's own message in this conversation. */
  onSend?: (body: string) => void;
}) {
  return stage === "bring-agents"
    ? <BringAgentsMessage spaceId={spaceId} token={token} userId={userId} />
    : <JustTalkMessage onSend={onSend} />;
}

function BringAgentsMessage({ spaceId, token, userId }: { spaceId: string | null; token: string | null; userId: string }) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  return (
    <div className="max-w-xl" data-onboarding-stage="bring-agents">
      <p className="font-semibold">Bring your agents into xMatrix</p>
      {enabled.length > 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Check className="size-4 shrink-0 text-foreground" />
          {listNames(enabled.map((registration) => `${registration.displayName} on ${registration.machineName}`))}
          {enabled.length === 1 ? " is" : " are"} in.
        </p>
      ) : fleet.ready && fleet.candidates.length > 0 ? (
        <div className="mt-2">
          <p className="text-sm text-muted-foreground">Found these on your computer. Turn them on to talk to them here.</p>
          <InstalledHarnessSwitchList fleet={fleet} onlyNew />
          <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
            onClick={() => void fleet.enableAll()} className={actionClass({ variant: "primary", size: "sm" }, "mt-2")}>
            {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Check className="size-4" />}
            {fleet.enablingAll ? "Turning on…" : "Bring them in"}
          </button>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">They keep running on your own computer. Whichever of these you use works.</p>
          <SupportedAgents className="mt-3" />
          <ConnectMachine spaceId={spaceId} token={token ?? undefined} userId={userId} />
          <p className="mt-5 text-xs text-muted-foreground">
            Prefer an app?{" "}
            <a href="/download" className="font-semibold text-foreground underline-offset-2 hover:underline">Download xMatrix</a>{" "}
            on that computer. It finds the agents installed there without a terminal.
          </p>
        </>
      )}
    </div>
  );
}

function JustTalkMessage({ onSend }: { onSend?: (body: string) => void }) {
  return (
    <div className="max-w-xl" data-onboarding-stage="just-talk">
      <p className="font-semibold">Just talk. Agents keep the facts in Pages</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Ask for something here and your agent writes what matters into a page. Or start from one of these:
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {FIRST_TASK_STARTERS.map((starter) => (
          <button key={starter.id} type="button" disabled={!onSend} title={starter.message}
            onClick={() => onSend?.(`@auto ${starter.message}`)}
            className={cn("h-7 rounded-[999px] border-[1px] border-border px-3 text-xs font-semibold",
              "text-foreground hover:border-foreground disabled:opacity-50")}>
            {starter.label}
          </button>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">The first reply takes about a minute while the agent starts.</p>
    </div>
  );
}
