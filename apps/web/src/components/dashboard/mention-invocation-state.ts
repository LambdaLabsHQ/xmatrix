import { agentAvatarUrlFromMetadata, agentPresetForLauncher, cleanRuntimeOperationFailure, handoffInstanceMentionScanner, mentionAddressTokens, parseHandoffInstanceTarget, parseAutoLaunchMentions, parsePresentedRoutingDecision, rebornFailureReason, scanMentionAddresses, summarizeStopReceipts, type PresentedRoutingDecision, type SerializedAgentLaunch, type SerializedAgentStop,
  type SerializedAgentMessageExecution, type SerializedAgentInvocationRejection, type SerializedAgentContinuation, type AgentLaunchActivity, type AgentStopInvocation,
  type AutoLaunchMention } from "@xmatrix/protocol";

export type InvocationTone = "active" | "waiting" | "error" | "success" | "neutral";
/** The whole chip vocabulary. A chip exists only for an invocation that starts
 *  an Agent, and each word answers the one question that raises — did it start
 *  reasoning — so a new runtime phase maps onto an existing answer instead of
 *  introducing another word. Runtime detail belongs in `detail` and the steps. */
export type InvocationChip = "Starting" | "Started" | "Failed" | "Stopped" | "Stopping" | "Unconfirmed";
export type InvocationStep = { label: string; at?: string; state: "done" | "current" | "unknown" | "failed";
  /** A short fact about how the step resolved, shown beside its label. */
  note?: string;
  /** What the chip says while this step is in progress: one -ing word, two only when one cannot say it. */
  status?: string };
export type InvocationView = {
  label: InvocationChip; tone: InvocationTone; detail: string; animate: boolean;
  steps: InvocationStep[]; terminal: boolean; executionId?: string;
};

const CHIP_TONE: Record<InvocationChip, InvocationTone> = {
  Starting: "active", Started: "success", Failed: "error", Stopped: "neutral",
  Stopping: "active", Unconfirmed: "waiting",
};
/** Only a startup or a stop still in progress may spin. */
export function invocationChipStatus(label: InvocationChip, detail: string, animate = false) {
  return { label, tone: CHIP_TONE[label], detail, animate: animate && (label === "Starting" || label === "Stopping") };
}

const REASONING_PHASES = new Set(["turn_running", "turn_retrying", "turn_completed", "turn_failed",
  "turn_interrupted", "turn_unknown", "run_delivery_failed"]);
/** `at` completes a sub-step; `began` is evidence from inside it, which proves
 *  the earlier sub-steps without completing this one. */
type StartupStep = { label: string; status: string; at?: string; began?: string; waiting: string };

/** A startup answers one question: did the Agent start reasoning? What the
 *  turn later does — replies, stops, exits — belongs to the Run, never to the
 *  invocation that started it. Every step sits on one list. Each one is
 *  confirmed by its own evidence or by any later one, since a later checkpoint
 *  cannot happen without the earlier ones. */
