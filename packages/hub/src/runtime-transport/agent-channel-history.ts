import type {
  AgentInstanceClientMessage,
  AgentInstanceServerMessage,
} from "@xmatrix/protocol/connections/agent-instance";
import { crossChannelReplyRelay, type ChannelMessage, type SerializedAgent, utf8ByteLength } from "@xmatrix/protocol";
import { channelMessage, channelMessageDeliveryIntent } from "./channel-message-frame";
import type { AgentInstanceRuntimeSession } from "./agent-instance-port";
import type { AgentChannelHistoryPort } from "./postgres-agent-instance-port";

type Message<Type extends AgentInstanceClientMessage["type"]> = Extract<
  AgentInstanceClientMessage,
  { type: Type }
>;

const MAX_HISTORY_MESSAGES = 100;
/** One PostgreSQL history read returns at most this many messages. */
const MAX_READ_MESSAGES = 50;
/** historyLimit 0 still catches up after the stored cursor. */
const DEFAULT_CATCHUP_LIMIT = 50;
const MAX_HISTORY_WINDOW_BYTES = 1024 * 1024;

/** Observability attached to join/replay outputs for channel_history_replayed. */
export type AgentChannelReplayObservability = {
  mode: "join_catchup" | "afterSequence" | "join_birth";
  limit: number;
  entryCount: number;
  afterSequence: number;
  cursorSequence: number;
  effectiveAfterSequence: number;
  replayedSequence: number;
  tailSequence: number;
  truncated: boolean;
};

export type AgentChannelReplayBatch = readonly AgentInstanceServerMessage[] & {
  readonly observability?: AgentChannelReplayObservability;
};

/** One bounded history read as the Agent, newest-bounded by exactly one cursor. */
export interface AgentChannelHistoryRead {
  channelId: string;
  agentId: string;
  limit: number;
  afterSequence?: number;
  beforeSequence?: number;
  before?: string;
}

export interface AgentChannelHistoryPage {
  /** Ascending by sequence. */
  messages: readonly ChannelMessage[];
  /** The Channel's newest sequence, including facts that are not messages. */
  headSequence: number;
  /** This Agent's durable acknowledged sequence in the Channel. */
  ackedSequence: number;
}

export type ReadAgentChannelHistory = (read: AgentChannelHistoryRead) => Promise<AgentChannelHistoryPage>;

type ReplayQuery = { mode: "latest" | "after"; limit: number; afterSequence?: number };

/**
 * An Agent Instance socket's view of Channel history. PostgreSQL is the only
 * source; this class owns the per-socket cursor, the durable ack floor, which
 * messages a replay hands over as work or as context, and the read bounds.
 */
export class AgentChannelHistory implements AgentChannelHistoryPort {
  private readonly active = new WeakMap<object, string>();
  /** Last joined or replayed sequence per Agent session and Channel. */
  private readonly cursors = new WeakMap<object, Map<string, number>>();

  constructor(private readonly dependencies: {
    read: ReadAgentChannelHistory;
    serializeAgent(session: Readonly<AgentInstanceRuntimeSession>): SerializedAgent;
  }) {}

