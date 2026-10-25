import { channelActivityOf, channelActivityLine, type ChannelMessage, type ChannelSummarySource } from "@xmatrix/protocol";

/**
 * What a newly launched Agent reads before its first turn: the conversation it
 * was started in, rendered once here so the wording, budget and order change
 * with a Hub deploy instead of a CLI release.
 *
 * A daemon-spawned Run joins its Channel replaying nothing, so without this a
 * new Instance re-asks what the conversation already answered. The text goes
 * into the first prompt as read-only context; it is not a join replay, which
 * would turn every old message into a turn of its own.
 */

/** Ceiling on the transcript. A 400-message channel renders to about 80k characters, so ordinary
 * conversations are read whole and never cut. */
const LAUNCH_HISTORY_MAX_CHARS = 200_000;

interface LaunchCoWrite { version: 1; spaceId: string; pageId: string; active: boolean }

interface LaunchContext {
  /** Context and transcript, ready to append to the first prompt; absent when there is nothing to say. */
  text?: string;
  /** The newest sequence the text covers: the Run has read through it. */
  throughSequence?: number;
  /** The message the Run was started for, which the launch otherwise carries only as a body. */
  startedFor?: ChannelMessage;
  /** The latest co-writing instruction read here, which the join floor then steps past. */
  coWrite?: LaunchCoWrite;
}

