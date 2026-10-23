import { parseMessageInteraction, type AgentControlOutcomeRecord, type ChannelMessage } from "@xmatrix/protocol";

/**
 * What the Hub said about a command a message wrote, drawn on that command
 * the way a summon's progress is drawn on its `@`. The Hub records it on the
 * command message (`commandResult`); an older Hub posted it as a system
 * notice naming the command, which folds onto the command the same way.
 */
export type CommandNotice = {
  messageId: string;
  body: string;
  sentAt: string;
  /** `/model` and `/effort`: what each written statement came to, in order. */
  controlOutcomes?: readonly AgentControlOutcomeRecord[];
  /** A stop command's notice that settles it, when the Hub said which way. */
  stopOutcome?: "stopped" | "not_stopped";
  /** The Run it is about: the summon chip that started that Run shows it. */
  runId?: string;
};

function noticeSource(message: ChannelMessage): string | undefined {
  const metadata = message.metadata;
  if (metadata?.xmatrixSystemNotice !== true) return undefined;
  return typeof metadata.sourceMessageId === "string" && metadata.sourceMessageId
    ? metadata.sourceMessageId : undefined;
}

/** True when `body` names `@agent:ordinal` as a whole address. */
function namesAddress(body: string, agentName: string, ordinal: number): boolean {
  const address = `@${agentName}:${ordinal}`.toLowerCase();
  const text = body.toLowerCase();
  for (let at = text.indexOf(address); at >= 0; at = text.indexOf(address, at + 1)) {
    if (!/\d/u.test(text[at + address.length] ?? "")) return true;
  }
  return false;
}

function controlOutcomes(value: unknown): AgentControlOutcomeRecord[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const records = value.filter((record): record is AgentControlOutcomeRecord =>
    Boolean(record) && typeof record === "object" && typeof (record as { status?: unknown }).status === "string");
  return records.length === value.length ? records : undefined;
}

/**
 * Which loaded system notices answer a command in a loaded message, keyed by
 * that message. A notice whose command is not loaded, edited or recalled
 * keeps its own row: there is nothing on screen to draw it on. A switch's
 * continuation is the Instance's instruction to resume, not news for anyone
 * reading: it folds away with the switch it follows.
 */
export function foldCommandNotices(history: readonly ChannelMessage[]): {
  noticesBySource: Map<string, CommandNotice[]>;
  folded: Set<string>;
} {
  const byId = new Map(history.map((message) => [message.messageId, message]));
  const interactions = new Map<string, ReturnType<typeof parseMessageInteraction>>();
  const noticesBySource = new Map<string, CommandNotice[]>();
  const folded = new Set<string>();
  for (const message of history) {
    const recorded = message.recalledAt || message.editedAt ? [] : recordedNotices(message);
    if (recorded.length) noticesBySource.set(message.messageId, recorded);
  }
  for (const message of history) {
    const sourceId = noticeSource(message);
    const source = sourceId ? byId.get(sourceId) : undefined;
    if (!source || source.recalledAt || source.editedAt || message.recalledAt) continue;
    let interaction = interactions.get(source.messageId);
    if (!interaction) interactions.set(source.messageId, interaction = parseMessageInteraction(source.body));
    const metadata = message.metadata ?? {};
    const answers = interaction.controls.length > 0 || interaction.stop !== undefined ||
      [...interaction.reborn.map(({ agentName, channelInstanceId }) => ({ agentName, channelInstanceId })),
        ...interaction.handoff.map(({ sourceAgentName, channelInstanceId }) => ({ agentName: sourceAgentName, channelInstanceId }))]
        .some(({ agentName, channelInstanceId }) => namesAddress(message.body, agentName, channelInstanceId));
    if (!answers) continue;
    folded.add(message.messageId);
    if (metadata.xmatrixSwitchContinuation !== undefined) continue;
    const outcomes = controlOutcomes(metadata.controlOutcomes);
    const stopOutcome = metadata.stopCommandOutcome === "stopped" || metadata.stopCommandOutcome === "not_stopped"
      ? metadata.stopCommandOutcome : undefined;
    const notices = noticesBySource.get(source.messageId) ?? [];
    notices.push({ messageId: message.messageId, body: message.body, sentAt: message.sentAt,
      ...(outcomes ? { controlOutcomes: outcomes } : {}), ...(stopOutcome ? { stopOutcome } : {}) });
    noticesBySource.set(source.messageId, notices);
  }
  return { noticesBySource, folded };
}

/** The result the Hub recorded on a command message, as the notices a chip reads. */
function recordedNotices(message: ChannelMessage): CommandNotice[] {
  const result = message.commandResult;
  if (!result) return [];
  return [
    ...(result.controls ? [{ messageId: `${message.messageId}:controls`, body: "", sentAt: message.sentAt,
      controlOutcomes: result.controls }] : []),
    ...(result.notes ?? []).map((note) => ({ messageId: note.id, body: note.text, sentAt: note.at,
      ...(note.stopOutcome ? { stopOutcome: note.stopOutcome } : {}), ...(note.runId ? { runId: note.runId } : {}) })),
  ];
}

/** The notices that name this reborn or handoff address. */
export function noticesNaming(notices: readonly CommandNotice[] | undefined, agentName: string, ordinal: number): CommandNotice[] {
  return (notices ?? []).filter((notice) => namesAddress(notice.body, agentName, ordinal));
}
