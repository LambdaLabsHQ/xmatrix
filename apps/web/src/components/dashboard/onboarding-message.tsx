"use client";

import { useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { CommandBlock } from "./command-block";
import { useNow } from "./agent-work-intent";
import {
  connectStep, defaultInstallPlatform, listNames, setupInstallCommand, terminalInstallPlatform,
  type InstallPlatform,
} from "./connect-machine";
import { AgentInstallPicker } from "./supported-agents";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import { useSetupIntent } from "./use-setup-intent";

/* Onboarding is what xMatrix says to a new person in their welcome
   conversation: one sentence and the one thing to do now. A message only
   names its step; what it shows is read from the facts (the Space's agents,
   the machine's report), so reopening the conversation later shows what
   happened, never a stale command. */

export const ONBOARDING_MESSAGE_KIND = "xmatrix.onboarding.v1";

export type OnboardingStage = "bring-agents" | "agents-in";

export function onboardingMessageStage(metadata: Record<string, unknown> | undefined): OnboardingStage | null {
  if (!metadata || metadata.kind !== ONBOARDING_MESSAGE_KIND) return null;
  return metadata.stage === "bring-agents" || metadata.stage === "agents-in" ? metadata.stage : null;
}

export function OnboardingMessage({ stage, spaceId, token, userId }: {
  stage: OnboardingStage; spaceId: string | null; token: string | null; userId: string;
}) {
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  if (stage === "agents-in") {
    if (enabled.length === 0) return null;
    const handles = [...new Set(enabled.map((registration) => `@${registration.displayName}`))];
    return <p data-onboarding-stage="agents-in">
      Mention {listNames(handles).replace(/ and (?=[^ ]+$)/u, " or ")} here to give {handles.length === 1 ? "it" : "them"} work.
    </p>;
  }
  if (enabled.length > 0) {
    return <p data-onboarding-stage="bring-agents" className="flex items-center gap-1.5">
      <Check className="size-4 shrink-0" /> Connected {listNames([...new Set(enabled.map((registration) => registration.machineName))])}.
    </p>;
  }
  return (
    <div data-onboarding-stage="bring-agents" className="max-w-xl">
      <p>Run this on the computer with your agents (Claude Code, Codex, Cursor or any other):</p>
      {fleet.ready && fleet.candidates.length > 0 ? (
        <p role="status" className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>Found {listNames(fleet.candidates.map((candidate) => candidate.preset.displayName))}.</span>
          <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
            onClick={() => void fleet.enableAll()} className={actionClass({ variant: "primary", size: "sm" })}>
            {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
            Bring them in
          </button>
        </p>
      ) : <ConnectInline spaceId={spaceId} token={token} userId={userId} />}
    </div>
  );
}

/* The command and one line under it that follows the connection: waiting,
   the terminal to approve, signing in, looking for agents. */
function ConnectInline({ spaceId, token, userId }: { spaceId: string | null; token: string | null; userId: string }) {
  const intent = useSetupIntent(spaceId, token ?? undefined, userId);
  const [platform, setPlatform] = useState<InstallPlatform>(() =>
    typeof navigator === "undefined" ? "unix" : defaultInstallPlatform(navigator.userAgent));
  const now = useNow(1_000);
  const command = intent.intentId ? setupInstallCommand(intent.intentId, platform) : null;
  const step = intent.status ? connectStep(intent.status, now - intent.shownAt) : null;
  const spinner = <AnimatedIcon icon={Loader2} className="size-3.5 shrink-0 animate-spin" />;
  const line = "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm";
  return (
    <div className="mt-2" data-testid="connect-machine">
      <CommandBlock command={command} />
      {(!step || step.kind === "waiting") && (
        <div className="mt-1.5 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p role="status" className="flex min-w-0 items-center gap-1.5">
            {spinner}
            {step?.kind === "waiting" && step.hint === "try-desktop" ? "Still nothing? The desktop app connects without a terminal."
              : step?.kind === "waiting" && step.hint === "check-terminal" ? "Nothing yet? The terminal says what went wrong."
                : "Waiting for your computer…"}
          </p>
          <button type="button" onClick={() => setPlatform(platform === "windows" ? "unix" : "windows")}
            className="shrink-0 underline-offset-2 hover:text-foreground hover:underline">
            {platform === "windows" ? "macOS or Linux?" : "Windows?"}
          </button>
        </div>
      )}
      {step?.kind === "approval" && (
        <p role="status" className={line}>
          <span><strong>{step.hostname}</strong> wants to connect with code <strong className="font-mono">{step.userCode}</strong>.</span>
          <button type="button" disabled={intent.busy} onClick={() => void intent.approve(step.userCode)}
            className={actionClass({ variant: "primary", size: "sm" })}>Approve</button>
          <button type="button" disabled={intent.busy} onClick={() => void intent.decline()}
            className={actionClass({ variant: "quiet", size: "sm" })}>Not mine</button>
        </p>
      )}
      {step?.kind === "connecting" && <p role="status" className={line}>{spinner} {step.hostname} is signing in…</p>}
      {(step?.kind === "looking" || step?.kind === "found") && (
        <p role="status" className={line}>{spinner} Looking for agents on {step.machineName}…</p>
      )}
      {step?.kind === "none-installed" && (
        <div role="status" className="mt-2 text-sm">
          <p>{step.machineName} has no agent yet. Install one there:</p>
          <AgentInstallPicker className="mt-2" platform={terminalInstallPlatform(intent.status?.terminal?.platform) ?? platform} />
        </div>
      )}
      {intent.error && <p role="alert" className="mt-2 text-sm text-destructive">{intent.error}
        {" "}<button type="button" disabled={intent.busy || intent.retrying} onClick={intent.retry}
          className="font-semibold underline-offset-2 hover:underline">Try again</button></p>}
    </div>
  );
}
