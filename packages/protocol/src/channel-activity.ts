/**
 * Conversation activity: what a Run's runtime observed about its own work,
 * kept in the Channel timeline as compact entries instead of narration
 * (docs/design/conversation-activity.md).
 */

/** Timeline message kind of an activity entry. */
export const CHANNEL_ACTIVITY_MESSAGE_KIND = "xmatrix.activity";

/** Metadata provenance of an activity entry: context for Agents, never unread for people. */
export const CHANNEL_ACTIVITY_PROVENANCE = "activity";

/** Annotation namespace of the Hub's judgment that a later message superseded this one. */
export const SUPERSEDED_ANNOTATION_NAMESPACE = "xmatrix.superseded";
/** The Hub's record that a questionnaire card was answered or withdrawn. */
export const QUESTIONNAIRE_STATE_ANNOTATION_NAMESPACE = "xmatrix.questionnaire";

/** The Hub's answer to a command a message wrote (`/model`, `/effort`, a stop, a reborn or handoff). */
export const COMMAND_RESULT_ANNOTATION_NAMESPACE = "xmatrix.command-result";

/**
 * Message kinds the Hub commits for one Agent Instance to act on: continue a
 * turn a switch cancelled, retry one capacity cut short, co-write a page. The
 * Channel log is their durable inbox, so a resting or reconnecting Instance
 * still reads them; no person reads them. They neither preview, count as
 * unread, nor take a row.
 */
export const AGENT_INSTRUCTION_MESSAGE_KINDS = ["xmatrix.switch-continuation", "xmatrix.capacity-retry",
  "xmatrix.system.page-co-write"] as const;

/** Whether a message's metadata is an Agent instruction (AGENT_INSTRUCTION_MESSAGE_KINDS). */
export function isAgentInstruction(metadata: Record<string, unknown> | undefined): boolean {
  if (!metadata || metadata.xmatrixSystemNotice !== true) return false;
  const retry = metadata.xmatrixTurnRetry;
  return metadata.xmatrixSwitchContinuation !== undefined || metadata.xmatrixPageCoWrite !== undefined ||
    (Boolean(retry) && typeof retry === "object" && (retry as { state?: unknown }).state === "issued" &&
      (retry as { version?: unknown }).version === 1);
}

/** Author of annotations the Hub writes itself. Public writers cannot take it. */
export const SYSTEM_ANNOTATION_AUTHOR = "system:xmatrix";

/** Annotation namespaces that hold the Hub's own judgments, written only as system. */
export function isReservedAnnotationNamespace(namespace: string): boolean {
  return namespace.trim().toLowerCase().startsWith("xmatrix.");
}

export type ChannelActivityPlanStepStatus = "pending" | "in_progress" | "completed";

export interface ChannelActivityPlanStep {
  text: string;
  status: ChannelActivityPlanStepStatus;
}

export type ChannelActivity =
  | {
      kind: "plan";
      /** Steps completed since the Run's previous plan entry, oldest first. */
      completed: string[];
      /** The step now in progress, if any. */
      inProgress?: string;
      /** The whole plan as it stands. */
      steps: ChannelActivityPlanStep[];
    }
  | {
      kind: "pull_request";
      /** `owner/name`, derived from the URL. */
      repository: string;
      number: number;
      url: string;
    };

export const CHANNEL_ACTIVITY_MAX_STEPS = 30;
export const CHANNEL_ACTIVITY_MAX_COMPLETED = 10;
export const CHANNEL_ACTIVITY_MAX_STEP_TEXT = 200;

const STEP_STATUSES: readonly ChannelActivityPlanStepStatus[] = ["pending", "in_progress", "completed"];
const PULL_REQUEST_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})\/pull\/([1-9][0-9]{0,8})$/u;

export class ChannelActivityInvalid extends Error {
  constructor(readonly reason: string) {
    super(`Channel activity is invalid: ${reason}`);
    this.name = "ChannelActivityInvalid";
  }
}

function record(value: unknown, reason: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ChannelActivityInvalid(reason);
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], reason: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new ChannelActivityInvalid(reason);
}

/** Step titles are the Agent's own untrusted text: one bounded line. */
function stepText(value: unknown): string {
  if (typeof value !== "string") throw new ChannelActivityInvalid("step_text");
  const text = value.replace(/\s+/gu, " ").trim();
  if (!text) throw new ChannelActivityInvalid("step_text");
  return [...text].length > CHANNEL_ACTIVITY_MAX_STEP_TEXT
    ? `${[...text].slice(0, CHANNEL_ACTIVITY_MAX_STEP_TEXT - 1).join("")}…`
    : text;
}