  async join(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"join_channel">,
  ): Promise<AgentChannelReplayBatch> {
    const requestedLimit = historyLimit(message.historyLimit, true);
    assertRunChannelBinding(session, message.channelId);
    this.active.set(session, message.channelId);
    const output: AgentInstanceServerMessage[] = [{
      type: "channel_joined",
      requestId: message.requestId,
      channelId: message.channelId,
      agent: this.dependencies.serializeAgent(session),
    }];
    if (session.run.channelDeliveryEnabled === false) {
      // Focus and Channel About Runs use this Channel only as execution scope.
      // Advance their ephemeral socket cursor to the current tail without
      // loading payloads or turning unrelated Channel history into work.
      const { tail } = await this.head(session, message.channelId);
      this.setCursor(session, message.channelId, tail);
      return output;
    }
    const clientAfter = message.afterSequence === undefined
      ? undefined
      : sequence(message.afterSequence, "afterSequence");

    // The durable acknowledged sequence is the floor for every join shape. The
    // in-memory cursor below only lives as long as this socket, so without it a
    // new process — reconnect, reborn, live-update successor — would be served
    // the whole backlog it already acknowledged.
    const { tail, ackedFloor } = await this.head(session, message.channelId);

    // Explicit afterSequence + positive limit: load that history window.
    if (clientAfter !== undefined && requestedLimit > 0) {
      const storedCursor = Math.max(this.getCursor(session, message.channelId) ?? 0, ackedFloor);
      const effectiveAfter = Math.max(clientAfter, storedCursor);
      const batch = await this.replayMessages(session, message.channelId, tail, {
        mode: "after",
        limit: requestedLimit,
        afterSequence: effectiveAfter,
      }, {
        mode: "afterSequence",
        requestedAfterSequence: clientAfter,
        effectiveAfterSequence: effectiveAfter,
      });
      output.push(...batch);
      return Object.assign(output, { observability: batch.observability });
    }

    // historyLimit 0 (reconnect zero-history): catch up after the stored cursor
    // without loading a large historical window.
    if (requestedLimit === 0) {
      const socketCursor = this.getCursor(session, message.channelId);
      // Nothing says this principal was ever owed anything here: no ack, no
      // socket cursor, no client read. "After 0" would be the channel's oldest
      // messages served as fresh tasks; a headless Instance reads the channel
      // into its own first prompt instead.
      if (clientAfter === undefined && socketCursor === undefined && ackedFloor === 0) {
        return output;
      }
      const storedCursor = Math.max(socketCursor ?? 0, ackedFloor);
      // The client's offer can only raise the floor, never rewind it: it is
      // what this process already holds — the history it read into its first
      // prompt, or what it acknowledged before a reconnect. Re-serving that as
      // catch-up turns hours-old `/kill all`, stops and summons into new work.
      const effectiveAfter = Math.max(Math.min(clientAfter ?? 0, tail), storedCursor);
      this.setCursor(session, message.channelId, effectiveAfter);
      const batch = await this.replayMessages(session, message.channelId, tail, {
        mode: "after",
        limit: DEFAULT_CATCHUP_LIMIT,
        afterSequence: effectiveAfter,
      }, {
        mode: "join_catchup",
        requestedAfterSequence: clientAfter ?? storedCursor,
        effectiveAfterSequence: effectiveAfter,
      });
      output.push(...batch);
      return Object.assign(output, { observability: batch.observability });
    }

    // Join with a positive historyLimit for an agent that already acknowledged
    // part of this channel: it is a successor instance, not a newcomer, so it
    // only gets what it has not accepted yet.
    if (ackedFloor > 0) {
      const batch = await this.replayMessages(session, message.channelId, tail, {
        mode: "after",
        limit: requestedLimit,
        afterSequence: ackedFloor,
      }, {
        mode: "join_catchup",
        requestedAfterSequence: ackedFloor,
        effectiveAfterSequence: ackedFloor,
      });
      output.push(...batch);
      this.setCursor(session, message.channelId, ackedFloor);
      return Object.assign(output, { observability: batch.observability });
    }

    // Fresh join with positive historyLimit and no afterSequence: replay the latest
    // bounded window so the agent starts with the same channel context a Human UI
    // receives from focusChannel. For a thread this window includes its root.
    const batch = await this.replayMessages(session, message.channelId, tail, {
      mode: "latest",
      limit: requestedLimit,
    }, {
      mode: "join_birth",
      requestedAfterSequence: 0,
      effectiveAfterSequence: 0,
    });
    output.push(...batch);
    this.setCursor(session, message.channelId, tail);
    return Object.assign(output, { observability: batch.observability });
  }

  async leave(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"leave_channel">,
  ): Promise<AgentInstanceServerMessage> {
    assertRunChannelBinding(session, message.channelId);
    if (this.active.get(session) === message.channelId) this.active.delete(session);
    return {
      type: "channel_left",
      requestId: message.requestId,
      channelId: message.channelId,
      agent: this.dependencies.serializeAgent(session),
    };
  }