/** Floored, never rounded up: a stated age has always already elapsed. */
export function relativeAge(sentAt: string, now: string): string | undefined {
  const sent = Date.parse(sentAt);
  const at = Date.parse(now);
  if (!Number.isFinite(sent) || !Number.isFinite(at)) return undefined;
  const seconds = Math.max(0, Math.floor((at - sent) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

/** One transcript entry: the UTC instant, then how long before the read it was. The age is the part
 * that matters: an Instance that subtracts `sentAt` from its own clock is wrong by its UTC offset. */
function renderHistoryEntry(message: ChannelMessage, readAt: string | undefined): string {
  const sequence = message.sequence === undefined ? "" : ` #${message.sequence}`;
  const age = readAt ? relativeAge(message.sentAt, readAt) : undefined;
  const head = `${message.sentAt}${age ? ` (${age})` : ""}${sequence} ${message.from.label} [${message.from.kind}] ` +
    `[messageId=${message.messageId}]` +
    // Who answers whom is read from replies, so a reply says which message it answers.
    (message.replyToMessageId ? ` [replyToMessageId=${message.replyToMessageId}]` : "");
  // Activity folds to one line, as it does on the web.
  const activity = message.recalledAt ? undefined : channelActivityOf(message.metadata);
  if (activity) return `${head}: ▸ ${channelActivityLine(activity)}\n`;
  let entry = `${head}:\n`;
  if (message.recalledAt) return `${entry}  (recalled)\n`;
  for (const line of message.body.split(/\r?\n/u)) entry += `  ${line}\n`;
  // Name each file and the read that saves it: downloading every image up front would slow every
  // launch for files most turns never look at.
  for (const attachment of message.attachments ?? []) {
    entry += `  [attachment] ${attachment.name} (${attachment.mimeType}, ${attachment.size} bytes) — run ` +
      `\`xmatrix channel history ${message.channelId}\` to save it locally and read it from the printed \`local:\` path\n`;
  }
  return entry;
}

function compareMessages(left: ChannelMessage, right: ChannelMessage): number {
  const order = (left.sequence ?? -1) - (right.sequence ?? -1);
  if (order) return order;
  if (left.sentAt !== right.sentAt) return left.sentAt < right.sentAt ? -1 : 1;
  return left.messageId < right.messageId ? -1 : left.messageId > right.messageId ? 1 : 0;
}

/** The Hub's own co-writing instruction, as the runtime would accept it. */
function launchCoWrite(message: ChannelMessage): LaunchCoWrite | undefined {
  const metadata = message.metadata;
  if (message.from.kind !== "system" || !metadata || metadata.xmatrixProvenance !== "system_fact" ||
      metadata.xmatrixSystemNotice !== true || !(Number(message.sequence) > 0) || !message.body ||
      message.editedAt || message.recalledAt || message.deletedAt) return undefined;
  const value = metadata.xmatrixPageCoWrite as Partial<LaunchCoWrite> | undefined;
  if (!value || value.version !== 1 || typeof value.spaceId !== "string" || !value.spaceId ||
      typeof value.pageId !== "string" || !value.pageId || typeof value.active !== "boolean") return undefined;
  return { version: 1, spaceId: value.spaceId, pageId: value.pageId, active: value.active };
}

/** The Channel's About, given only with a transcript cut to fit: it is derived from the transcript and
 * adds nothing to a whole one. Escaped so authored text cannot forge the block's markers. */
function renderAbout(about: { summary?: string; summarySource?: ChannelSummarySource } | undefined): string {
  let out = "## Channel context (read-only)\n";
  const summary = about?.summary?.trim();
  if (!summary) return `${out}\nSummary: unavailable.\n`;
  const source = about?.summarySource;
  const written = source
    ? `by ${source.author.agentName.replace(/</gu, "&lt;")}` +
      `${source.throughSequence === undefined ? "" : ` through #${source.throughSequence}`}` +
      ` at ${source.generatedAt.replace(/</gu, "&lt;")}; `
    : "";
  out += `\nSummary (${written}derived; may lag recent messages; where it contradicts the transcript, it wins):\n`;
  for (const line of about!.summary!.split(/\r?\n/u)) out += `  ${line.replace(/</gu, "&lt;")}\n`;
  return out;
}

/**
 * Renders what a launch reads. `messages` is the newest part of the Channel, any order; `complete`
 * says it reaches the Channel's first message. It states what the Channel holds and says nothing
 * about how to read it: what is open, done or meant for someone else is in the messages.
 */
export function renderLaunchContext(input: {
  channelId: string;
  messages: ChannelMessage[];
  complete: boolean;
  startedForId?: string;
  readAt?: string;
  maxChars?: number;
  about?: { summary?: string; summarySource?: ChannelSummarySource } | null;
}): LaunchContext & { cut: boolean } {
  const maxChars = input.maxChars ?? LAUNCH_HISTORY_MAX_CHARS;
  const seen = new Set<string>();
  const all = input.messages.slice().sort(compareMessages).filter((message) =>
    !seen.has(message.messageId) && Boolean(seen.add(message.messageId)));
  const result: LaunchContext & { cut: boolean } = { cut: false };
  const through = all.reduce<number | undefined>((max, message) =>
    message.sequence === undefined ? max : Math.max(max ?? 0, message.sequence), undefined);
  if (through !== undefined) result.throughSequence = through;
  const startedFor = input.startedForId ? all.find((message) => message.messageId === input.startedForId) : undefined;
  if (startedFor) result.startedFor = startedFor;
  for (const message of all) {
    const coWrite = launchCoWrite(message);
    if (coWrite) result.coWrite = coWrite;
  }
  const shown = all.filter((message) => message.messageId !== input.startedForId);
  // A new conversation's only message is the one the Run was started for: nothing goes in front of it.
  if (!shown.length) return result;
  const kept: string[] = [];
  let used = 0;
  for (let index = shown.length - 1; index >= 0; index--) {
    const entry = renderHistoryEntry(shown[index]!, input.readAt);
    const length = [...entry].length;
    if (used + length > maxChars && kept.length) break;
    used += length;
    kept.push(entry);
  }
  kept.reverse();
  const cut = kept.length < shown.length || !input.complete;
  const coverage = !cut
    ? `all ${shown.length} message(s), oldest first`
    : `the newest ${kept.length} message(s), oldest first; older messages were left out to fit — run ` +
      `\`xmatrix channel history ${input.channelId}\` to read them`;
  const clock = input.readAt ? ` Read at ${input.readAt}.` : "";
  const transcript = `Channel history for ${input.channelId} — ${coverage}.\n` +
    "Every timestamp below is UTC (RFC-3339, trailing `Z`), and each line carries how long before the " +
    `read it was sent.${clock} Quote those ages rather than recomputing them: your own clock may be in ` +
    "another zone, and an elapsed time measured against it is wrong by exactly that zone's UTC offset.\n\n" +
    `${kept.join("")}\nEnd of channel history.`;
  result.cut = cut;
  result.text = cut && input.about !== undefined ? `${renderAbout(input.about ?? undefined)}\n${transcript}` : transcript;
  return result;
}

/**
 * Reads the newest part of the Channel that fits the transcript budget, as `principal`, and renders
 * it. Pages run newest first and stop once the budget is spent, so a long conversation is no longer
 * read whole to keep only its end; the About is read only when the transcript was cut.
 */
export async function readLaunchContext(input: {
  channelId: string;
  startedForId?: string;
  readAt: string;
  history: (page: { beforeSequence?: number; limit: number }) => Promise<{ messages: ChannelMessage[]; hasMore: boolean }>;
  about: () => Promise<{ summary?: string; summarySource?: ChannelSummarySource } | null>;
}): Promise<LaunchContext> {
  const messages: ChannelMessage[] = [];
  let beforeSequence: number | undefined;
  let complete = false;
  let estimated = 0;
  for (;;) {
    const page = await input.history({ beforeSequence, limit: LAUNCH_HISTORY_PAGE });
    messages.push(...page.messages);
    for (const message of page.messages) estimated += message.body.length + 160;
    const oldest = page.messages.reduce<number | undefined>((min, message) =>
      message.sequence === undefined ? min : Math.min(min ?? message.sequence, message.sequence), undefined);
    if (!page.hasMore || oldest === undefined || oldest <= 0 || oldest === beforeSequence) {
      complete = !page.hasMore;
      break;
    }
    if (estimated > LAUNCH_HISTORY_MAX_CHARS) break;
    beforeSequence = oldest;
  }
  const render = (about?: { summary?: string; summarySource?: ChannelSummarySource } | null) => {
    const { cut, ...context } = renderLaunchContext({ channelId: input.channelId, messages, complete,
      startedForId: input.startedForId, readAt: input.readAt, about });
    return { cut, context };
  };
  const rendered = render();
  if (!rendered.cut) return rendered.context;
  // The About is derived from the transcript; it is worth its read only when part of it was left out.
  return render(await input.about().catch(() => null)).context;
}

const LAUNCH_HISTORY_PAGE = 200;
