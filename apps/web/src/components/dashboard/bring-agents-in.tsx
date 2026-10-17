"use client";

import { useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { quickStartRunbookUrl, quickStartSeedPrompt } from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { CommandBlock } from "./command-block";
import { useNow } from "./agent-work-intent";
import {
  connectStep, defaultInstallPlatform, listNames, setupInstallCommand, terminalInstallPlatform,
  type ConnectStep, type InstallPlatform,
} from "./connect-machine";
import { AgentInstallPicker, AgentsLine } from "./supported-agents";
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

export function BringAgentsIn({ spaceId, token, userId, phone = false }: {
  spaceId: string | null; token: string | null | undefined; userId: string | undefined; phone?: boolean;
}) {
  const intent = useSetupIntent(spaceId, token ?? undefined, userId);
  const fleet = useInstalledHarnesses(spaceId, token, userId);
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

  return (
    <div className="max-w-[34rem] text-[15px] leading-6" data-testid="connect-machine">
      <p>Bring your agents into xMatrix. They keep running on your own computer, and xMatrix connects them to your conversations and pages.</p>
      <AgentsLine className="mt-2" />

      <ol className="m-0 mt-4 list-none border-t-[1px] border-border p-0">
        <SetupRow n={1} state={state(1)} title="Run this on your computer"
          aside={stage === 1 ? (
            <button type="button" onClick={() => setPlatform(platform === "windows" ? "unix" : "windows")}
              className="underline-offset-2 hover:text-foreground hover:underline">
              {platform === "windows" ? "macOS or Linux?" : "Windows?"}
            </button>
          ) : stage > 1 && machines ? machines : null}>
          {stage === 1 && <>
            <CommandBlock command={command} />
            <div role="status" className="mt-2 text-[13px] leading-5 text-muted-foreground">
              <p className="flex items-center gap-1.5">{spinner} Waiting for your computer…</p>
              {step?.kind === "waiting" && step.hint === "check-terminal" && <p>Nothing yet? The terminal says what went wrong.</p>}
              {step?.kind === "waiting" && step.hint === "try-desktop" && <p>Still nothing? The desktop app connects without a terminal.</p>}
            </div>
          </>}
        </SetupRow>

        <SetupRow n={2} state={state(2)} title="Approve it here"
          aside={step?.kind === "connecting" ? <span className="flex items-center gap-1.5">{spinner} Signing in…</span>
            : null}>
          {step?.kind === "approval" && (
            <div role="status">
              <p><strong>{step.hostname}</strong> wants to connect with code <strong className="font-mono">{step.userCode}</strong>.</p>
              <p className="text-[13px] leading-5 text-muted-foreground">Approve it only if the terminal shows the same code.</p>
              <div className="mt-2 flex items-center gap-2">
                <button type="button" disabled={intent.busy} onClick={() => void intent.approve(step.userCode)}
                  className={actionClass({ variant: "primary", size: "sm" })}>Approve</button>
                <button type="button" disabled={intent.busy} onClick={() => void intent.decline()}
                  className={actionClass({ variant: "quiet", size: "sm" })}>Not mine</button>
              </div>
            </div>
          )}
        </SetupRow>

        <SetupRow n={3} state={state(3)} title="Turn on the agents it finds"
          aside={stage === 4 ? listNames(enabled.map((registration) => registration.displayName))
            : stage === 3 && step?.kind === "looking" ? <span className="flex items-center gap-1.5">{spinner} Looking…</span> : null}>
          {stage === 3 && found && (
            <div role="status">
              <p>Found {listNames(fleet.candidates.map((candidate) => candidate.preset.displayName))}.</p>
              <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
                onClick={() => void fleet.enableAll()} className={actionClass({ variant: "primary", size: "sm" }, "mt-2")}>
                {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : null}
                Bring them in
              </button>
            </div>
          )}
          {stage === 3 && !found && step?.kind === "found" && (
            <p role="status">Found {listNames(step.harnesses.map((harness) => harness.name))}.</p>
          )}
          {stage === 3 && !found && step?.kind === "none-installed" && (
            <div role="status">
              <p>{step.machineName} has no agent yet. Install one there and it shows up here:</p>
              <AgentInstallPicker className="mt-2" platform={terminalInstallPlatform(intent.status?.terminal?.platform) ?? platform} />
            </div>
          )}
        </SetupRow>
      </ol>

      {intent.error && <p role="alert" className="mt-2 text-[13px] leading-5 text-destructive">{intent.error}{" "}
        <button type="button" disabled={intent.busy || intent.retrying} onClick={intent.retry}
          className="font-semibold underline-offset-2 hover:underline">Try again</button></p>}
      {stage < 4 && (
        <p className="mt-3 text-[13px] leading-5 text-muted-foreground">
          No terminal?{" "}
          {phone
            ? <>Download the desktop app on that computer from <span className="font-semibold text-foreground">xmatrix.sh/download</span>.</>
            : <><a href="/download" className="font-semibold text-foreground underline-offset-2 hover:underline">Download the desktop app</a>. It finds the agents installed there.</>}
        </p>
      )}
      {stage < 4 && !phone && <div className="text-[13px] leading-5 text-muted-foreground"><RemoteMachineHint /></div>}
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
export function RemoteMachineHint() {
  const { copied, copy } = useCopyToClipboard(quickStartSeedPrompt);
  return (
    <p>
      Setting up a server?{" "}
      <button type="button" onClick={() => void copy()}
        className="font-semibold text-foreground underline-offset-2 hover:underline">
        {copied ? "Copied" : "Copy a setup prompt"}
      </button>{" "}
      for an agent already running there, or{" "}
      <a href={quickStartRunbookUrl} target="_blank" rel="noreferrer"
        className="font-semibold text-foreground underline-offset-2 hover:underline">read the steps</a>.
    </p>
  );
}
