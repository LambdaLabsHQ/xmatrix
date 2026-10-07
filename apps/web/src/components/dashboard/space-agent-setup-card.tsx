"use client";

import { actionClass } from "@/components/ui/action-tone";
import { agentPresetAvatarUrl } from "@xmatrix/protocol";
import { Check, CloudOff, Copy, Download, HardDrive, Loader2, PlayCircle, RefreshCw, Terminal } from "lucide-react";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { noticeClass } from "@/components/ui/status-tone";
import { quickStartRunbookUrl, quickStartSeedPrompt } from "@/lib/quick-start";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { cn } from "@/lib/utils";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import { IdentityAvatar } from "./identity-avatar";
import type {
  SpaceAgentSetupCandidate,
  SpaceAgentSetupState,
} from "./space-agent-setup";

/* The first screen of a Space that has no agent yet. It replaces the bare
   "No channels" empty state: instead of asking the human to understand
   channels and directories first, it reports what is already on this machine
   and offers one action that ends in a working agent. */

const RUNTIME_INSTALL_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "curl -fsSL https://claude.ai/install.sh | bash", description: "Claude Code" },
  { command: "npm i -g @openai/codex", description: "Codex" },
];

/* What runs `xmatrix agent add` for this Space on another machine. The
   Space id is filled in: a placeholder would send the reader looking for an
   id the Web shows nowhere. */
export function agentAddCommand(spaceId: string | null | undefined): string {
  return `xmatrix agent add claude --space ${spaceId || "<space-id>"}`;
}

export function SpaceAgentSetupCard({
  state,
  spaceId,
  hostLabel,
  busy,
  error,
  onBindAgent,
  onStartDaemon,
  onRefresh,
  onRetryAgents,
}: {
  state: SpaceAgentSetupState;
  spaceId: string | null;
  hostLabel: string;
  busy: string | null;
  error: string | null;
  onBindAgent: (candidate: SpaceAgentSetupCandidate) => void;
  onStartDaemon: () => void;
  onRefresh: () => void;
  onRetryAgents: () => void;
}) {
  if (state.kind === "hidden") return null;

  return (
    <SetupCardShell>
        {state.kind === "unreachable" && <UnreachablePanel onRetry={onRetryAgents} />}
        {state.kind === "no-local-machine" && <BringAgentsInPanel spaceId={spaceId} />}
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
              body="Bind one to this space and it can pick up work here. Nothing is installed or changed until you confirm."
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
            <div className="mt-4 grid gap-3">
              {state.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.presetId}
                  candidate={candidate}
                  disabled={state.kind === "daemon-stopped" || Boolean(busy)}
                  onBind={() => onBindAgent(candidate)}
                />
              ))}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Detected on this machine by checking which agent commands are installed. Nothing about
              your projects is read or uploaded by this step. To add a harness from another machine,
              its owner runs{" "}
              <code>{agentAddCommand(spaceId)}</code>
              {" "}there.
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
    <LiquidGlassCard className="app-space-agent-candidate rounded-[20px] p-4">
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
          Add to xMatrix
        </button>
      </div>
    </LiquidGlassCard>
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
      <div className="mt-4 rounded-md border border-border bg-background p-4">
        {RUNTIME_INSTALL_COMMANDS.map((entry) => (
          <div
            key={entry.command}
            className="flex min-w-0 flex-col gap-1 border-t border-border/70 py-3 first:border-t-0 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]">
              {entry.command}
            </code>
            <span className="min-w-0 text-sm text-muted-foreground sm:text-right">{entry.description}</span>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className={actionClass({ variant: "secondary", size: "md" }, "mt-4")}
      >
        <RefreshCw className="size-4" />
        Check again
      </button>
      <RemoteMachineHint />
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

/* Web and mobile: agents are not in this tab, so the one thing to learn here
   is where they are. The desktop app finds the ones already installed; a
   machine with the CLI adds one with a single command. */
export function BringAgentsInPanel({ spaceId }: { spaceId: string | null }) {
  return (
    <>
      <SetupCardHeader
        icon={HardDrive}
        title="Bring your agents into xMatrix"
        body="Your agents run on your own computer, and xMatrix connects them with the people they work with. Open the desktop app on that computer and it finds the agents already installed there."
      />
      <a href="/download" className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
        <Download className="size-4" />
        Download xMatrix
      </a>
      <AgentAddCommand spaceId={spaceId} />
      <RemoteMachineHint />
    </>
  );
}

/* For a machine that already has the CLI: one line, with this Space's id. */
export function AgentAddCommand({ spaceId, centered = false }: { spaceId: string | null; centered?: boolean }) {
  const command = agentAddCommand(spaceId);
  const { copied, copy } = useCopyToClipboard(command);
  return (
    <div className="mt-4">
      <p className="text-sm text-muted-foreground">Already have the xMatrix CLI on that machine? Run:</p>
      <div className={cn("mt-2 flex min-w-0 flex-wrap items-center gap-2", centered && "justify-center")}>
        <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs [overflow-wrap:anywhere]">{command}</code>
        <button type="button" onClick={() => void copy()} className={actionClass({ variant: "secondary", size: "sm" })}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/* The remote path from the landing page: a machine with no GUI (a server, a
   build box) is set up by handing this prompt to an agent that already runs
   there, so it does not need the desktop app at all. */
function RemoteMachineHint() {
  const { copied, copy } = useCopyToClipboard(quickStartSeedPrompt);

  return (
    <div className="mt-4 rounded-md border border-border bg-muted/40 p-4">
      <p className="text-sm font-bold">Setting up a remote machine?</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Paste this prompt to any coding agent that already runs there. It installs the CLI and
        registers the machine without the desktop app.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copy()}
          className={actionClass({ variant: "secondary", size: "md" })}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? "Copied" : "Copy setup prompt"}
        </button>
        <a
          href={quickStartRunbookUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-9 items-center justify-center rounded px-2 text-sm font-bold text-muted-foreground hover:text-foreground"
        >
          Read the steps
        </a>
      </div>
    </div>
  );
}

function describeCandidates(candidates: SpaceAgentSetupCandidate[]): string {
  const [first] = candidates;
  if (!first) return "an agent";
  if (candidates.length === 1) return first.displayName;
  return `${first.displayName} and ${candidates.length - 1} more`;
}