function startupView(input: {
  lead: InvocationStep; before?: InvocationStep; startup: StartupStep[]; activity?: AgentLaunchActivity; reasoningAt?: string; reasoning: boolean;
  failed: boolean; stopped: boolean; failureMessage?: string; queued?: boolean; unavailable: boolean;
}): InvocationView {
  const { activity, reasoning, unavailable } = input;
  const startup: InvocationStep[] = input.startup.map(({ label, status, at }) => ({ label, status, at, state: "unknown" }));
  let later = reasoning;
  for (let index = startup.length - 1; index >= 0; index--) {
    if (startup[index]!.at || later) startup[index]!.state = "done";
    later ||= Boolean(startup[index]!.at || input.startup[index]!.began);
  }
  const pendingIndex = startup.findIndex((step) => step.state !== "done");
  const pending = startup[pendingIndex];
  const failure = cleanRuntimeOperationFailure(activity?.operationFailure);
  const failureDetail = failure ? `${operationFailureStageLabel(failure.stage)}: ${operationFailureDescription(failure)}` : undefined;
  const failed = !reasoning && (input.failed || activity?.phase === "wrapper_startup_failed" ||
    activity?.runStatus === "failed" || activity?.runStatus === "exited");
  const stopped = !reasoning && !failed && (input.stopped || activity?.runStatus === "stopped");
  if (pending) pending.state = failed ? "failed" : stopped ? "unknown" : "current";
  const steps: InvocationStep[] = [...(input.before ? [input.before] : []), input.lead,
    ...startup,
    { label: "Reasoning started", at: input.reasoningAt, state: reasoning ? "done" : "unknown" },
  ];
  const note = unavailable ? " Status could not be refreshed; this is the last confirmed state."
    : activity?.evidenceStale ? " The machine has not reported fresh progress." : "";
  const stale = unavailable || Boolean(activity?.evidenceStale);
  const result = (label: InvocationChip, detail: string, animate = false): InvocationView =>
    ({ ...invocationChipStatus(label, `${detail}${note}`.trim(), animate && !stale), steps, terminal: label !== "Starting" });
  if (reasoning) return result("Started", "");
  if (failed) return result("Failed", failureDetail || input.failureMessage ||
    `Startup stopped at “${pending?.label ?? "Startup"}”. The process exited before reasoning started.`);
  if (stopped) return result("Stopped", "Stopped before reasoning started.");
  const retry = activity?.connectionRetry;
  const retrying = retry ? ` ${retry.kind === "channel_join" ? "Channel join" : retry.kind === "credential_refresh" ? "Credential refresh" : "Connection"} attempt ${retry.attempt}.` : "";
  return result("Starting", `${failureDetail ? `${failureDetail} ` : ""}${input.startup[pendingIndex]?.waiting ?? "Waiting for the first turn."}${retrying}`,
    !input.queued);
}

const startupCheckpoint = (activity: AgentLaunchActivity | undefined, phase: string) =>
  activity?.startupSteps?.find((step) => step.phase === phase)?.at;
const reasoningReported = (activity: AgentLaunchActivity | undefined) =>
  Boolean(activity && (REASONING_PHASES.has(activity.phase ?? "") || activity.runStatus === "completed"));
function channelStartup(activity: AgentLaunchActivity | undefined, connectedAt?: string): StartupStep[] {
  return [
    { label: "Joined channel", status: startupCheckpoint(activity, "relay_registered") ? "Joining" : "Connecting", at: activity?.wrapperReadyAt || startupCheckpoint(activity, "channel_joined"),
      began: startupCheckpoint(activity, "relay_registered") || connectedAt,
      waiting: startupCheckpoint(activity, "relay_registered") ? "Joining this channel."
        : connectedAt ? "Waiting for the client to confirm its connection." : "Connecting to the server." },
    { label: "Runtime ready", status: "Initializing", at: startupCheckpoint(activity, "runtime_ready"), waiting: "Initializing the runtime." },
  ];
}

/** The first step of a started summon: why it was read as a request. */
export function summonIntentNote(decision: PresentedRoutingDecision | undefined): string | undefined {
  const intent = decision?.parameters?.intent;
  if (!intent) return undefined;
  if (intent.source === "author") return "launch:force";
  if (intent.source === "draft") return "Previewed before send";
  const probability = intent.probabilities.summon;
  return Number.isFinite(probability) ? `xMatrix · ${Math.round(probability * 100)}%` : "xMatrix";
}

/** Selecting an environment, starting it, then the first turn. */
export function summonView(launch: SerializedAgentLaunch, records: readonly SerializedAgentMessageExecution[] = [], unavailable = false): InvocationView {
  const activity = launch.activity;
  const execution = launchExecution(launch, records);
  const reasoningAt = startupCheckpoint(activity, "turn_running") || execution?.startedAt || launch.firstReplyAt;
  const decision = launch.routingDecision;
  const intent = summonIntentNote(parsePresentedRoutingDecision(decision));
  return { ...startupView({
    ...(intent ? { before: { label: intent === "launch:force" ? "Started on the author's request" : "Read as a request",
      note: intent, at: decision?.evaluatedAt, state: "done" as const } } : {}),
    lead: { label: "Environment selected", at: decision?.evaluatedAt, state: "done" },
    startup: [
      { label: "Machine accepted", status: launch.daemonOffline ? "Queuing" : "Dispatching", at: launch.admittedAt,
        waiting: launch.daemonOffline ? "The command is queued until the selected machine reconnects."
          : launch.commandDurableAt ? "Waiting for the machine to accept the command." : "Preparing the machine command." },
      { label: "Process started", status: "Spawning", at: startupCheckpoint(activity, "cwd_ready") || launch.spawnedAt,
        waiting: launch.spawnedAt ? "Preparing the working directory." : "Creating the process." },
      ...channelStartup(activity, launch.connectedAt),
    ],
    activity, reasoningAt, reasoning: Boolean(reasoningAt || execution || reasoningReported(activity)),
    failed: launch.state === "failed", stopped: launch.state === "cancelled", failureMessage: launch.errorMessage,
    queued: launch.daemonOffline, unavailable,
  }), executionId: execution?.executionId };
}

