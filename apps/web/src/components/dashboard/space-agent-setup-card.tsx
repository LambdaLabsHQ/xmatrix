"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { actionClass } from "@/components/ui/action-tone";
import { agentPresetAvatarUrl } from "@xmatrix/protocol";
import { Check, CloudOff, Loader2, PlayCircle, RefreshCw, Terminal } from "lucide-react";
import { noticeClass } from "@/components/ui/status-tone";
import { quickStartRunbookUrl, quickStartSeedPrompt } from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import { IdentityAvatar } from "./identity-avatar";
import { useNow } from "./agent-work-intent";
import {
  connectStep, defaultInstallPlatform, listNames, setupInstallCommand, terminalInstallPlatform,
  type ConnectStep, type InstallPlatform,
} from "./connect-machine";
import { useSetupIntent } from "./use-setup-intent";
import { InstalledHarnessSwitchList } from "./installed-harness-switch-list";
import { AgentInstallPicker, SupportedAgents } from "./supported-agents";
import { CommandBlock } from "./command-block";
import type { useInstalledHarnesses } from "./use-installed-harnesses";
import type {
  SpaceAgentSetupCandidate,
  SpaceAgentSetupState,
} from "./space-agent-setup";

/* The first screen of a Space that has no agent yet. It replaces the bare
   "No conversations yet" empty state: instead of asking the human to understand
   channels and directories first, it reports what is already on this machine
   and offers one action that ends in a working agent. */

/* What runs `xmatrix agent add` for this Space on another machine. The
   Space id is filled in: a placeholder would send the reader looking for an
   id the Web shows nowhere. */
export function agentAddCommand(spaceId: string | null | undefined): string {
  return `xmatrix agent add claude --space ${spaceId || "<space-id>"}`;
}

export function SpaceAgentSetupCard({
  state,
  spaceId,
  token,
  userId,
  hostLabel,
  busy,
  error,
  onBindAgent,
  onStartDaemon,
  onRefresh,
  onRetryAgents,
  fleet,
  onBringAll,
  onManageMachines,
  phone = false,
}: {
  state: SpaceAgentSetupState;
  spaceId: string | null;
  token: string | undefined;
  userId: string | undefined;
  hostLabel: string;
  busy: string | null;
  error: string | null;
  onBindAgent: (candidate: SpaceAgentSetupCandidate) => void;
  onStartDaemon: () => void;
  onRefresh: () => void;
  onRetryAgents: () => void;
  fleet?: ReturnType<typeof useInstalledHarnesses>;
  onBringAll: () => void;
  onManageMachines: () => void;
  /** On a phone: the command is run on a computer, and only approved here. */
  phone?: boolean;
}) {
  if (fleet && ((fleet.ready && fleet.candidates.length > 0) || fleet.enablingAll)) return <SetupCardShell>
    <SetupCardHeader title="Your installed agents" body="Turn them on to summon them. Choose a working folder when you send the first task." />
    <InstalledHarnessSwitchList fleet={fleet} />
    <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
      onClick={onBringAll} className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
      {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Check className="size-4" />}
      {fleet.enablingAll ? "Enabling…" : "Bring them in"}
    </button>
    <button type="button" onClick={onManageMachines} className={actionClass({ variant: "secondary", size: "md" }, "mt-4 ml-2")}>Manage machines</button>
  </SetupCardShell>;
  if (state.kind === "hidden") return null;

  return (
    <SetupCardShell>
        {state.kind === "unreachable" && <UnreachablePanel onRetry={onRetryAgents} />}
        {state.kind === "no-local-machine" && <BringAgentsInPanel spaceId={spaceId} token={token} userId={userId} phone={phone} />}
        {state.kind === "discovering" && (
          <SetupCardHeader
            icon={Loader2}
            iconClassName="animate-spin"
            title="Looking for agents on this machine"
            body="Checking which agent runtimes are installed and which directories they have worked in."
          />
        )}
        {state.kind === "no-runtime" && (
          <NoRuntimePanel hostLabel={hostLabel} onRefresh={onRefresh} />
        )}
        {(state.kind === "daemon-stopped" || state.kind === "ready-to-bind") && (
          <>
            <SetupCardHeader
              title={`Found ${describeCandidates(state.candidates)} on ${hostLabel}`}
              body="Turn on the installed agents so they can take work."
            />
            {state.kind === "daemon-stopped" && (
              <div className={noticeClass("attention", "mt-4 p-3")}>
                <p className="text-sm">
                  The background service that launches agents on this machine is not running yet.
                </p>
                <button
                  type="button"
                  onClick={onStartDaemon}
                  className={actionClass({ variant: "primary", size: "md" }, "mt-3")}
                >
                  <PlayCircle className="size-4" />
                  Start it
                </button>
              </div>
            )}
            <div className="mt-4">
              {state.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.presetId}
                  candidate={candidate}
                  disabled={state.kind === "daemon-stopped" || Boolean(busy)}
                  onBind={() => onBindAgent(candidate)}
                />
              ))}
            </div>
            <button type="button" disabled={state.kind === "daemon-stopped" || Boolean(busy) || !fleet?.ready}
              onClick={onBringAll} className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
              <Check className="size-4" /> Bring them in
            </button>
            <p className="mt-4 text-xs text-muted-foreground">
              Detected by checking installed commands. Manage installed harnesses and their Space switches from Machines.
            </p>
          </>
        )}
        {error && (
          <p className="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}
    </SetupCardShell>
  );
}