  async replay(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"replay_channel_history">,
  ): Promise<AgentChannelReplayBatch> {
    if (this.active.get(session) !== message.channelId) {
      throw new Error("Agent Instance is not active in the requested channel");
    }
    assertRunChannelBinding(session, message.channelId);
    if (session.run.channelDeliveryEnabled === false) return [];
    const requestedLimit = historyLimit(message.historyLimit, true);
    // A missing afterSequence falls back to the stored join cursor, and a stale
    // client waterline cannot rewind below it. Acknowledged messages are never
    // replayed again, whichever cursor the reconnecting client offers.
    const { tail, ackedFloor } = await this.head(session, message.channelId);
    const storedCursor = this.getCursor(session, message.channelId);
    const clientAfter = message.afterSequence === undefined
      ? undefined
      : sequence(message.afterSequence, "afterSequence");
    if (clientAfter === undefined && storedCursor === undefined && ackedFloor === 0) return [];
    const effectiveAfter = Math.max(clientAfter ?? 0, storedCursor ?? 0, ackedFloor);
    // historyLimit 0 still catches up after the cursor.
    const catchUpLimit = requestedLimit === 0 ? DEFAULT_CATCHUP_LIMIT : requestedLimit;
    return this.replayMessages(session, message.channelId, tail, {
      mode: "after",
      limit: catchUpLimit,
      afterSequence: effectiveAfter,
    }, {
      mode: "afterSequence",
      requestedAfterSequence: clientAfter ?? storedCursor ?? ackedFloor,
      effectiveAfterSequence: effectiveAfter,
    });
  }

  async history(
    session: Readonly<AgentInstanceRuntimeSession>,
    message: Message<"get_channel_history">,
  ): Promise<AgentInstanceServerMessage> {
    assertRunChannelBinding(session, message.channelId);
    if (session.run.channelDeliveryEnabled === false) {
      return { type: "channel_history", requestId: message.requestId, channelId: message.channelId, messages: [] };
    }
    const query = historyQuery(message);
    const page = await this.read(session, message.channelId, query);
    return {
      type: "channel_history",
      requestId: message.requestId,
      channelId: message.channelId,
      messages: [...page.messages],
    };
  }

  /** The Channel head and this Agent's ack floor, from a one-message read. */
  private async head(
    session: Readonly<AgentInstanceRuntimeSession>,
    channelId: string,
  ): Promise<{ tail: number; ackedFloor: number }> {
    const page = await this.dependencies.read({ channelId, agentId: session.principal.agentId, limit: 1 });
    const tail = sequence(page.headSequence, "headSequence");
    return { tail, ackedFloor: Math.min(sequence(page.ackedSequence, "ackedSequence"), tail) };
  }

  private async read(
    session: Readonly<AgentInstanceRuntimeSession>,
    channelId: string,
    query: Omit<AgentChannelHistoryRead, "channelId" | "agentId">,
  ): Promise<AgentChannelHistoryPage> {
    const limit = Math.min(query.limit, MAX_READ_MESSAGES);
    const page = await this.dependencies.read({ ...query, limit, channelId, agentId: session.principal.agentId });
    if (page.messages.length > limit) throw new Error("Channel history limit exceeded");
    let prior = -1;
    for (const entry of page.messages) {
      if (entry?.channelId !== channelId) throw new Error("Channel history message is outside the channel");
      const current = sequence(entry.sequence, "message.sequence");
      if (current <= prior) throw new Error("Channel history message ordering is invalid");
      prior = current;
    }
    if (utf8ByteLength(JSON.stringify(page.messages)) > MAX_HISTORY_WINDOW_BYTES) {
      throw new Error("Channel history window exceeds its byte bound");
    }
    return page;
  }