function stepList(value: unknown, maximum: number, reason: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) throw new ChannelActivityInvalid(reason);
  return value;
}

/**
 * The canonical form of one activity report, or ChannelActivityInvalid.
 * Unknown keys, kinds and statuses are refused rather than dropped, so a
 * report the Hub stores always reads back exactly as it was validated.
 */
export function normalizeChannelActivity(value: unknown): ChannelActivity {
  const input = record(value, "activity");
  if (input.kind === "plan") {
    onlyKeys(input, ["kind", "completed", "inProgress", "steps"], "plan_fields");
    const steps = stepList(input.steps, CHANNEL_ACTIVITY_MAX_STEPS, "steps").map((entry) => {
      const step = record(entry, "step");
      onlyKeys(step, ["text", "status"], "step_fields");
      if (!STEP_STATUSES.includes(step.status as ChannelActivityPlanStepStatus)) {
        throw new ChannelActivityInvalid("step_status");
      }
      return { text: stepText(step.text), status: step.status as ChannelActivityPlanStepStatus };
    });
    const completed = stepList(input.completed, CHANNEL_ACTIVITY_MAX_COMPLETED, "completed").map(stepText);
    const inProgress = input.inProgress === undefined ? undefined : stepText(input.inProgress);
    if (completed.length === 0 && inProgress === undefined && steps.length === 0) {
      throw new ChannelActivityInvalid("empty_plan");
    }
    return { kind: "plan", completed, ...(inProgress === undefined ? {} : { inProgress }), steps };
  }
  if (input.kind === "pull_request") {
    onlyKeys(input, ["kind", "repository", "number", "url"], "pull_request_fields");
    const match = typeof input.url === "string" ? PULL_REQUEST_URL.exec(input.url) : null;
    if (!match) throw new ChannelActivityInvalid("pull_request_url");
    const repository = `${match[1]}/${match[2]}`;
    const number = Number(match[3]);
    if ((input.repository !== undefined && input.repository !== repository) ||
        (input.number !== undefined && input.number !== number)) {
      throw new ChannelActivityInvalid("pull_request_mismatch");
    }
    return { kind: "pull_request", repository, number, url: input.url as string };
  }
  throw new ChannelActivityInvalid("kind");
}

/**
 * The plain-text line stored as the entry's body, for clients that do not
 * render activity. It never carries an address: an activity entry must not
 * be read as a mention, a summon or a command by anything that scans bodies.
 */
export function channelActivityLine(activity: ChannelActivity): string {
  const line = activity.kind === "pull_request"
    ? `↗ Opened pull request ${activity.repository}#${activity.number}`
    : [
        ...activity.completed.map((step) => `✓ ${step}`),
        ...(activity.inProgress ? [`→ ${activity.inProgress}`] : []),
      ].join(" · ") || `Plan: ${activity.steps.length} step${activity.steps.length === 1 ? "" : "s"}`;
  return line.replace(/[@＠]/gu, "");
}

/** The activity an entry carries, when its metadata is a well-formed activity entry. */
export function channelActivityOf(metadata: unknown): ChannelActivity | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = metadata as Record<string, unknown>;
  if (value.xmatrixProvenance !== CHANNEL_ACTIVITY_PROVENANCE) return undefined;
  try {
    return normalizeChannelActivity(value.xmatrixActivity);
  } catch {
    return undefined;
  }
}

/** The payloads of the Hub's own annotations in `namespace`; no other author counts. */
function hubJudgments(annotations: unknown, namespace: string): Record<string, unknown>[] {
  if (!Array.isArray(annotations)) return [];
  return annotations.flatMap((entry) => {
    const annotation = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    if (annotation?.namespace !== namespace || annotation.authorUserId !== SYSTEM_ANNOTATION_AUTHOR) return [];
    return [annotation.payload && typeof annotation.payload === "object" ? annotation.payload as Record<string, unknown> : {}];
  });
}

/** The id of the message that superseded this one, when the Hub judged so. */
export function supersededByOf(annotations: unknown): string | undefined {
  for (const payload of hubJudgments(annotations, SUPERSEDED_ANNOTATION_NAMESPACE)) {
    if (typeof payload.supersededBy === "string" && payload.supersededBy) return payload.supersededBy;
  }
  return undefined;
}