function CandidateRow({
  candidate,
  disabled,
  onBind,
}: {
  candidate: SpaceAgentSetupCandidate;
  disabled: boolean;
  onBind: () => void;
}) {
  return (
    <div className="border-b border-border py-4 last:border-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <IdentityAvatar
            kind="agent"
            label={candidate.displayName}
            imageUrl={agentPresetAvatarUrl(candidate.presetId)}
            initials={candidate.displayName.slice(0, 2)}
            size="md"
            className="app-space-agent-vendor-avatar shrink-0"
          />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-black">{candidate.displayName}</span>
              {candidate.usedBefore && (
                <span className="app-space-agent-used-label text-xs font-bold">
                  used on this machine
                </span>
              )}
            </div>
            {/* Directory names are not listed here. They come from this machine's
                runtime history, which spans every organisation this person works
                for, and this card is rendered inside one Space. The working
                folder is chosen explicitly in the next step. */}
            <p className="mt-2 text-sm text-foreground">
              You will choose the folder it works in when you send the first task.
            </p>
          </div>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onBind}
          className={actionClass({ variant: "primary", size: "md" })}
        >
          <Check className="size-4" />
          Enable
        </button>
      </div>
    </div>
  );
}

function NoRuntimePanel({
  hostLabel,
  onRefresh,
}: {
  hostLabel: string;
  onRefresh: () => void;
}) {
  return (
    <>
      <SetupCardHeader
        icon={Terminal}
        title={`No agent runtime found on ${hostLabel}`}
        body="xMatrix launches an agent CLI that already lives on a machine — it does not ship one. Install one here, or point xMatrix at the machine you actually code on."
      />
      <AgentInstallPicker className="mt-4" platform={localInstallPlatform()} />
      <button
        type="button"
        onClick={onRefresh}
        className={actionClass({ variant: "secondary", size: "md" }, "mt-4")}
      >
        <RefreshCw className="size-4" />
        Check again
      </button>
      <div className="mt-6 text-xs text-muted-foreground"><RemoteMachineHint /></div>
    </>
  );
}

/* The registration read failed. This screen deliberately says nothing about
   whether the Space has agents — that is exactly what is not known — and
   reports the one thing that is known instead. */
