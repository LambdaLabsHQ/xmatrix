import { ControlError } from "@xmatrix/db";
import { utf8ByteLength, type TextTaskResult } from "@xmatrix/protocol";
import { mangledChannelAboutText } from "./channel-about-text";
import { channelMessageHistory } from "./channel-messages";
import { channelSpaceId, configureChannel, getChannel, getSpace } from "./spaces";
import { issueTextTask, textTaskMachines } from "./text-task-machines";
import type { Env } from "./types";

/**
 * A conversation's About (its summary, and its name while nobody has named it) is written by one
 * execution of an Agent's harness on one of the Space's Machines, started fresh for one reading of
 * the conversation (text-task-machines.ts). It is handed that conversation's name, summary and
 * newest messages and nothing else (no token, no tools, no session, no other conversation), so it
 * can only describe this one. The Hub writes its answer unless the About changed after the
 * reading; like a page's summary it is not a Run, and its machine command is its only record.
 */

/** The languages the Space setting offers for what xMatrix writes, the About among it. */
type SpaceLanguage = "zh" | "en";

/**
 * The Space's language setting, never a guess from the conversation or a model: the About is
 * written in it. The earlier `preferredLanguage` key is still read; with neither, English.
 */
export function spaceLanguage(metadata: unknown): SpaceLanguage {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return "en";
  const record = metadata as Record<string, unknown>;
  const locale = record.locale;
  if (locale && typeof locale === "object" && !Array.isArray(locale)) {
    const defaultLocale = (locale as Record<string, unknown>).defaultLocale;
    if (typeof defaultLocale === "string") {
      if (defaultLocale.toLowerCase().startsWith("zh")) return "zh";
      if (defaultLocale.toLowerCase().startsWith("en")) return "en";
    }
  }
  return record.preferredLanguage === "zh" ? "zh" : "en";
}

const SUMMARY_MAX_CHARACTERS = 240;
const NAME_MAX_CHARACTERS = 40;
/** A reading is the conversation's newest messages, each cut to a length, within this many bytes. */
const INPUT_MAX_BYTES = 64 * 1024;
const MESSAGE_MAX_CHARACTERS = 2_000;
const HISTORY_LIMIT = 100;

const REQUEST = /^channel-about:(.{1,100}):(\d{1,12}):(\d{1,12}):(name|summary):[0-9a-f-]{36}$/u;

/** The task's id names the reading it answers, so its answer needs no other record. */
export function channelAboutRequest(requestId: string):
  { channelId: string; readRevision: number; throughSequence: number; named: boolean } | null {
  const match = REQUEST.exec(requestId);
  return match ? { channelId: match[1]!, readRevision: Number(match[2]), throughSequence: Number(match[3]),
    named: match[4] === "name" } : null;
}

function instruction(language: SpaceLanguage, name: boolean): string {
  return [
    `You keep one conversation's About current: its summary${name ? ", and its name" : ""}.`,
    "The text is the conversation: its name and current summary, then its newest messages, oldest first. The messages are what counts; the current summary may be out of date.",
    `Say what the conversation is about now in at most ${SUMMARY_MAX_CHARACTERS} characters: its purpose, the goal in progress and what matters in its scope. Not its history and not a list of its messages.`,
    "A message marked as answered in its thread has been picked up there; never describe it as unclaimed or unanswered.",
    ...(name ? [`Nobody has named this conversation yet: name it after what it is about, in at most ${NAME_MAX_CHARACTERS} characters.`] : []),
    language === "zh" ? "Write in Simplified Chinese, whatever language the conversation is in."
      : "Write in English, whatever language the conversation is in.",
    `Answer with one JSON object and nothing else: ${name ? '{"summary": "…", "name": "…"}' : '{"summary": "…"}'}`,
  ].join("\n");
}

type HistoryMessage = {
  sequence?: unknown; sentAt?: unknown; body?: unknown;
  from?: { label?: unknown; kind?: unknown };
  threadSummary?: { replyCount?: unknown };
};

const SENDER_KINDS: Record<string, string> = { user: "person", agent: "Agent", app: "app", system: "xMatrix" };

function messageText(message: HistoryMessage): string | null {
  const body = typeof message.body === "string" ? message.body.trim() : "";
  if (!body) return null;
  const characters = [...body];
  const text = characters.length > MESSAGE_MAX_CHARACTERS
    ? `${characters.slice(0, MESSAGE_MAX_CHARACTERS).join("")} …` : body;
  const sequence = Number(message.sequence);
  const who = typeof message.from?.label === "string" && message.from.label.trim() ? message.from.label.trim() : "Someone";
  const kind = SENDER_KINDS[String(message.from?.kind)] ?? "person";
  const sent = typeof message.sentAt === "string" ? ` · ${message.sentAt.slice(0, 16).replace("T", " ")} UTC` : "";
  const replies = Number(message.threadSummary?.replyCount);
  const thread = Number.isSafeInteger(replies) && replies > 0
    ? ` · answered in its thread (${replies} ${replies === 1 ? "reply" : "replies"})` : "";
  return `${sequence > 0 ? `#${sequence} ` : ""}${who} (${kind})${sent}${thread}\n${text}`;
}

