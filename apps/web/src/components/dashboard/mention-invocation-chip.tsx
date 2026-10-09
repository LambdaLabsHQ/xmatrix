"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode, type Dispatch, type SetStateAction } from "react";
import { Popover } from "@base-ui/react/popover";
import { LiquidGlassCard } from "@/components/ui/material-surfaces";
import { Check, CircleHelp, Clock3, LoaderCircle, TriangleAlert, X, Zap } from "lucide-react";
import { preparationFailureSummary, WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { useAuth } from "@/lib/auth-context";
import { useXMatrixQueryFetch } from "@/lib/query/use-query-fetch";
import { declinedIntentCopy, type DeclinedIntent } from "./summon-intent";
import { noteJevReading } from "./jev-filled-tags";
import type { AgentStopInvocation, LaunchParameterEvidence, SerializedAgentMessageExecution, SerializedAgentStop, AgentLaunchActivity, SerializedAgentContinuation, SerializedAgentInvocationRejection, SerializedAgentLaunch } from "@xmatrix/protocol";
import { summonView, invocationChipStatus, invocationVendorIcon, operationFailureStageLabel, continuationView, handoffView, stopView, STOP_RECEIPT_PENDING_MS, type InvocationView, type InvocationStep } from "./mention-invocation-state";
import { LoadingImage } from "@/components/dashboard/content-skeleton";
import { avatarImageSrc } from "./identity-avatar";
import { formatZonedDateTime } from "./time-display";
import { JevDecisionFiles, JevDecisionSection, useJevDecisions } from "./summon-decision-records";
import { MentionReplyRecovery } from "./mention-reply-recovery";
import { parsePresentedRoutingDecision, RoutingDecisionBoard, routingSelectionNote } from "./routing-decision-board";
import { HandoffArrowLabel } from "./handoff-arrow";
import { useAppPortalContainer } from "./app-portal-container";

const InvocationPopoverContext = createContext<{
  openId: string | null; setOpenId: Dispatch<SetStateAction<string | null>>;
} | null>(null);

export function InvocationPopoverGroup({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const value = useMemo(() => ({ openId, setOpenId }), [openId]);
  return <InvocationPopoverContext.Provider value={value}>{children}</InvocationPopoverContext.Provider>;
}

function InvocationRuntimeDetails({ activity, view, unavailable }: {
  activity?: AgentLaunchActivity; view: InvocationView; unavailable?: boolean;
}) {
  return <>
    {activity?.operationFailure?.originStage && activity.operationFailure.originStage !== activity.operationFailure.stage &&
      <p className="app-invocation-description">Origin: {operationFailureStageLabel(activity.operationFailure.originStage)}.</p>}
    {activity?.connectionRetry && <p className="app-invocation-description">
      {activity.connectionRetry.kind === "channel_join" ? "Channel join retries"
        : activity.connectionRetry.kind === "credential_refresh" ? "Credential refresh retries" : "Connection retries"}: {activity.connectionRetry.attempt}.
      {activity.connectionRetry.nextAttemptAt && !view.terminal && !unavailable && !activity.evidenceStale && <> Next attempt scheduled for {formatZonedDateTime(activity.connectionRetry.nextAttemptAt)}.</>}
    </p>}
    {activity?.observedAt && <p className="app-invocation-description">Machine evidence updated {formatZonedDateTime(activity.observedAt)}.</p>}
  </>;
}

function RepositoryBaselineDetails({ baseline }: { baseline: NonNullable<AgentLaunchActivity["repositoryBaseline"]> }) {
  return <div className="app-invocation-description">
    <p>Checkout base: <code>{baseline.baseRef} @ {baseline.baseOid}</code></p>
    <p>{baseline.confirmedAt ? `Confirmed ${baseline.confirmedAt} (UTC).` : "Original confirmation time unavailable."}</p>
    {baseline.historyRewritten === true && <p>The previous tip of this same remote branch was replaced or rolled back.</p>}
    {baseline.remote && <p>Remote snapshot: <code>{baseline.remote.baseRef} @ {baseline.remote.baseOid}</code><br />
      Confirmed {baseline.remote.confirmedAt} (UTC).</p>}
    {baseline.relationship === "diverged" && <p>The recorded base is outside the confirmed remote history. The checkout was preserved.</p>}
    {baseline.relationship === "ancestor" && <p>The recorded base is an ancestor of this remote snapshot.</p>}
    {baseline.relationship === "unknown" && <p>Could not confirm whether the recorded base belongs to the current remote history.</p>}
  </div>;
}

export function MentionContinuationChip({ record, unavailable }: { record: SerializedAgentContinuation; unavailable?: boolean }) {
  const view = continuationView(record, unavailable);
  const label = record.sourceName + record.sourceMention.slice(record.sourceName.length + 1);
  const handoff = record.kind === "handoff";
  return <InvocationChip label={label} name={record.sourceName}
    variant={handoff ? "handoff" : undefined}
    labelContent={handoff ? <HandoffArrowLabel sourceName={record.sourceName} sourceOrdinal={record.sourceOrdinal}
      successorName={record.targetName} successorAvatarUrl={record.targetAvatarUrl}
      view={handoffView(record, { auto: false, fresh: false, unavailable })} /> : undefined}
    destinationName={record.kind === "handoff" ? record.targetName : undefined}
    imageSrc={record.kind === "reborn" ? avatarImageSrc(record.targetAvatarUrl) : undefined}
    sourceAddress={record.sourceMention} view={view}
    errorCode={record.activity?.errorCode || record.reborn?.errorCode} diagnosticId={record.activity?.diagnosticId}
    subtitle={`${record.kind === "reborn" ? "Restart" : `Handoff to @${record.targetName}`} · ${record.activity?.hostName || "Selected machine"}`}
    details={<>
      <InvocationRuntimeDetails activity={view.terminal ? undefined : record.activity} view={view} unavailable={unavailable} />
      {record.activity?.repositoryBaseline && <RepositoryBaselineDetails baseline={record.activity.repositoryBaseline} />}
      <code>Successor: {record.runId}</code><code>Predecessor: {record.sourceRunId}</code>
    </>} />;
}

export function MentionInvocationChip({ label, labelContent, announcement, imageSrc, launch, shared, unavailable, onRetry, executions = [] }: {
  label: string;
  /** The address drawn with its own parts marked up; `label` still carries the plain text. */
  labelContent?: ReactNode;
  /** Parameters Jev filled, spoken with the address. The stored message is unchanged. */
  announcement?: string;
  imageSrc?: string | null; launch: SerializedAgentLaunch; shared: boolean;
  executions?: readonly SerializedAgentMessageExecution[];
  unavailable?: boolean; onRetry?: (launch: SerializedAgentLaunch) => Promise<void>;
}) {
  const decision = parsePresentedRoutingDecision(launch.routingDecision);
  const summon = summonView(launch, executions, unavailable);
  const selection = routingSelectionNote(decision);
  const lead = summon.steps.findIndex(step => step.label === "Environment selected");
  const view = { ...summon, steps: summon.steps.map((step, index) => index === lead && selection ? { ...step, note: selection } : step) };
  const activity = launch.activity;
  const execution = executions.find(record => record.executionId === view.executionId && record.runId === launch.runId);
  const icon = imageSrc ?? avatarImageSrc(invocationVendorIcon({
    targetAvatarUrl: launch.targetAvatarUrl, sourceMention: launch.sourceMention || `@${label}`,
    targetName: launch.targetName, routingDecision: launch.routingDecision,
  }));
  return <InvocationChip label={label} labelContent={labelContent} announcement={announcement} name={launch.targetName || label} imageSrc={icon}
    view={view} sourceAddress={launch.sourceMention || `@${label}`}
    subtitle={launch.activity?.hostName || "Selected machine"}
    invocationId={launch.launchId} errorCode={activity?.errorCode || launch.errorCode}
    diagnosticId={activity?.diagnosticId}
    onRetry={launch.state === "failed" && launch.retryable && onRetry && !unavailable ? () => onRetry(launch) : undefined}
    context={<>
      {shared && <p className="app-invocation-description">This mention shares the first invocation of this agent and lifecycle in this message.</p>}
      {execution && !unavailable && <MentionReplyRecovery key={execution.id} execution={execution} />}
    </>}
    jev={{ channelId: launch.channelId, messageId: launch.sourceMessageId, sourceMention: launch.sourceMention || `@${label}`,
      ...(decision?.parameters ? { parameters: decision.parameters } : {}) }}
    details={<>
      {decision && <RoutingDecisionBoard decision={decision} evidenceOnly />}
      <InvocationRuntimeDetails activity={view.terminal ? undefined : activity} view={view} unavailable={unavailable} />
      {activity?.repositoryBaseline && <RepositoryBaselineDetails baseline={activity.repositoryBaseline} />}
      {launch.attempt > 0 && <p className="app-invocation-description">Command delivery retries: {launch.attempt}</p>}
    </>} />;
}

export function MentionInvocationRejectionChip({ rejection, unavailable, labelContent, announcement }: {
  rejection: SerializedAgentInvocationRejection; unavailable?: boolean; labelContent?: ReactNode; announcement?: string;
}) {
  const decision = parsePresentedRoutingDecision(rejection.routingDecision);
  const ordinal = rejection.invocationId.split(":").at(-1);
  const decisionInvocationId = rejection.code === "routing_parameter_selection_failed" && ordinal !== undefined
    ? `auto:${rejection.sourceMessageId}:${ordinal}` : undefined;
  return <InvocationChip label={rejection.sourceMention.replace(/^[@＠]/u, "")} name={rejection.targetRef}
    labelContent={labelContent} announcement={announcement} sourceAddress={rejection.sourceMention}
    imageSrc={avatarImageSrc(invocationVendorIcon({
      sourceMention: rejection.sourceMention, targetName: rejection.targetRef, routingDecision: rejection.routingDecision,
    }))}
    subtitle={rejection.code === "registration_daemon_offline" ? "This machine is offline"
      : rejection.code.startsWith("routing_") ? "Rejected before launch allocation" : "No new process was started"}
    invocationId={rejection.invocationId} errorCode={rejection.code}
    jev={{ channelId: rejection.channelId, messageId: rejection.sourceMessageId, sourceMention: rejection.sourceMention,
      invocationId: decisionInvocationId, rejectedAt: rejection.rejectedAt }}
    context={<>
      {decision && <RoutingDecisionBoard decision={decision} compact />}
    </>}
    view={{ ...invocationChipStatus("Failed",
      unavailable ? `${rejection.message} Status could not be refreshed; this is the last confirmed outcome.` : rejection.message),
      terminal: true, steps: [] }} />;
}

/** Jev's confidence in its reading, from the retained decision record. The
 *  records are the author's; anyone else simply sees the reading without it. */
function useDeclinedIntentConfidence(channelId: string, messageId: string, category: DeclinedIntent, enabled: boolean) {
  const { user } = useAuth();
  const fetcher = useXMatrixQueryFetch(user?.id ?? "");
  const [confidence, setConfidence] = useState<number>();
  const load = useCallback(async () => {
    const route = WEB_PROXY_ROUTES.channel_message_decision_evidence(channelId, messageId);
    const list = await fetcher(route, { cache: "no-store" });
    if (!list.ok) return;
    const { records } = await list.json() as { records: Array<{ refId: string; createdAt: string }> };
    const results = records.filter(record => record.refId.endsWith(":succeeded"))
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
    for (const record of results.slice(0, 5)) {
      const detail = await fetcher(`${route}?refId=${encodeURIComponent(record.refId)}`, { cache: "no-store" });
      if (!detail.ok) continue;
      const intent = (await detail.json() as { answers?: { intent?: { choice?: unknown; probabilities?: Record<string, unknown> } } }).answers?.intent;
      const probability = intent?.choice === category ? intent.probabilities?.[category] : undefined;
      if (typeof probability === "number" && Number.isFinite(probability)) { setConfidence(probability); return; }
    }
  }, [category, channelId, fetcher, messageId]);
  useEffect(() => { if (enabled && user && confidence === undefined) void load().catch(() => undefined); },
    [confidence, enabled, load, user]);
  return confidence;
}

/** The dotted underline a hint settles into, and the card that opens from it.
 *  A span, not a button: a button is always an atomic box, so the mention
 *  could not wrap with the prose it settled back into. */
function useMentionProseCard() {
  const group = useContext(InvocationPopoverContext);
  const popoverId = useId();
  const portal = useAppPortalContainer();
  return { group, popoverId, portal, open: group?.openId === popoverId };
}

function MentionProseCard({ card, sourceMention, labelContent, title, ariaLabel, className, launching, children }: {
  card: ReturnType<typeof useMentionProseCard>;
  sourceMention: string; labelContent?: ReactNode; title: string; ariaLabel: string; className: string;
  launching?: boolean; children: ReactNode;
}) {
  const { group, popoverId, portal } = card;
  return <Popover.Root {...(group ? {
    open: group.openId === popoverId,
    onOpenChange: (next: boolean) => group.setOpenId((current) => next ? popoverId : current === popoverId ? null : current),
  } : {})}>
    <Popover.Trigger ref={portal.triggerRef} openOnHover delay={250} closeDelay={180} nativeButton={false} render={<span />}
      className={className}
      data-launching={launching ? "true" : undefined}
      aria-label={ariaLabel}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {labelContent ?? sourceMention}
    </Popover.Trigger>
    <Popover.Portal container={portal.container}>
      <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="app-invocation-positioner">
        <Popover.Popup render={<LiquidGlassCard />} className="app-invocation-popup app-intent-popup" data-tone="neutral" onClick={(event) => event.stopPropagation()}>
          <div className="app-invocation-heading"><div>
            <Popover.Title className="app-invocation-title">{title}</Popover.Title>
            <p className="app-invocation-machine">{sourceMention}</p>
          </div><Popover.Close className="app-invocation-close" aria-label="Close"><X size={16} /></Popover.Close></div>
          {children}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

/**
 * A launch mention Jev read as naming, explaining or quoting an Agent. It
 * settles back into the author's prose — no avatar, no status pill — and keeps
 * only a dotted underline that opens why nothing started. The author can
 * answer the intent question themselves from here.
 */
export function MentionIntentDeclinedChip({ rejection, category, labelContent, onLaunchAnyway }: {
  rejection: SerializedAgentInvocationRejection; category: DeclinedIntent; labelContent?: ReactNode;
  onLaunchAnyway?: () => Promise<void>;
}) {
  const card = useMentionProseCard();
  const confidence = useDeclinedIntentConfidence(rejection.channelId, rejection.sourceMessageId, category, card.open);
  const [launching, setLaunching] = useState<"idle" | "launching" | "sent" | "failed">("idle");
  const copy = declinedIntentCopy(category);
  const launch = async () => {
    if (!onLaunchAnyway || launching === "launching" || launching === "sent") return;
    setLaunching("launching");
    try { await onLaunchAnyway(); setLaunching("sent"); }
    catch { setLaunching("failed"); }
  };
  return <MentionProseCard card={card} sourceMention={rejection.sourceMention} labelContent={labelContent} title="Not a summon"
    className="app-mention-intent-declined"
    launching={launching === "launching" || launching === "sent"}
    ariaLabel={`${rejection.sourceMention}: not a summon. xMatrix read this as ${copy.reading}. Show details`}>
    <Popover.Description className="app-intent-reading">
      xMatrix read this as <strong>{copy.reading}</strong>, so no Agent was started.
    </Popover.Description>
    {confidence !== undefined && <div className="app-intent-confidence" aria-label={`Routing confidence ${Math.round(confidence * 100)}%`}>
      <span className="app-intent-confidence-bar"><span style={{ width: `${Math.round(confidence * 100)}%` }} /></span>
      <span>{Math.round(confidence * 100)}%</span>
    </div>}
    {onLaunchAnyway && <button type="button" className="app-intent-launch" data-state={launching}
      disabled={launching === "launching" || launching === "sent"} onClick={() => void launch()}>
      <Zap aria-hidden="true" size={14} />
      {launching === "launching" ? "Starting…" : launching === "sent" ? "Launch requested" : "Launch anyway"}
    </button>}
    {launching === "failed" && <p role="alert" className="app-invocation-action-error">The launch was not accepted. Refresh the message and try again.</p>}
    <p className="app-invocation-description">To start an Agent directly next time, write <code>launch:force</code> after the mention.</p>
  </MentionProseCard>;
}

/** A stop command. Its phase sits on the command the way a launch's phase sits
 * on the summon: requested, then confirmed by the Workstation. */
export function MentionStopChip({ invocation, receipts, sentAt, pending, unavailable }: {
  invocation: AgentStopInvocation; receipts: readonly SerializedAgentStop[];
  sentAt?: string; pending?: boolean; unavailable?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const pendingUntil = sentAt && receipts.length === 0 && !unavailable ? Date.parse(sentAt) + STOP_RECEIPT_PENDING_MS : undefined;
  useEffect(() => {
    if (pendingUntil === undefined || now >= pendingUntil) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, pendingUntil - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [now, pendingUntil]);
  const view = stopView(receipts, {
    fresh: Boolean(pending) || (pendingUntil !== undefined && now < pendingUntil), unavailable: Boolean(unavailable),
  });
  const agentName = invocation.all ? "all" : invocation.target.replace(/:[1-9]\d*$/u, "");
  const ordinal = receipts.length === 1 ? receipts[0]?.instanceOrdinal : invocation.target.match(/:([1-9]\d*)$/u)?.[1];
  const machines = [...new Set(receipts.map(stop => stop.machineName).filter((name): name is string => Boolean(name)))];
  const named = receipts.find(stop => stop.targetName)?.targetName || agentName;
  return <InvocationChip label={invocation.text.replace(/^[@＠]/u, "")} labelContent={invocation.text}
    name={named} instanceOrdinal={ordinal}
    imageSrc={avatarImageSrc(receipts.find(stop => stop.targetAvatarUrl)?.targetAvatarUrl
      ?? invocationVendorIcon({ sourceMention: `@${agentName}`, targetName: named }))}
    sourceAddress={invocation.text}
    subtitle={machines.length === 1 ? machines[0]! : machines.length > 1 ? `${machines.length} machines` : "Selected machine"}
    view={view} />;
}

const LAUNCH_HINT_TITLES: Record<string, string> = {
  registration_machine_not_auto_assigned: "Name a machine",
  registration_machine_ambiguous: "Which machine",
};

/**
 * A launch the Hub understood and is telling the author how to write. It
 * settles into the prose the same way a declined reading does: the card holds
 * the prompt, and the Channel is not told. A launch that failed keeps its
 * Failed chip.
 */
export function MentionLaunchHintChip({ rejection, labelContent }: {
  rejection: SerializedAgentInvocationRejection; labelContent?: ReactNode;
}) {
  const card = useMentionProseCard();
  const title = LAUNCH_HINT_TITLES[rejection.code] ?? "How to start";
  const detail = preparationFailureSummary(rejection.code) ?? rejection.message;
  return <MentionProseCard card={card} sourceMention={rejection.sourceMention} labelContent={labelContent} title={title}
    className="app-mention-intent-declined app-mention-launch-hint"
    ariaLabel={`${rejection.sourceMention}: ${title}. Show details`}>
    <Popover.Description className="app-intent-reading">{detail}</Popover.Description>
  </MentionProseCard>;
}

/** A written summon the Hub has not answered yet. Right after sending, Jev is
 *  reading it; the shimmer stops at the reading window even with no answer.
 *  `fillKey` remembers that reading, so parameters that arrive afterwards
 *  highlight once inside the same mention. */
export function MentionSummonPending({ labelContent, reading, fillKey }: { labelContent: ReactNode; reading: boolean; fillKey?: string }) {
  useEffect(() => { if (reading && fillKey) noteJevReading(fillKey); }, [reading, fillKey]);
  return <span className="app-mention-chip app-mention-invocation app-mention-summon-written" data-reading={reading ? "true" : undefined}>
    <span className="app-mention-chip-label">{labelContent}</span>
    {reading && <span className="app-mention-invocation-status" role="status">
      <span aria-hidden="true">·</span><span className="app-intent-reading-label">xMatrix is reading</span>
    </span>}
  </span>;
}

function InvocationChip({ label, labelContent, announcement, name, instanceOrdinal, destinationName, imageSrc, sourceAddress, subtitle, invocationId, errorCode,
  diagnosticId, view, lead, context, details, onRetry, variant, jev }: {
  /** A handoff draws both Agents in its label, so it has no leading avatar. */
  variant?: "handoff";
  label: string; labelContent?: ReactNode; announcement?: string; name: string; instanceOrdinal?: string; destinationName?: string; imageSrc?: string | null; sourceAddress: string; subtitle: string;
  invocationId?: string; errorCode?: string; diagnosticId?: string; view: InvocationView;
  lead?: ReactNode; context?: ReactNode;
  /** Evidence behind the answer, folded away with the address and diagnostic IDs. */
  details?: ReactNode; onRetry?: () => Promise<void>;
  /** The message whose retained Jev decisions lead the timeline. */
  jev?: JevSource;
}) {
  const group = useContext(InvocationPopoverContext);
  const popoverId = useId();
  const portal = useAppPortalContainer();
  const [retrying, setRetrying] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const Icon = view.tone === "error" ? TriangleAlert : view.tone === "success" ? Check
    : view.animate ? LoaderCircle : view.tone === "waiting" ? Clock3 : CircleHelp;
  // A settled success already says everything; restating its last step is noise.
  const focusStep = view.steps.find((step) => step.state === "current" || step.state === "failed")
    ?? (view.tone === "success" ? undefined : [...view.steps].reverse().find((step) => step.state === "done"));
  // One inline status. Startup names the stage in progress with its -ing word;
  // "Starting" beside it would say the same thing twice. A settled chip keeps Started, Failed, or Stopped.
  const liveStage = !view.terminal && focusStep?.state === "current" ? focusStep : undefined;
  const statusText = liveStage?.status ?? view.label;
  const retry = async () => {
    if (!onRetry || retrying) return;
    setActionError(undefined);
    setRetrying(true);
    try { await onRetry(); }
    catch { setActionError("The retry was not confirmed. Refresh status before trying again."); }
    finally { setRetrying(false); }
  };
  return <Popover.Root {...(group ? {
    open: group.openId === popoverId,
    onOpenChange: (open: boolean) => group.setOpenId((current) => open ? popoverId : current === popoverId ? null : current),
  } : {})}>
    {/* A span, not a button: a button is always an atomic inline-block, which
        kept a summon with conditions from wrapping and stretched its line. */}
    <Popover.Trigger ref={portal.triggerRef} openOnHover delay={250} closeDelay={180} nativeButton={false} render={<span />}
      className={variant === "handoff" ? "app-mention-handoff" : "app-mention-chip app-mention-invocation"} data-tone={view.tone}
      aria-label={`@${label}: ${statusText}. ${announcement ? `${announcement}. ` : ""}Show invocation details`}
      onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
      {variant !== "handoff" && <span className="app-mention-chip-avatar" aria-hidden="true">
        <span className="app-mention-chip-avatar-face">
          {imageSrc ? (
            <LoadingImage
              src={imageSrc}
              alt=""
              announce={false}
              referrerPolicy="no-referrer"
              draggable={false}
              className="size-full object-cover"
              fallback={<span className="app-mention-chip-initial">{name[0]?.toUpperCase() || "@"}</span>}
            />
          ) : <span className="app-mention-chip-initial">{name[0]?.toUpperCase() || "@"}</span>}
        </span>
      </span>}
      {/* The chip shows the whole `@` expression as written; the name and
          instance ordinal alone would omit the lifecycle and workspace the
          author typed. A handoff names its destination inside that expression
          already, so the `→ @target` summary lives only in the popover title. */}
      {variant === "handoff" ? labelContent : <span className="app-mention-chip-label">{labelContent ?? <>@{label}</>}</span>}
      {variant !== "handoff" && <span className="app-mention-invocation-status" contentEditable={false}>
        <span aria-hidden="true">·</span><Icon aria-hidden="true" className={view.animate ? "app-invocation-spinner" : undefined} />
        {liveStage
          ? <span className="app-mention-invocation-step" data-state={liveStage.state}>{statusText}</span>
          : <span>{view.label}</span>}
      </span>}
    </Popover.Trigger>
    <Popover.Portal container={portal.container}>
      <Popover.Positioner side="bottom" align="start" sideOffset={8} collisionPadding={12} className="app-invocation-positioner">
        <Popover.Popup render={<LiquidGlassCard />} className="app-invocation-popup" data-tone={view.tone} onClick={(event) => event.stopPropagation()} onWheel={(event) => event.stopPropagation()}>
          <div className="app-invocation-heading"><div>
            <Popover.Title className="app-invocation-title">@{name}{instanceOrdinal && <>:{instanceOrdinal}</>}{destinationName && <> → @{destinationName}</>}</Popover.Title>
            <p className="app-invocation-machine">{subtitle}</p>
          </div><Popover.Close className="app-invocation-close" aria-label="Close invocation details"><X size={16} /></Popover.Close></div>
          <div className="app-invocation-current"><Icon size={16} aria-hidden="true" /><strong>{view.label}</strong></div>
          {view.detail && <Popover.Description className="app-invocation-description">{view.detail}</Popover.Description>}
          {onRetry && <button type="button" className="app-invocation-retry" disabled={retrying} onClick={() => void retry()}>{retrying ? "Requesting retry…" : "Retry startup"}</button>}
          {actionError && <p role="alert" className="app-invocation-action-error">{actionError}</p>}
          <InvocationPanelBody jev={jev} view={view} lead={lead} context={context} details={details}
            sourceAddress={sourceAddress} errorCode={errorCode} diagnosticId={diagnosticId} invocationId={invocationId} />
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

type JevSource = { channelId: string; messageId: string; sourceMention?: string; invocationId?: string; rejectedAt?: string;
  /** The launch's recorded choice of Agent and machine, drawn as one routing row. */
  parameters?: LaunchParameterEvidence };

/** Mounted only while the panel is open, so Jev's records are read on demand.
 *  The timeline runs in the order things happened: what Jev read and each
 *  answer it gave, then the machine and the process. */
function InvocationPanelBody({ jev, view, lead, context, details, sourceAddress, errorCode, diagnosticId, invocationId }: {
  jev?: JevSource; view: InvocationView; lead?: ReactNode; context?: ReactNode; details?: ReactNode;
  sourceAddress: string; errorCode?: string; diagnosticId?: string; invocationId?: string;
}) {
  const state = useJevDecisions({ channelId: jev?.channelId ?? "", messageId: jev?.messageId ?? "",
    sourceMention: jev?.sourceMention, invocationId: jev?.invocationId, rejectedAt: jev?.rejectedAt, enabled: !!jev });
  const decided = state.decisions.length > 0;
  // Jev's own rows above say how the request was read and what was chosen; the
  // startup then begins with what was measured, not judged: the machine.
  // The Agent row already names the machine routing chose, so that step is not repeated.
  const placed = !!jev?.parameters?.placement;
  const steps = decided ? view.steps.filter(step => step.label !== "Read as a request" && !(placed && step.label === "Environment selected"))
    .map(step => step.label === "Environment selected" ? { ...step, label: "Machine selected" } : step) : view.steps;
  return <>
    {jev?.invocationId && (state.cause ? <p role="status" className="app-invocation-description">Cause: {state.cause}</p>
      : !state.loaded && state.busy ? <p className="app-invocation-description">Checking failure reason…</p>
        : state.loaded && !state.cursor ? <p className="app-invocation-description">Detailed failure reason was not retained.</p> : null)}
    {lead}
    {decided && <JevDecisionSection decisions={state.decisions} parameters={jev?.parameters} />}
    {steps.length > 0 && <InvocationSteps steps={steps} label="Invocation progress" />}
    {context}
    <details className="app-invocation-request"><summary>Details</summary>
      {details}
      {jev && <JevDecisionFiles state={state} />}
      <p className="app-invocation-description">Invocation address</p><code>{sourceAddress}</code>
      {errorCode && <p className="app-invocation-code">{errorCode}</p>}
      {diagnosticId && <p className="app-invocation-code">{diagnosticId}</p>}
      {invocationId && <p className="app-invocation-code">Invocation {invocationId.slice(-12)}</p>}
    </details>
  </>;
}

function InvocationSteps({ steps, label }: { steps: InvocationStep[]; label: string }) {
  return <ol className="app-invocation-steps" aria-label={label}>
    {steps.map((step) => {
      // The step in progress says what is happening now, in the chip's word.
      const live = step.state === "current" && step.status;
      return <li key={step.label} data-state={step.state}>
        <span className="app-invocation-step-mark" aria-hidden="true">{step.state === "done" ? <Check size={12} /> : step.state === "failed" ? <X size={12} /> : step.state === "current" ? <span /> : null}</span>
        <span>{live || step.label}{step.note && <span className="app-invocation-step-note"> · {step.note}</span>}</span>
        <span className="app-invocation-step-time">{step.at
          ? <time dateTime={step.at}>{new Date(step.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          : step.state === "current" ? (live ? "" : "Waiting") : step.state === "failed" ? "Reported" : ""}</span>
      </li>;
    })}
  </ol>;
}
