"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { OnboardingSurface } from "@xmatrix/protocol";
import { Check, Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { quickStartRunbookUrl, quickStartSeedPrompt } from "@/lib/quick-start";
import { ONBOARDING_COPY, type OnboardingCopy } from "@/lib/onboarding-copy";
import { useOnboardingSteps } from "@/lib/onboarding-funnel";
import { useOnboardingCopy } from "@/lib/onboarding-locale";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { CommandBlock } from "./command-block";
import { useNow } from "./agent-work-intent";
import {
  connectStep, defaultInstallPlatform, setupInstallCommand, terminalInstallPlatform,
  type ConnectStep, type InstallPlatform,
} from "./connect-machine";
import { AgentInstallPicker, AgentsLine } from "./supported-agents";
import { CandidateUpdateButton } from "./harness-update-button";
import { useInstalledHarnesses } from "./use-installed-harnesses";
import { useSetupIntent } from "./use-setup-intent";

/* Bringing agents in, wherever xMatrix asks for it: in the welcome
   conversation, on an empty Space, in Agents. One left edge, two type sizes,
   and three ruled rows (number, title, status) where only the step in
   progress opens. The command is run on the computer the agents use; the
   terminal it starts is approved here, which may be a phone in the person's
   hand. Every line is read from the facts, so a finished flow stays finished. */

type StepState = "pending" | "active" | "done";
type Stage = 1 | 2 | 3 | 4;

function connectStage(step: ConnectStep | null): Stage {
  if (!step || step.kind === "waiting") return 1;
  return step.kind === "approval" || step.kind === "connecting" ? 2 : 3;
}

export function BringAgentsIn({ spaceId, token, userId, surface, phone = false }: {
  spaceId: string | null; token: string | null | undefined; userId: string | undefined;
  /** Where it is shown, for counting who gets through (onboarding-funnel.ts). */
  surface: OnboardingSurface; phone?: boolean;
}) {
  const intent = useSetupIntent(spaceId, token ?? undefined, userId);
  const fleet = useInstalledHarnesses(spaceId, token, userId);
  const copy = useOnboardingCopy(spaceId, token, userId);
  const { listNames } = copy;
  const [platform, setPlatform] = useState<InstallPlatform>(() =>
    typeof navigator === "undefined" ? "unix" : defaultInstallPlatform(navigator.userAgent));
  const now = useNow(1_000);
  const command = intent.intentId ? setupInstallCommand(intent.intentId, platform) : null;
  const step = intent.status ? connectStep(intent.status, now - intent.shownAt) : null;
  const enabled = (fleet.catalog.data?.registrations ?? []).filter((registration) => registration.state === "enabled");
  const found = fleet.ready && fleet.candidates.length > 0;
  const stage: Stage = enabled.length > 0 ? 4 : found ? 3 : connectStage(step);
  const state = (n: number): StepState => stage > n ? "done" : stage === n ? "active" : "pending";
  const spinner = <AnimatedIcon icon={Loader2} className="size-3.5 shrink-0 animate-spin" />;
  const machines = listNames([...new Set([...enabled, ...fleet.candidates].map((item) => item.machineName))]);
  const count = useOnboardingSteps(token, surface);
  useEffect(() => { if (stage === 1 && command) count("command_shown"); }, [stage, command, count]);
  useEffect(() => { if (step?.kind === "approval") count("terminal_seen"); }, [step?.kind, count]);

  return (
    <div className="max-w-[34rem] text-[15px] leading-6" data-testid="connect-machine">
      <p>{copy.bringAgents}</p>
      <AgentsLine className="mt-2" copy={copy} />

      <ol className="m-0 mt-4 list-none border-t-[1px] border-border p-0">
        <SetupRow n={1} state={state(1)} title={copy.runCommand}
          aside={stage === 1 ? (
            <button type="button" onClick={() => setPlatform(platform === "windows" ? "unix" : "windows")}
              className="underline-offset-2 hover:text-foreground hover:underline">
              {copy.otherPlatform(platform === "windows")}
            </button>
          ) : stage > 1 && machines ? machines : null}>
          {stage === 1 && <>
            <CommandBlock command={command} copy={copy} onCopy={() => count("command_copied")} />
            <div role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">
              <p className="flex items-center gap-1.5">{spinner} {copy.waitingForComputer}</p>
              {step?.kind === "waiting" && step.hint === "check-terminal" && <p>{copy.checkTerminal}</p>}
              {step?.kind === "waiting" && step.hint === "try-desktop" && <p>{copy.tryDesktop}</p>}
            </div>
          </>}
        </SetupRow>

        <SetupRow n={2} state={state(2)} title={copy.approveHere}
          aside={step?.kind === "connecting" ? <span className="flex items-center gap-1.5">{spinner} {copy.signingIn}</span>
            : null}>
          {step?.kind === "approval" && (
            <div role="status">
              <p><strong>{step.hostname}</strong>{copy.wantsToConnect[0]}<strong
                className="font-mono">{step.userCode}</strong>{copy.wantsToConnect[1]}</p>
              <p className="text-[13px] leading-5 text-muted-foreground">{copy.sameCodeOnly}</p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" disabled={intent.busy} onClick={() => { count("approved"); void intent.approve(step.userCode); }}
                  className={actionClass({ variant: "primary", size: "sm" })}>{copy.approve}</button>
                <button type="button" disabled={intent.busy} onClick={() => void intent.decline()}
                  className={actionClass({ variant: "quiet", size: "sm" })}>{copy.notMine}</button>
              </div>
            </div>
          )}
        </SetupRow>

        <SetupRow n={3} state={state(3)} title={copy.turnOnFound}
          aside={stage === 4 ? listNames(enabled.map((registration) => registration.displayName))
            : stage === 3 && step?.kind === "looking" ? <span className="flex items-center gap-1.5">{spinner} {copy.looking}</span> : null}>
          {stage === 3 && found && (
            <div role="status">
              <p>{copy.found(listNames(fleet.candidates.map((candidate) => candidate.preset.displayName)))}</p>
              <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
                onClick={() => void fleet.enableAll()} className={actionClass({ variant: "primary", size: "sm" }, "mt-2")}>
                {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
                {copy.bringThemIn}
              </button>
              {fleet.candidates.map((candidate) => candidate.tooOld && (
                <div key={candidate.id} className="mt-3 text-[13px] leading-5 text-muted-foreground">
                  <p>{copy.tooOld(candidate.tooOld)}{copy.gap}{copy.nothingUntilUpdated}</p>
                  {candidate.daemon.status === "online" && (
                    <div className="mt-1.5"><CandidateUpdateButton fleet={fleet} candidate={candidate} tooOld={candidate.tooOld} /></div>
                  )}
                </div>
              ))}
            </div>
          )}
          {stage === 3 && !found && step?.kind === "found" && (
            <p role="status">{copy.found(listNames(step.harnesses.map((harness) => harness.name)))}</p>
          )}
          {stage === 3 && !found && step?.kind === "none-installed" && (
            <div role="status">
              <p>{copy.noAgentYet(step.machineName)}</p>
              <AgentInstallPicker className="mt-2" copy={copy}
                platform={terminalInstallPlatform(intent.status?.terminal?.platform) ?? platform} />
            </div>
          )}
        </SetupRow>
      </ol>

      {intent.error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">{intent.error}{" "}
        <button type="button" disabled={intent.busy || intent.retrying} onClick={intent.retry}
          className="font-semibold underline-offset-2 hover:underline">{copy.tryAgain}</button></p>}
      {stage < 4 && (
        <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
          {copy.noTerminal}{copy.gap}
          {phone
            ? <>{copy.phoneDownload[0]}<span className="font-semibold text-foreground">{copy.phoneDownload[1]}</span>{copy.phoneDownload[2]}</>
            : <><a href="/download" onClick={() => count("download_clicked")}
              className="font-semibold text-foreground underline-offset-2 hover:underline">{copy.download[0]}</a>{copy.download[1]}</>}
        </p>
      )}
      {stage < 4 && !phone && <div className="text-[13px] leading-5 text-muted-foreground"><RemoteMachineHint copy={copy} /></div>}
    </div>
  );
}

/* A ruled row: the number (or a check once done), the title, and what is
   happening now on the right. Only the step in progress opens. */
function SetupRow({ n, state, title, aside, children }: {
  n: number; state: StepState; title: string; aside?: ReactNode; children?: ReactNode;
}) {
  const open = Boolean(children) && state === "active";
  return (
    <li className="m-0 grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b-[1px] border-border px-0 py-3"
      data-state={state}>
      <span aria-hidden="true" className="text-[13px] font-semibold tabular-nums text-muted-foreground">
        {state === "done" ? <Check className="inline size-3.5 align-[-2px] text-foreground" strokeWidth={3} /> : n}
      </span>
      <p className={cn("font-semibold", state === "pending" && "text-muted-foreground")}>{title}</p>
      <span className="text-right text-[13px] leading-5 text-muted-foreground">{aside}</span>
      {open && <div className="col-start-2 col-end-4 mt-2">{children}</div>}
    </li>
  );
}

/* The remote path from the landing page: a machine with no GUI (a server, a
   build box) is set up by handing this prompt to an agent that already runs
   there, so it does not need the desktop app at all. */
export function RemoteMachineHint({ copy: words = ONBOARDING_COPY.en }: { copy?: OnboardingCopy }) {
  const { copied, copy } = useCopyToClipboard(quickStartSeedPrompt);
  const [ask, action, middle, steps, end] = words.server(copied);
  return (
    <p>
      {ask}
      <button type="button" onClick={() => void copy()}
        className="font-semibold text-foreground underline-offset-2 hover:underline">
        {action}
      </button>
      {middle}
      <a href={quickStartRunbookUrl} target="_blank" rel="noreferrer"
        className="font-semibold text-foreground underline-offset-2 hover:underline">{steps}</a>{end}
    </p>
  );
}