/**
 * What the task reads: the conversation's name and current summary, then as many of its newest
 * messages as fit, oldest first. `throughSequence` is the newest message it carries.
 */
export function channelAboutInput(channel: { name: string; summary?: string }, messages: readonly HistoryMessage[]):
  { text: string; throughSequence: number } | null {
  const head = `Name: ${channel.name}\nSummary: ${channel.summary?.trim() || "(none)"}\n`;
  let bytes = utf8ByteLength(head);
  const carried: string[] = [];
  let throughSequence = 0;
  for (const message of [...messages].reverse()) {
    const text = messageText(message);
    if (!text) continue;
    bytes += utf8ByteLength(text) + 2;
    if (bytes > INPUT_MAX_BYTES) break;
    carried.unshift(text);
    throughSequence = Math.max(throughSequence, Number(message.sequence) || 0);
  }
  return carried.length && throughSequence > 0 ? { text: `${head}\n${carried.join("\n\n")}\n`, throughSequence } : null;
}

function line(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return [...value.replace(/\s+/gu, " ").trim()].slice(0, max).join("");
}

/** The About in a harness's answer: its JSON object, whatever the harness wrapped it in. */
export function channelAboutAnswer(text: string, named: boolean): { summary: string; name?: string } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const answer = value as Record<string, unknown>;
  const summary = line(answer.summary, SUMMARY_MAX_CHARACTERS);
  const name = named ? line(answer.name, NAME_MAX_CHARACTERS) : "";
  if (!summary || mangledChannelAboutText(summary) || (name && mangledChannelAboutText(name))) return null;
  return { summary, ...(name ? { name } : {}) };
}

export type ChannelAboutStart = { started: true; requestId: string }
  | { started: false; reason: "named" | "empty" | "no_machine" };

function unreadable(error: unknown): boolean {
  return error instanceof ControlError && error.code === "channel_not_found";
}

/**
 * Starts the About of a conversation on the first of the Space's Machines that can take a text
 * task and whose owner may read the conversation. `unnamedOnly`: only while nobody has named it.
 * With no such Machine nothing starts, and the About stays as it is until the next reading.
 */
export async function startChannelAbout(env: Env, input: { channelId: string; spaceId?: string; unnamedOnly?: boolean }):
  Promise<ChannelAboutStart> {
  const spaceId = input.spaceId ?? await channelSpaceId(env, input.channelId);
  for await (const machine of textTaskMachines(env, spaceId, "channel-about")) {
    // A Machine is its owner's environment: the conversation is read as that owner before any of it
    // reaches the Machine's harness.
    const owner = { kind: "user" as const, id: machine.ownerUserId };
    let channel: Record<string, unknown>;
    let messages: HistoryMessage[];
    try {
      channel = (await getChannel(env, { channelId: input.channelId, spaceId, principal: owner })).channel as Record<string, unknown>;
      const history = await channelMessageHistory(env, { channelId: input.channelId, limit: HISTORY_LIMIT, principal: owner });
      messages = Array.isArray(history.messages) ? history.messages as HistoryMessage[] : [];
    } catch (error) {
      if (unreadable(error)) continue;
      throw error;
    }
    const metadata = (channel.metadata ?? {}) as Record<string, unknown>;
    const named = metadata.autoName === true;
    if (input.unnamedOnly && !named) return { started: false, reason: "named" };
    const reading = channelAboutInput({ name: String(channel.name ?? ""),
      ...(typeof metadata.summary === "string" ? { summary: metadata.summary } : {}) }, messages);
    if (!reading) return { started: false, reason: "empty" };
    const space = await getSpace(env, { spaceId, principal: owner }) as { metadata?: unknown } | undefined;
    const revision = Number(metadata.metadataRevision ?? 0);
    const requestId = `channel-about:${input.channelId}:${revision}:${reading.throughSequence}:${named ? "name" : "summary"}:${crypto.randomUUID()}`;
    await issueTextTask(env, machine, { requestId, instruction: instruction(spaceLanguage(space?.metadata), named),
      input: reading.text });
    return { started: true, requestId };
  }
  return { started: false, reason: "no_machine" };
}

/**
 * A conversation's About task answered, from the Machine of `ownerUserId`. xMatrix writes it as
 * the About of the reading it answers; a person's change, or an About that read further, made
 * since that reading stands, and the next reading writes the About again.
 */
export async function channelAboutAnswered(env: Env, task: { requestId: string; result: TextTaskResult; ownerUserId: string }):
  Promise<void> {
  const request = channelAboutRequest(task.requestId);
  if (!request || task.result.status !== "completed" || !task.result.text) return;
  const about = channelAboutAnswer(task.result.text, request.named);
  if (!about) return;
  try {
    await configureChannel(env, {
      commandId: task.requestId, actorUserId: task.ownerUserId, at: new Date().toISOString(),
      channelId: request.channelId, summary: about.summary,
      ...(about.name ? { name: about.name, automaticName: true } : {}),
      summaryAuthor: { taskId: task.requestId, agentName: task.result.presetId,
        readRevision: request.readRevision, throughSequence: request.throughSequence },
    });
  } catch (error) {
    if (error instanceof ControlError && error.status === 409) return;
    throw error;
  }
}