function UnreachablePanel({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <SetupCardHeader
        icon={CloudOff}
        title="Cannot reach xMatrix right now"
        body="This Space's agents could not be loaded, so nothing here is up to date. Your agents and their work are unaffected — this is a connection problem, not a change to the Space."
      />
      <button
        type="button"
        onClick={onRetry}
        className={actionClass({ variant: "secondary", size: "md" }, "mt-4")}
      >
        <RefreshCw className="size-4" />
        Try again
      </button>
    </>
  );
}

/* Web and phone: agents are not in this tab, so the one thing to learn here
   is how to bring them in. Whoever uses an agent CLI already has a terminal
   open, so one pasted command comes first, and the terminal it runs in is
   approved on this page, which may be the phone in the person's hand. The
   desktop app, which finds installed agents without a terminal, is the
   quieter way in. */
export function BringAgentsInPanel({ spaceId, token, userId, phone = false }: {
  spaceId: string | null; token: string | undefined; userId: string | undefined; phone?: boolean;
}) {
  return (
    <div data-testid="bring-agents-in">
      <h2 className="text-lg font-black leading-tight">Bring your agents into xMatrix</h2>
      <p className="mt-1 text-sm text-muted-foreground">Works with the agent you already use.</p>
      <SupportedAgents className="mt-3" />
      <ConnectMachine spaceId={spaceId} token={token} userId={userId} />
      <div className="mt-7 space-y-1 text-xs text-muted-foreground">
        <p>
          Prefer an app?{" "}
          {phone
            ? <>Download it on that computer from <span className="font-semibold text-foreground">xmatrix.sh/download</span>.</>
            : <a href="/download" className="font-semibold text-foreground underline-offset-2 hover:underline">Download xMatrix</a>}
        </p>
        {!phone && <RemoteMachineHint />}
      </div>
    </div>
  );
}

function localInstallPlatform(): InstallPlatform {
  return typeof navigator === "undefined" ? "unix" : defaultInstallPlatform(navigator.userAgent);
}

type StepState = "pending" | "active" | "done";

/* Which of the three steps the connection is on: the command, its approval,
   and the agents its machine reports. */
function connectStage(step: ConnectStep | null): 1 | 2 | 3 {
  if (!step || step.kind === "waiting") return 1;
  return step.kind === "approval" || step.kind === "connecting" ? 2 : 3;
}

function stepState(stage: number, n: number): StepState {
  return stage > n ? "done" : stage === n ? "active" : "pending";
}

/* One command for the machine, then what happened to it, as it happens: the
   terminal asking to be approved, the machine coming online and the agents it
   has. Each step shows only the line it needs now. Once the agents are
   reported, the installed-agent switches take over. */