function launchExecution(launch: SerializedAgentLaunch, records: readonly SerializedAgentMessageExecution[]) {
  return records.filter(record => record.channelId === launch.channelId && record.sourceMessageId === launch.sourceMessageId &&
    record.runId === launch.runId && record.instanceId === launch.instanceId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.executionId.localeCompare(a.executionId))[0];
}

/** A reborn or handoff is a startup too: the predecessor stops, then the
 *  successor Run starts and begins reasoning. A reborn is shown from the
 *  moment it is accepted, so every wait before its successor Run exists —
 *  and every way it can fail there — reads like a summon's. */
export function continuationView(record: SerializedAgentContinuation, unavailable = false): InvocationView {
  const { activity, reborn } = record;
  const reasoningAt = startupCheckpoint(activity, "turn_running");
  const handedOff = record.kind === "handoff" ? record.handoffFencedAt : record.predecessorExitedAt;
  const failure = reborn?.state === "failed" ? rebornFailureReason(reborn.errorCode) : undefined;
  return startupView({
    lead: { label: record.kind === "handoff" ? "Handoff requested" : "Reborn requested", at: record.createdAt, state: "done" },
    startup: [
      { label: record.kind === "handoff" ? "Handoff recorded" : "Previous process stopped",
        status: record.kind === "handoff" ? "Handing off" : "Stopping", at: handedOff,
        waiting: reborn?.stopRequired === false ? "Preparing to resume the original session."
          : "Stopping the previous process. The machine must confirm it before the session can resume." },
      // A successor without an intent is the Run itself: it exists from the start.
      { label: "Successor Run created", status: "Creating", at: record.runCreatedAt ?? (reborn ? undefined : record.createdAt),
        waiting: "Creating the successor Run." },
      ...(reborn ? [{ label: "Machine accepted", status: "Dispatching", at: reborn.state === "spawned" ? reborn.updatedAt : undefined,
        began: startupCheckpoint(activity, "cwd_ready"),
        waiting: "Waiting for the machine to accept the resume command." }] : []),
      { label: "Process started", status: "Spawning", at: startupCheckpoint(activity, "cwd_ready"), waiting: "Preparing the working directory." },
      ...channelStartup(activity),
    ],
    activity, reasoningAt, reasoning: Boolean(reasoningAt || reasoningReported(activity)),
    failed: Boolean(failure), stopped: false, unavailable,
    ...(failure ? { failureMessage: `${failure.reason} [${failure.code}]` } : {}),
  });
}

/** The registration launch a handoff started, matched by the mention as written.
 *  The newest one wins, the same way a summon binds its launch. */
