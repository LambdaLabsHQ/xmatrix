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

/** The id of the message that superseded this one, when the Hub judged so. */
export function supersededByOf(annotations: unknown): string | undefined {
  if (!Array.isArray(annotations)) return undefined;
  for (const entry of annotations) {
    if (!entry || typeof entry !== "object") continue;
    const annotation = entry as Record<string, unknown>;
    if (annotation.namespace !== SUPERSEDED_ANNOTATION_NAMESPACE ||
        annotation.authorUserId !== SYSTEM_ANNOTATION_AUTHOR) continue;
    const payload = annotation.payload;
    const by = payload && typeof payload === "object" ? (payload as Record<string, unknown>).supersededBy : undefined;
    if (typeof by === "string" && by) return by;
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
