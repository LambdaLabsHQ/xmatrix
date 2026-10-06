/**
 * Natural keys for live Agent Instances and their Runs.
 *
 * An Instance is the N-th Agent in one Channel: `(channelId, channelInstanceId)`.
 * A Run is the k-th start of one Instance. A Channel About Session is not a
 * Channel Instance and receives no ordinal, so its Runs are keyed by the
 * Channel alone. Ordinals travel as decimal strings; historical ordinals at or
 * above 8e15 are valid keys that new allocation never produces.
 *
 * See docs/architecture/instance-run-natural-keys.md.
 */

export interface InstanceKey {
  channelId: string;
  channelInstanceId: string;
}

export interface InstanceRunKey extends InstanceKey {
  runOrdinal: string;
}

export interface AboutRunKey {
  channelId: string;
  about: true;
  runOrdinal: string;
}

export type RunKey = InstanceRunKey | AboutRunKey;

const ORDINAL_RE = /^[1-9]\d{0,15}$/u;

export function isChannelOrdinal(value: unknown): value is string {
  return typeof value === "string" && ORDINAL_RE.test(value) && Number.isSafeInteger(Number(value));
}

const INSTANCE_ID_RE = /^(.+):([1-9]\d{0,15})$/u;
const RUN_ID_RE = /^(.+):([1-9]\d{0,15})#([1-9]\d{0,15})$/u;
const ABOUT_RUN_ID_RE = /^(.+):about#([1-9]\d{0,15})$/u;

/** The stored id of an Instance is its key: `<channelId>:<ordinal>`. */
export function naturalInstanceId(key: InstanceKey): string {
  return `${key.channelId}:${key.channelInstanceId}`;
}

/** The stored id of a Run is its key: `<channelId>:<ordinal>#<k>`, or `<channelId>:about#<k>`. */
export function naturalRunId(key: RunKey): string {
  return "about" in key ? `${key.channelId}:about#${key.runOrdinal}`
    : `${key.channelId}:${key.channelInstanceId}#${key.runOrdinal}`;
}

export function parseNaturalInstanceId(id: string): InstanceKey | null {
  const match = INSTANCE_ID_RE.exec(id);
  if (!match || !isChannelOrdinal(match[2])) return null;
  return { channelId: match[1]!, channelInstanceId: match[2]! };
}

export function parseNaturalRunId(id: string): RunKey | null {
  const about = ABOUT_RUN_ID_RE.exec(id);
  if (about) return isChannelOrdinal(about[2]) ? { channelId: about[1]!, about: true, runOrdinal: about[2]! } : null;
  const match = RUN_ID_RE.exec(id);
  if (!match || !isChannelOrdinal(match[2]) || !isChannelOrdinal(match[3])) return null;
  return { channelId: match[1]!, channelInstanceId: match[2]!, runOrdinal: match[3]! };
}
