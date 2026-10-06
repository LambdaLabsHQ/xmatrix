import { utf8ByteLength } from "@xmatrix/protocol";
import { PostgresChannelCatalogRepository, PostgresMessageRepository, type AuthorityDatabase } from "@xmatrix/db";
import { postgresProductMessage } from "./postgres-message-authority";

const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(value));
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};

/** Project only authorized public content; never pass raw metadata or sender identities. */
export function launchChannelContext(input: {
  channelId: string; sourceMessageId: string; sourceSequence: number;
  catalog: Record<string, unknown>; history: Record<string, unknown>;
}): Record<string, unknown> {
  let clipped = false;
  const text = (value: unknown, maximum: number) => {
    if (typeof value !== "string") return undefined;
    let result = "";
    for (const character of value) {
      if (bytes(result + character) > maximum) { clipped = true; break; }
      result += character;
    }
    return result;
  };
  const channels = (Array.isArray(input.catalog.channels) ? input.catalog.channels : []).map(record);
  const pathValue = record(input.catalog.pathsByChannelId)[input.channelId];
  const path = Array.isArray(pathValue) ? pathValue.filter((id): id is string => typeof id === "string") : [];
  if (!channels.some(channel => channel.id === input.channelId) || !path.includes(input.channelId)) {
    throw new Error("Launch channel context is unavailable");
  }
  const selectedPath = path.slice(-5);
  const hierarchy = selectedPath.map(id => channels.find(channel => channel.id === id)).filter(channel => !!channel)
    .map(channel => ({ channelId: channel.id, version: channel.version,
      name: text(channel.name, 256), topic: text(channel.topic, 768), summary: text(channel.summary, 1024) }));
  const context = { source: "authorized-channel-authority", channelId: input.channelId,
    sourceMessageId: input.sourceMessageId, beforeSequence: input.sourceSequence,
    observedAt: new Date().toISOString(), hierarchy,
    hierarchyTruncated: path.length > selectedPath.length,
    historyTruncated: input.history.hasMore === true,
    fieldsTruncated: false, messages: [] as Record<string, unknown>[] };
  while (bytes(context) > 11_500 && context.hierarchy.length > 1) {
    context.hierarchy.shift(); context.hierarchyTruncated = true;
  }
  const messages = (Array.isArray(input.history.messages) ? input.history.messages : []).map(record)
    .filter(message => message.channelId === input.channelId && Number.isSafeInteger(message.sequence) &&
      Number(message.sequence) < input.sourceSequence && !message.recalledAt && !message.deletedAt)
    .sort((a, b) => Number(b.sequence) - Number(a.sequence));
  for (const message of messages.slice(0, 20)) {
    const projected = { messageId: text(message.messageId, 256), sequence: message.sequence,
      sentAt: text(message.sentAt, 64), body: text(message.body, 1536),
      ...(message.editedAt ? { editedAt: text(message.editedAt, 64) } : {}),
      ...(message.replyToMessageId ? { replyToMessageId: text(message.replyToMessageId, 256) } : {}) };
    if (bytes({ ...context, messages: [...context.messages, projected] }) > 12_000) {
      context.historyTruncated = true; break;
    }
    context.messages.push(projected);
  }
  context.historyTruncated ||= messages.length > 20;
  context.fieldsTruncated = clipped;
  context.messages.reverse();
  return context;
}

export function registrationLaunchContextReader(input: {
  database: AuthorityDatabase; spaceId: string; channelId: string; sourceMessageId: string; actorUserId: string;
}) {
  let cached: Promise<Record<string, unknown>> | undefined;
  return (sourceSequence: number) => {
    if (!Number.isSafeInteger(sourceSequence) || sourceSequence < 1) throw new Error("Invalid launch context boundary");
    return cached ??= (async () => {
      const principal = { kind: "user" as const, id: input.actorUserId };
      const requestId = `launch-context:${crypto.randomUUID()}`;
      const results = await Promise.allSettled([
        new PostgresChannelCatalogRepository(input.database).resolve({ requestId, spaceId: input.spaceId, principal,
          channelIds: [input.channelId], includeParticipants: false }),
        new PostgresMessageRepository(input.database).history({ requestId, spaceId: input.spaceId, principal,
          channelId: input.channelId, beforeSequence: sourceSequence, limit: 20 }),
      ]);
      const [catalog, history] = results;
      if (catalog.status === "rejected") throw catalog.reason;
      if (history.status === "rejected") throw history.reason;
      return launchChannelContext({ ...input, sourceSequence, catalog: catalog.value,
        history: { ...history.value, messages: history.value.messages.map(postgresProductMessage) } });
    })();
  };
}