  private async replayMessages(
    session: Readonly<AgentInstanceRuntimeSession>,
    channelId: string,
    tail: number,
    query: ReplayQuery,
    metric: {
      mode: AgentChannelReplayObservability["mode"];
      requestedAfterSequence: number;
      effectiveAfterSequence: number;
    },
  ): Promise<AgentChannelReplayBatch> {
    const page = await this.read(session, channelId, {
      limit: query.limit,
      ...(query.afterSequence !== undefined ? { afterSequence: query.afterSequence } : {}),
    });
    const frames = page.messages.flatMap((entry) => {
      if (entry.from.kind === "agent" &&
          (entry.from.identityId === session.principal.agentId ||
           (entry.from.userId === session.principal.ownerUserId &&
            entry.from.agentName === session.principal.agentName))) return [];
      // Same builder as live delivery, and the message travels nested: a replay
      // cannot describe a different message than the live frame for the same id.
      const message = channelMessage(entry);
      if (!message) return [];
      // This Instance's own reply relayed back from a cross-Channel link.
      const relay = crossChannelReplyRelay(message.metadata);
      if (relay?.replierInstanceId === session.run.instanceId) return [];
      // A relayed answer to another Instance's request is context here.
      const answerIsAnothers = !!relay?.requesterInstanceId &&
        relay.requesterInstanceId !== session.run.instanceId;
      // A join window is orientation, not a backlog of work: the reader is a
      // newcomer to this channel and nothing here was ever addressed to it as
      // work. Catch-up is the opposite — it is exactly the work the cursor
      // says this principal never received. A system fact is context in either.
      const deliveryIntent = metric.mode === "join_birth" || answerIsAnothers
        ? "context" as const
        : channelMessageDeliveryIntent(message);
      return [{
        type: "channel_history_replay" as const,
        message,
        ackRequired: true,
        ...(deliveryIntent === "context" ? { deliveryIntent } : {}),
      }];
    });
    const sequences = page.messages
      .map((entry) => entry.sequence)
      .filter((value): value is number => Number.isSafeInteger(value));
    // A full page stops at its newest message; anything shorter read through to
    // the head. Timeline sequences include facts that are not messages, so the
    // head, not the last message, is how far a short page saw.
    const readLimit = Math.min(query.limit, MAX_READ_MESSAGES);
    const seenThrough = query.mode === "after" && sequences.length >= readLimit && sequences.length > 0
      ? Math.max(...sequences)
      : tail;
    if (seenThrough > 0) this.setCursor(session, channelId, seenThrough);
    const replayedSequence = frames.length
      ? Math.max(...frames.map((frame) => frame.message.sequence ?? 0))
      : metric.effectiveAfterSequence;
    // Truncated when the window filled its limit and the channel head is still ahead.
    const truncated = frames.length >= query.limit && tail > replayedSequence;
    const observability: AgentChannelReplayObservability = {
      mode: metric.mode,
      limit: query.limit,
      entryCount: frames.length,
      afterSequence: metric.requestedAfterSequence,
      // The effective waterline used for the read; it may be clamped above a
      // stale client afterSequence.
      cursorSequence: metric.effectiveAfterSequence,
      effectiveAfterSequence: metric.effectiveAfterSequence,
      replayedSequence,
      tailSequence: tail,
      truncated,
    };
    return Object.assign(frames, { observability });
  }

  private setCursor(session: Readonly<AgentInstanceRuntimeSession>, channelId: string, value: number): void {
    let byChannel = this.cursors.get(session);
    if (!byChannel) {
      byChannel = new Map();
      this.cursors.set(session, byChannel);
    }
    byChannel.set(channelId, value);
  }

  private getCursor(session: Readonly<AgentInstanceRuntimeSession>, channelId: string): number | undefined {
    return this.cursors.get(session)?.get(channelId);
  }
}

function assertRunChannelBinding(session: Readonly<AgentInstanceRuntimeSession>, channelId: string): void {
  if (channelId !== session.principal.channelId || channelId !== session.run.channelId) {
    throw new Error("Channel history is outside the run binding");
  }
}

function historyQuery(message: Message<"get_channel_history">): Omit<AgentChannelHistoryRead, "channelId" | "agentId"> {
  const limit = historyLimit(message.limit ?? 50, false);
  const selected = [message.before !== undefined, message.beforeSequence !== undefined,
    message.afterSequence !== undefined].filter(Boolean).length;
  if (selected > 1) throw new Error("Channel history accepts only one cursor bound");
  if (message.afterSequence !== undefined) {
    return { limit, afterSequence: sequence(message.afterSequence, "afterSequence") };
  }
  if (message.beforeSequence !== undefined) {
    return { limit, beforeSequence: sequence(message.beforeSequence, "beforeSequence") };
  }
  if (message.before !== undefined) {
    if (!Number.isFinite(Date.parse(message.before))) throw new Error("before is invalid");
    return { limit, before: message.before };
  }
  return { limit };
}

function historyLimit(value: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > MAX_HISTORY_MESSAGES) {
    throw new Error(`Channel history limit must be between ${allowZero ? 0 : 1} and ${MAX_HISTORY_MESSAGES}`);
  }
  return value;
}

function sequence(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${field} is invalid`);
  return Number(value);
}