export function ConnectMachine({ spaceId, token, userId }: {
  spaceId: string | null; token: string | undefined; userId: string | undefined;
}) {
  const intent = useSetupIntent(spaceId, token, userId);
  const [platform, setPlatform] = useState<InstallPlatform>(() => localInstallPlatform());
  const now = useNow(1_000);
  const command = intent.intentId ? setupInstallCommand(intent.intentId, platform) : null;
  const step = intent.status ? connectStep(intent.status, now - intent.shownAt) : null;
  const stage = connectStage(step);
  const installPlatform = terminalInstallPlatform(intent.status?.terminal?.platform) ?? platform;
  const spinner = <AnimatedIcon icon={Loader2} className="size-3.5 shrink-0 animate-spin" />;
  return (
    <ol className="mt-6 space-y-5" data-testid="connect-machine">
      <SetupStep n={1} state={stepState(stage, 1)} title="Run this on your computer">
        {stage === 1 && <>
          <CommandBlock command={command} />
          <button type="button" onClick={() => setPlatform(platform === "windows" ? "unix" : "windows")}
            className="mt-1.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {platform === "windows" ? "On macOS or Linux?" : "On Windows?"}
          </button>
          {step?.kind === "waiting" && (
            <div role="status" className="mt-2 text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5">{spinner} Waiting for the command…</p>
              {step.hint === "check-terminal" && <p className="mt-1">Nothing yet? The terminal says what went wrong.</p>}
              {step.hint === "try-desktop" && <p className="mt-1">Still nothing? The desktop app connects without a terminal.</p>}
            </div>
          )}
        </>}
      </SetupStep>
      <SetupStep n={2} state={stepState(stage, 2)} title="Approve it here">
        {step?.kind === "approval" && (
          <div role="status">
            <p className="text-sm"><strong>{step.hostname}</strong> wants to connect with code</p>
            <p className="mt-1 font-mono text-base font-bold tracking-[0.06em]">{step.userCode}</p>
            <p className="mt-1 text-xs text-muted-foreground">Approve it only if the terminal shows the same code.</p>
            <div className="mt-3 flex items-center gap-2">
              <button type="button" disabled={intent.busy} onClick={() => void intent.approve(step.userCode)}
                className={actionClass({ variant: "primary", size: "sm" })}>Approve</button>
              <button type="button" disabled={intent.busy} onClick={() => void intent.decline()}
                className={actionClass({ variant: "quiet", size: "sm" })}>Not mine</button>
            </div>
          </div>
        )}
        {step?.kind === "connecting" && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">{spinner} {step.hostname} is signing in…</p>
        )}
      </SetupStep>
      <SetupStep n={3} state={stepState(stage, 3)} title="Turn on the agents it finds">
        {step?.kind === "looking" && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-muted-foreground">{spinner} {step.machineName} is connected. Looking for agents…</p>
        )}
        {step?.kind === "found" && (
          <p role="status" className="text-xs text-muted-foreground">
            {step.machineName} is connected. Found {listNames(step.harnesses.map((harness) => harness.name))}.
          </p>
        )}
        {step?.kind === "none-installed" && (
          <div role="status">
            <p className="text-xs text-muted-foreground">{step.machineName} is connected, but no agent is installed there yet. Install one there and it shows up here.</p>
            <AgentInstallPicker className="mt-3" platform={installPlatform} />
          </div>
        )}
      </SetupStep>
      {intent.error && <li className="list-none">
        <p role="alert" className="text-sm text-destructive">{intent.error}</p>
        <button type="button" disabled={intent.busy || intent.retrying} onClick={intent.retry}
          className={actionClass({ variant: "secondary", size: "sm" }, "mt-2")}>
          <RefreshCw className="size-4" /> Try again
        </button>
      </li>}
    </ol>
  );
}

/* A numbered step of one action. Done steps keep their line short, so the
   card only ever grows where the person is. */
function SetupStep({ n, state, title, children }: {
  n: number; state: StepState; title: string; children?: React.ReactNode;
}) {
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-x-3" data-state={state}>
      <span aria-hidden="true" className={cn(
        "flex size-6 items-center justify-center rounded-[999px] text-xs font-bold",
        state === "done" ? "bg-foreground text-background"
          : state === "active" ? "border-[1.5px] border-foreground text-foreground"
            : "border-[1px] border-border text-muted-foreground",
      )}>
        {state === "done" ? <Check className="size-3.5" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0">
        <p className={cn("flex min-h-6 items-center text-sm font-semibold", state === "pending" && "text-muted-foreground")}>{title}</p>
        {children && <div className="mt-2">{children}</div>}
      </div>
    </li>
  );
}

/* The remote path from the landing page: a machine with no GUI (a server, a
   build box) is set up by handing this prompt to an agent that already runs
   there, so it does not need the desktop app at all. */
function RemoteMachineHint() {
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

function describeCandidates(candidates: SpaceAgentSetupCandidate[]): string {
  const [first] = candidates;
  if (!first) return "an agent";
  if (candidates.length === 1) return first.displayName;
  return `${first.displayName} and ${candidates.length - 1} more`;
}