/** One thing the Hub said about a command, in its own words. */
export interface CommandResultNote {
  /** The annotation that holds it: one note per fact, written once. */
  id: string;
  text: string;
  at: string;
  /** A stop that fenced no Run: this note is its whole answer. */
  stopOutcome?: "stopped" | "not_stopped";
  /** The Run the note is about, so the chip of the summon that started it shows it. */
  runId?: string;
}

/**
 * What a command came to, recorded on the message that wrote it rather than
 * posted as another message: the answer belongs to the command, and a reader
 * finds it there (docs/design/message-interaction-protocol.md).
 */
export interface CommandResult {
  /** `/model` and `/effort`: one outcome per statement, in statement order. */
  controls?: import("./agent-control-command.js").AgentControlOutcomeRecord[];
  notes?: CommandResultNote[];
}

/** The merged result the Hub recorded for this message's command, if any. */
export function commandResultOf(annotations: unknown): CommandResult | undefined {
  if (!Array.isArray(annotations)) return undefined;
  let controls: CommandResult["controls"];
  const notes: CommandResultNote[] = [];
  for (const entry of annotations) {
    const annotation = entry && typeof entry === "object" ? entry as Record<string, unknown> : undefined;
    if (annotation?.namespace !== COMMAND_RESULT_ANNOTATION_NAMESPACE ||
        annotation.authorUserId !== SYSTEM_ANNOTATION_AUTHOR) continue;
    const merged = mergeCommandResult({ ...(controls ? { controls } : {}), notes },
      typeof annotation.id === "string" ? annotation.id : "", annotation.payload);
    controls = merged.controls;
    notes.splice(0, notes.length, ...(merged.notes ?? []));
  }
  return controls || notes.length ? { ...(controls ? { controls } : {}), ...(notes.length ? { notes } : {}) } : undefined;
}

/** `result` with one recorded command-result annotation applied, as a client
 * applies the live event and the Hub applies its stored annotations. */
export function mergeCommandResult(result: CommandResult | undefined, annotationId: string, payload: unknown): CommandResult {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const next: CommandResult = { ...result };
  if (Array.isArray(value.controls) && value.controls.every((item) =>
    item && typeof item === "object" && typeof (item as { status?: unknown }).status === "string")) {
    next.controls = value.controls as NonNullable<CommandResult["controls"]>;
  }
  const note = value.note && typeof value.note === "object" ? value.note as Record<string, unknown> : undefined;
  if (annotationId && typeof note?.text === "string" && note.text && typeof note.at === "string") {
    const stopOutcome: CommandResultNote["stopOutcome"] =
      note.stopOutcome === "stopped" || note.stopOutcome === "not_stopped" ? note.stopOutcome : undefined;
    next.notes = [...(result?.notes ?? []).filter((item) => item.id !== annotationId),
      { id: annotationId, text: note.text, at: note.at, ...(stopOutcome ? { stopOutcome } : {}),
        ...(typeof note.runId === "string" && note.runId && note.runId.length <= 200 ? { runId: note.runId } : {}) }]
      .sort((a, b) => a.at.localeCompare(b.at));
  }
  return next;
}

/** How a questionnaire card was settled, as the Hub recorded it. */
export interface QuestionnaireState {
  state: "answered" | "cancelled";
  /** What the person picked or typed, per question id, when answered. */
  answers?: Record<string, string[]>;
}

/** The card's settled state from the Hub's own annotation; absent while it is open. */
export function questionnaireStateOf(annotations: unknown): QuestionnaireState | undefined {
  for (const payload of hubJudgments(annotations, QUESTIONNAIRE_STATE_ANNOTATION_NAMESPACE)) {
    if (payload.state !== "answered" && payload.state !== "cancelled") continue;
    const answers = payload.answers && typeof payload.answers === "object" && !Array.isArray(payload.answers)
      ? Object.fromEntries(Object.entries(payload.answers as Record<string, unknown>).map(([id, values]) =>
        [id, Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : []]))
      : undefined;
    return { state: payload.state, ...(answers ? { answers } : {}) };
  }
  return undefined;
}

/** Message metadata keys only the Hub writes. Caller-supplied metadata drops them. */
export function isReservedMessageMetadataKey(key: string): boolean {
  return /^xmatrix/iu.test(key) || key === "crossChannelReply" || key === "appMentions";
}

/** Caller-supplied message metadata without the keys only the Hub may write. */
export function callerMessageMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([key]) => !isReservedMessageMetadataKey(key)),
  );
}
