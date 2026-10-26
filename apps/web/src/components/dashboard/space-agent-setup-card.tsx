"use client";

import { useDesktopDaemonFailureDelivered } from "@/lib/desktop-daemon-failure-report";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { AlertTriangle, Check, CloudOff, Loader2, PlayCircle, RefreshCw, Terminal } from "lucide-react";
import { noticeClass } from "@/components/ui/status-tone";
import type { OnboardingCopy } from "@/lib/onboarding-copy";
import { useOnboardingCopy, useOnboardingLocale } from "@/lib/onboarding-locale";
import { PROBLEM_COPY } from "@/lib/problem-copy";
import { ProblemCard } from "./problem-card";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import { Face } from "./face";
import { defaultInstallPlatform, type InstallPlatform } from "./connect-machine";
import { InstalledHarnessSwitchList } from "./installed-harness-switch-list";
import { AgentInstallPicker } from "./supported-agents";
import { BringAgentsIn, RemoteMachineHint } from "./bring-agents-in";
import type { useInstalledHarnesses } from "./use-installed-harnesses";
import {
  daemonFailureSentence,
  daemonProblem,
  shownDaemonFailure,
  type SpaceAgentSetupCandidate,
  type SpaceAgentSetupState,
} from "./space-agent-setup";
import type { DesktopDaemonFailure, DesktopDaemonStatus } from "@/lib/desktop/bridge";

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
  daemonStatus,
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
  /** The App's background service, when this is the desktop App. */
  daemonStatus?: DesktopDaemonStatus | null;
  /** On a phone: the command is run on a computer, and only approved here. */
  phone?: boolean;
}) {
  const copy = useOnboardingCopy(spaceId, token, userId);
  if (fleet && ((fleet.ready && fleet.candidates.length > 0) || fleet.enablingAll)) return <SetupCardShell>
    <SetupCardHeader title={copy.installedTitle} body={copy.installedBody} />
    <InstalledHarnessSwitchList fleet={fleet} />
    <button type="button" disabled={!fleet.ready || Boolean(fleet.pending) || fleet.enablingAll}
      onClick={onBringAll} className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
      {fleet.enablingAll ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <Check className="size-4" />}
      {fleet.enablingAll ? copy.enabling : copy.bringThemIn}
    </button>
    <button type="button" onClick={onManageMachines} className={actionClass({ variant: "secondary", size: "md" }, "mt-4 ml-2")}>{copy.manageMachines}</button>
  </SetupCardShell>;
  if (state.kind === "hidden") return null;
  const daemonFailure = state.kind === "unreachable" || state.kind === "no-local-machine"
    ? null : shownDaemonFailure(daemonStatus);

  return (
    <SetupCardShell>
        {daemonFailure && state.kind !== "daemon-stopped" && (
          <DaemonFailureNotice copy={copy} failure={daemonFailure} starting={daemonStatus?.state === "starting"} onRetry={onStartDaemon} className="mb-6"
            spaceId={spaceId} token={token} userId={userId} />
        )}
        {state.kind === "unreachable" && <UnreachablePanel copy={copy} onRetry={onRetryAgents} />}
        {/* Web and phone: the same flow xMatrix sends in a welcome conversation. */}
        {state.kind === "no-local-machine" && <BringAgentsIn spaceId={spaceId} token={token} userId={userId} surface="space" phone={phone} />}
        {state.kind === "discovering" && (
          <SetupCardHeader
            icon={Loader2}
            iconClassName="animate-spin"
            title={copy.discoveringTitle}
            body={copy.discoveringBody}
          />
        )}
        {state.kind === "no-runtime" && (
          <NoRuntimePanel copy={copy} hostLabel={hostLabel} onRefresh={onRefresh} />
        )}
        {(state.kind === "daemon-stopped" || state.kind === "ready-to-bind") && (
          <>
            <SetupCardHeader
              title={copy.foundOn(describeCandidates(copy, state.candidates), hostLabel)}
              body={copy.turnOnInstalled}
            />
            {state.kind === "daemon-stopped" && daemonFailure && (
              <DaemonFailureNotice copy={copy} failure={daemonFailure} starting={daemonStatus?.state === "starting"} onRetry={onStartDaemon} className="mt-4"
                spaceId={spaceId} token={token} userId={userId} />
            )}
            {state.kind === "daemon-stopped" && !daemonFailure && (
              <div className={noticeClass("attention", "mt-4 p-3")}>
                <p className="text-sm">
                  {copy.serviceStopped}
                </p>
                <button
                  type="button"
                  onClick={onStartDaemon}
                  className={actionClass({ variant: "primary", size: "md" }, "mt-3")}
                >
                  <PlayCircle className="size-4" />
                  {copy.startIt}
                </button>
              </div>
            )}
            <div className="mt-4">
              {state.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.presetId}
                  candidate={candidate}
                  copy={copy}
                  disabled={state.kind === "daemon-stopped" || Boolean(busy)}
                  onBind={() => onBindAgent(candidate)}
                />
              ))}
            </div>
            <button type="button" disabled={state.kind === "daemon-stopped" || Boolean(busy) || !fleet?.ready}
              onClick={onBringAll} className={actionClass({ variant: "primary", size: "md" }, "mt-4")}>
              <Check className="size-4" /> {copy.bringThemIn}
            </button>
            <p className="mt-4 text-xs text-muted-foreground">
              {copy.detectedBy}
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

/* The background service did not start. A cause its own words name gets a
   problem card that says what happened and how to fix it; anything else says
   what it means for the person. Either way the CLI's last lines (already
   redacted on this machine, and also sent to xMatrix) are folded into
   Details, and Try again starts it once more. */
function DaemonFailureNotice({
  copy,
  failure,
  starting,
  onRetry,
  className,
  spaceId,
  token,
  userId,
}: {
  copy: OnboardingCopy;
  failure: DesktopDaemonFailure;
  starting: boolean;
  onRetry: () => void;
  className?: string;
  spaceId: string | null;
  token: string | undefined;
  userId: string | undefined;
}) {
  const delivered = useDesktopDaemonFailureDelivered(failure);
  const problemCopy = PROBLEM_COPY[useOnboardingLocale(spaceId, token, userId)];
  const problem = daemonProblem(failure);
  const known = problem === "unknown" ? null : problemCopy.daemon[problem];
  return (
    <div className={className} role="alert">
      <ProblemCard icon={<AlertTriangle className="size-[18px]" />}
        title={known?.title ?? daemonFailureSentence(failure, copy)}
        explanation={known?.explanation}
        stepsLabel={problemCopy.stepsLabel} steps={known?.steps ?? []}
        actions={<button type="button" disabled={starting} onClick={onRetry} className={actionClass({ variant: "primary", size: "md" })}>
          {starting ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          {starting ? problemCopy.daemon.tryingAgain : problemCopy.daemon.tryAgain}
        </button>}
        detailsLabel={problemCopy.detailsLabel}
        details={(failure.detail || failure.exitCode !== undefined || delivered) ? <>
          {failure.detail && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{failure.detail}</pre>}
          {failure.exitCode !== undefined && <p>{problemCopy.daemon.exitCode(failure.exitCode)}</p>}
          {delivered && <p>{copy.failureReported}</p>}
        </> : undefined} />
    </div>
  );
}

function CandidateRow({
  candidate,
  copy,
  disabled,
  onBind,
}: {
  candidate: SpaceAgentSetupCandidate;
  copy: OnboardingCopy;
  disabled: boolean;
  onBind: () => void;
}) {
  return (
    <div className="border-b border-border py-4 last:border-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Face
            of={{ kind: "agent", name: candidate.displayName, harness: candidate.presetId }}
            size="md"
            className="app-space-agent-vendor-avatar shrink-0"
          />
          <div className="min-w-0">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="font-black">{candidate.displayName}</span>
              {candidate.usedBefore && (
                <span className="app-space-agent-used-label text-xs font-bold">
                  {copy.usedHere}
                </span>
              )}
            </div>
            {/* Directory names are not listed here. They come from this machine's
                runtime history, which spans every organisation this person works
                for, and this card is rendered inside one Space. The working
                folder is chosen explicitly in the next step. */}
            <p className="mt-2 text-sm text-foreground">
              {copy.chooseFolderLater}
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
          {copy.enable}
        </button>
      </div>
    </div>
  );
}

function NoRuntimePanel({
  copy,
  hostLabel,
  onRefresh,
}: {
  copy: OnboardingCopy;
  hostLabel: string;
  onRefresh: () => void;
}) {
  return (
    <>
      <SetupCardHeader
        icon={Terminal}
        title={copy.noRuntimeTitle(hostLabel)}
        body={copy.noRuntimeBody}
      />
      <AgentInstallPicker className="mt-4" copy={copy} platform={localInstallPlatform()} />
      <button
        type="button"
        onClick={onRefresh}
        className={actionClass({ variant: "secondary", size: "md" }, "mt-4")}
      >
        <RefreshCw className="size-4" />
        {copy.checkAgain}
      </button>
      <div className="mt-6 text-xs text-muted-foreground"><RemoteMachineHint copy={copy} /></div>
    </>
  );
}

/* The registration read failed. This screen deliberately says nothing about
   whether the Space has agents — that is exactly what is not known — and
   reports the one thing that is known instead. */
function UnreachablePanel({ copy, onRetry }: { copy: OnboardingCopy; onRetry: () => void }) {
  return (
    <>
      <SetupCardHeader
        icon={CloudOff}
        title={copy.unreachableTitle}
        body={copy.unreachableBody}
      />
      <button
        type="button"
        onClick={onRetry}
        className={actionClass({ variant: "secondary", size: "md" }, "mt-4")}
      >
        <RefreshCw className="size-4" />
        {copy.tryAgain}
      </button>
    </>
  );
}

function localInstallPlatform(): InstallPlatform {
  return typeof navigator === "undefined" ? "unix" : defaultInstallPlatform(navigator.userAgent);
}

function describeCandidates(copy: OnboardingCopy, candidates: SpaceAgentSetupCandidate[]): string {
  const [first] = candidates;
  if (!first) return copy.anAgent;
  if (candidates.length === 1) return first.displayName;
  return copy.andMore(first.displayName, candidates.length - 1);
}