export function handoffSuccessorLaunch(launches: readonly SerializedAgentLaunch[] | undefined, mentionText: string): SerializedAgentLaunch | undefined {
  return launches?.filter(launch => launch.sourceMention === mentionText)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

/** One side of a handoff: what that Agent is doing about the work now, in
 *  the same tones every invocation chip uses. */
export interface HandoffSide { label: string; tone: InvocationTone }
export interface HandoffView { source: HandoffSide; successor: HandoffSide; flowing: boolean }

/** How long a written handoff with no successor record still reads as in
 *  flight: picking `@auto`, or starting on another machine. */
export const HANDOFF_UNRECORDED_FLIGHT_MS = 3 * 60_000;

/** Each Agent of a handoff carries its own state, so the card shows the work
 *  leaving one and arriving at the other. Without a successor record the
 *  handoff is in flight only while it is fresh; after that it shows names. */
export function handoffView(record: SerializedAgentContinuation | undefined,
  input: { auto: boolean; fresh: boolean; unavailable?: boolean }): HandoffView {
  if (!record) {
    return input.fresh
      ? { source: { label: "Handing off", tone: "active" },
        successor: { label: input.auto ? "Picking" : "Starting", tone: "active" }, flowing: true }
      : { source: { label: "", tone: "neutral" }, successor: { label: "", tone: "neutral" }, flowing: false };
  }
  const view = continuationView(record, input.unavailable);
  const successor: HandoffSide = view.label === "Started" ? { label: "Took over", tone: view.tone }
    : { label: view.label, tone: view.tone };
  const source: HandoffSide = record.handoffFencedAt ? { label: "Handed off", tone: "neutral" }
    : view.tone === "error" ? { label: "Kept its work", tone: "neutral" }
      : { label: "Handing off", tone: "active" };
  return { source, successor, flowing: view.tone === "active" };
}

export function splitMentionContinuations(text: string, records: readonly SerializedAgentContinuation[], allowed?: (start: number) => boolean) {
  const tokens = mentionAddressTokens(records.map(record => record.sourceName));
  return splitRecordedMentions(text, tokens, written => {
    const candidates = records.filter(record => record.sourceMention === written);
    return candidates.length === 1
      ? { kind: "continuation" as const, text: written, record: candidates[0] }
      : undefined;
  }, allowed);
}

/** Written handoffs (`@source:n:handoff:@successor`), parsed with the shared
 *  grammar the Hub executes, so the card draws exactly what runs. */
export function splitHandoffMentions(text: string, allowed?: (start: number) => boolean) {
  const segments: Array<{ kind: "text"; text: string } | { kind: "handoff"; text: string;
    sourceName: string; sourceOrdinal: number; successorName: string }> = [];
  let start = 0;
  for (const match of text.matchAll(handoffInstanceMentionScanner())) {
    const at = match.index! + match[0].search(/[@＠]/u);
    const parsed = parseHandoffInstanceTarget(match[1] || "");
    if (!parsed || (allowed && !allowed(at))) continue;
    const end = at + 1 + match[1]!.length;
    if (at > start) segments.push({ kind: "text", text: text.slice(start, at) });
    segments.push({ kind: "handoff", text: text.slice(at, end), sourceName: parsed.sourceAgentName,
      sourceOrdinal: parsed.channelInstanceId, successorName: parsed.successorName });
    start = end;
  }
  if (start < text.length) segments.push({ kind: "text", text: text.slice(start) });
  return segments;
}

function splitRecordedMentions<T extends { kind: string; text: string }>(
  text: string, tokens: ReturnType<typeof mentionAddressTokens>,
  resolve: (written: string) => T | undefined, allowed?: (start: number) => boolean,
) {
  const segments: Array<{ kind: "text"; text: string } | T> = [];
  let start = 0;
  for (const match of scanMentionAddresses(text, tokens)) {
    if (allowed && !allowed(match.start)) continue;
    const segment = resolve(text.slice(match.start, match.end));
    if (!segment) continue;
    if (match.start > start) segments.push({ kind: "text", text: text.slice(start, match.start) });
    segments.push(segment);
    start = match.end;
  }
  if (start < text.length) segments.push({ kind: "text", text: text.slice(start) });
  return segments;
}

/** How long a just-sent stop shows "Stopping" before an empty receipt is "Unconfirmed". */
export const STOP_RECEIPT_PENDING_MS = 15_000;

/** The stop command's chip. Confirmation is the Workstation's receipt, the
 * same place a launch shows that it started — not a second message. */
export function stopView(receipts: readonly SerializedAgentStop[], input: { fresh: boolean; unavailable: boolean }): InvocationView {
  const summary = summarizeStopReceipts(receipts);
  const waiting = receipts.length === 0 && input.fresh && !input.unavailable;
  const phase = waiting ? "accepted" as const : summary.phase;
  const count = receipts.length;
  const detail = input.unavailable && count === 0
    ? "Status could not be refreshed; this is the last confirmed state."
    : phase === "accepted"
      ? count > 1
        ? `Stop requested for ${count} agent instances. ${summary.accepted} still waiting for the Workstation.`
        : "Stop requested. Waiting for the Workstation to confirm the process has terminated."
      : phase === "confirmed"
        ? count > 1
          ? `Stopped ${count} agent instances. The Workstation confirmed each process tree is terminated.`
          : "The Workstation confirmed the process tree is terminated."
        : phase === "failed"
          ? "The Workstation reported the stop failed, so the process may still be running."
          : "The stop was not confirmed.";
  const label: InvocationChip = phase === "accepted" ? "Stopping" : phase === "confirmed" ? "Stopped"
    : phase === "failed" ? "Failed" : "Unconfirmed";
  const requestedAt = receipts.map(stop => stop.requestedAt).sort()[0];
  const confirmedAt = receipts.map(stop => stop.confirmedAt).filter((at): at is string => Boolean(at)).sort().at(-1);
  const steps: InvocationStep[] = [
    { label: "Stop requested", at: requestedAt, state: count > 0 || waiting ? "done" : "unknown" },
    { label: "Workstation confirmed", at: phase === "confirmed" ? confirmedAt : undefined,
      state: phase === "confirmed" ? "done" : phase === "failed" ? "failed" : phase === "accepted" ? "current" : "unknown" },
  ];
  const status = invocationChipStatus(label, detail, phase === "accepted");
  // The inline word is the phase. A current ladder step would print
  // "Workstation confirmed" while the Workstation has not answered yet.
  return { ...status, tone: phase === "confirmed" ? "success" : status.tone, steps, terminal: true };
}

/** One batched query per channel. Keep observing connected-but-not-ready runs. */
export function invocationPollInterval(launches: readonly SerializedAgentLaunch[], newestAt: number,
  now: number, failed: boolean, continuations: readonly SerializedAgentContinuation[] = [],
  executions: readonly SerializedAgentMessageExecution[] = [],
  stops: readonly SerializedAgentStop[] = []): number | false {
  if (failed) return 10_000;
  if (stops.some(stop => stop.phase === "accepted")) return 2_000;
  if (executions.some(record => !record.finalReply && record.finishedAt &&
      now - Date.parse(record.finishedAt) >= 0 && now - Date.parse(record.finishedAt) < 60_000)) return 2_000;
  if (continuations.some(record => !continuationView(record).terminal)) return 2_000;
  if (!launches.length) return newestAt > now - 120_000 ? 2_000 : executions.length ? 15_000 : false;
  // A summon is settled once reasoning starts; later turns are the Run's own
  // business. Executions still refresh so a saved reply can be recovered.
  const views = launches.map(launch => summonView(launch, executions));
  if (views.some(view => view.animate)) return 2_000;
  return executions.length || views.some(view => !view.terminal) ? 15_000 : false;
}

/** Match only the exact, server-recorded address within a normal Markdown text run. */
export function splitMentionRejections(text: string, rejections: readonly SerializedAgentInvocationRejection[], allowed?: (start: number) => boolean) {
  const tokens = mentionAddressTokens(rejections.map((rejection) => rejection.targetRef));
  return splitRecordedMentions(text, tokens, written => {
    const rejection = rejections.find((rejection) => rejection.sourceMention === written);
    return rejection ? { kind: "rejection" as const, text: written, rejection } : undefined;
  }, allowed);
}



const FAILURE_STAGES: Record<string, string> = {
  "relay.await_confirmation": "Waiting for connection confirmation",
  "relay.authenticate": "Checking credentials", "relay.validate_binding": "Checking Run binding",
  "relay.replace_connection": "Replacing the connection", "relay.send_confirmation": "Sending connection confirmation",
  "relay.bind_delivery": "Binding message delivery", "relay.publish_presence": "Publishing connection state",
  "authority.request": "Authority request", "authority.access": "Checking access", "request.validate": "Checking the request",
};
export function operationFailureStageLabel(stage: string): string { return Object.hasOwn(FAILURE_STAGES, stage) ? FAILURE_STAGES[stage]! : "Runtime session"; }

export function operationFailureDescription(value: unknown): string | undefined {
  const failure = cleanRuntimeOperationFailure(value);
  if (!failure) return undefined;
  const reasons: Record<string, string> = {
    "relay.registration_timeout": "Server confirmation did not arrive before the registration deadline. The server may already have accepted the connection.",
    agent_run_not_live: "This Run is no longer active. Its credentials cannot start another execution.",
    agent_instance_not_live: "This instance is no longer active. Check the original invocation before starting another.",
    agent_run_binding_mismatch: "The process credentials do not match the active Run. Check its Run and instance references.",
    agent_connection_superseded: "A newer connection replaced this one. Check the active connection before restarting.",
    postgres_runtime_unavailable: "The runtime service is temporarily unavailable.",
    runtime_transaction_retry_exhausted: "The runtime service could not acquire its required state after bounded retries.",
    runtime_sql_contract_error: "The runtime service encountered an internal error. Use the diagnostic reference to investigate.",
    agent_run_forbidden: "The operation was refused for this Run. Refresh its state before requesting recovery.",
    forbidden: "The operation was refused. Check current access before retrying.",
    channel_not_found: "The channel context is unavailable to this Run.",
  };
  return Object.hasOwn(reasons, failure.code) ? reasons[failure.code]
    : "The runtime reported a failure at this step. Use its diagnostic reference to investigate.";
}

/** The harness vendor mark for a summon chip. A letter is only the fallback
 *  when nothing names a harness. The bound registration's avatar is already
 *  that mark; otherwise use the route that was selected, then the address the
 *  author wrote (`@grok`, or `harness:` on `@auto`). */
export function invocationVendorIcon(input: {
  targetAvatarUrl?: string;
  sourceMention?: string;
  targetName?: string;
  routingDecision?: { rows?: ReadonlyArray<{ harness?: string; selected?: boolean }> };
}): string | undefined {
  const declared = input.targetAvatarUrl?.trim();
  if (declared) return declared;
  const selected = input.routingDecision?.rows?.find((row) => row.selected)?.harness;
  // "Agent" is the generic display name as well as Cursor's CLI executable.
  // Only an explicit harness selection may interpret that ambiguous token.
  const namedHarness = input.targetName?.trim().toLowerCase() === "agent" ? undefined : input.targetName;
  return presetVendorIcon(selected) ?? presetVendorIcon(writtenHarness(input.sourceMention))
    ?? presetVendorIcon(namedHarness);
}

function presetVendorIcon(token: string | undefined): string | undefined {
  const value = token?.trim();
  if (!value || !agentPresetForLauncher(value)) return undefined;
  return agentAvatarUrlFromMetadata({}, value);
}

/** The harness the summon's own text names (`@grok`, or `harness:` on
 *  `@auto`), read with the launch grammar itself. `@auto` alone names none. */
function writtenHarness(sourceMention: string | undefined): string | undefined {
  return sourceMention ? parseAutoLaunchMentions(sourceMention)[0]?.tags.harness : undefined;
}

type WrittenHandoff = { sourceName: string; sourceOrdinal: number; successorName: string };
type InteractionMention<Target> = { kind: "mention"; text: string; target: Target; token?: string };

/** A text run's pieces, each tagged with the presentation contract it renders
 *  through (docs/design/message-interaction-protocol.md); `null` is plain text. */
export type InteractionSegment<Target = unknown> =
  | { presentationRef: null; text: string }
  | { presentationRef: "handoff.v1" | "reborn.v1"; text: string; record: SerializedAgentContinuation }
  | { presentationRef: "handoff.v1"; text: string; written: WrittenHandoff }
  | { presentationRef: "launch.v1"; text: string; mention?: AutoLaunchMention;
    launch?: SerializedAgentLaunch; rejection?: SerializedAgentInvocationRejection }
  | { presentationRef: "stop.v1"; text: string; invocation: AgentStopInvocation; receipts: readonly SerializedAgentStop[] }
  | { presentationRef: "mention.v1"; text: string; target: Target; token?: string };

export interface InteractionRecords<Target> {
  continuations?: readonly SerializedAgentContinuation[];
  rejections?: readonly SerializedAgentInvocationRejection[];
  launches?: readonly SerializedAgentLaunch[];
  /** The message's own stop command, when this run is that command's text. */
  stop?: { invocation: AgentStopInvocation; receipts: readonly SerializedAgentStop[] };
  /** Without launch status access, a written handoff stays the prose it was written as. */
  launchStatusUnavailable?: boolean;
  /** Read-state mentions in a run of plain text, from the Channel's member index. */
  mentions?: (text: string) => ReadonlyArray<{ kind: "text"; text: string } | InteractionMention<Target>>;
}

/**
 * One pass from a text run to the segments it renders as, each tagged with
 * its presentation contract. Server records claim their spans first — a
 * recorded continuation, then a written handoff, a recorded rejection, a
 * summon with its launch, and last a plain mention — and each later step only
 * reads the text earlier steps left, so one span never renders twice.
 * `allowed` says whether an address starting at that offset is operational.
 */
export function segmentMessageInteraction<Target>(text: string, records: InteractionRecords<Target>,
  allowed: (start: number) => boolean = () => true): InteractionSegment<Target>[] {
  type Segment = InteractionSegment<Target>;
  const refine = (segments: Segment[], split: (text: string, offset: number) => Segment[]): Segment[] => {
    const out: Segment[] = [];
    let offset = 0;
    for (const segment of segments) {
      if (segment.presentationRef === null) out.push(...split(segment.text, offset));
      else out.push(segment);
      offset += segment.text.length;
    }
    return out;
  };
  const plain = (value: string): Segment => ({ presentationRef: null, text: value });
  let segments: Segment[] = text ? [plain(text)] : [];
  const stop = records.stop;
  if (stop && text.includes(stop.invocation.text)) {
    segments = refine(segments, (run, offset) => {
      const at = run.indexOf(stop.invocation.text);
      if (at < 0 || !allowed(at + offset)) return [plain(run)];
      const out: Segment[] = [];
      if (at > 0) out.push(plain(run.slice(0, at)));
      out.push({ presentationRef: "stop.v1", text: stop.invocation.text, invocation: stop.invocation, receipts: stop.receipts });
      if (at + stop.invocation.text.length < run.length) out.push(plain(run.slice(at + stop.invocation.text.length)));
      return out;
    });
  }
  segments = refine(segments, (run, offset) => splitMentionContinuations(run, records.continuations ?? [],
    start => allowed(start + offset)).map(part => part.kind === "continuation"
    ? { presentationRef: part.record.kind === "reborn" ? "reborn.v1" : "handoff.v1", text: part.text, record: part.record }
    : plain(part.text)));
  if (!records.launchStatusUnavailable) {
    segments = refine(segments, (run, offset) => splitHandoffMentions(run, start => allowed(start + offset))
      .map(part => part.kind === "handoff"
        ? { presentationRef: "handoff.v1", text: part.text, written: { sourceName: part.sourceName,
          sourceOrdinal: part.sourceOrdinal, successorName: part.successorName } }
        : plain(part.text)));
  }
  const rejections = records.rejections ?? [];
  segments = refine(segments, (run, offset) => splitMentionRejections(run,
    rejections.filter(item => !item.code.startsWith("routing_")), start => allowed(start + offset))
    .map(part => part.kind === "rejection" ? { presentationRef: "launch.v1", text: part.text, rejection: part.rejection }
      : plain(part.text)));
  segments = refine(segments, (run, offset) => {
    const out: Segment[] = [];
    let cursor = 0;
    for (const mention of parseAutoLaunchMentions(run)) {
      if (!allowed(mention.start + offset)) continue;
      const rejection = rejections.find(item => item.sourceMention === mention.text);
      if (mention.error && !rejection) continue;
      if (mention.start > cursor) out.push(plain(run.slice(cursor, mention.start)));
      const launch = records.launches?.filter(item => item.sourceMention === mention.text)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      out.push({ presentationRef: "launch.v1", text: run.slice(mention.start, mention.end), mention,
        ...(launch ? { launch } : rejection ? { rejection } : {}) });
      cursor = mention.end;
    }
    if (cursor < run.length) out.push(plain(run.slice(cursor)));
    return out;
  });
  const mentions = records.mentions;
  if (mentions) {
    segments = refine(segments, (run, offset) => {
      let cursor = offset;
      return mentions(run).map(part => {
        const start = cursor;
        cursor += part.text.length;
        return part.kind === "mention" && allowed(start)
          ? { presentationRef: "mention.v1", text: part.text, target: part.target, token: part.token }
          : plain(part.text);
      });
    });
  }
  // Adjacent text pieces join back, so plain prose renders as one run.
  return segments.reduce<Segment[]>((out, segment) => {
    const last = out[out.length - 1];
    if (segment.presentationRef === null && last?.presentationRef === null) {
      out[out.length - 1] = plain(last.text + segment.text);
    } else out.push(segment);
    return out;
  }, []);
}
