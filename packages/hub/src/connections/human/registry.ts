import { utf8ByteLength } from "@xmatrix/protocol";
import { parseHumanChannelCatalogChangedMessage, parseHumanWorkspaceResourceChangedMessage, parseHumanTraceAccessServerMessage, type HumanTraceAccessServerMessage, type HumanServerMessage } from "@xmatrix/protocol/connections/human";

export const MAX_HUMAN_PROJECTION_RECIPIENT_USERS = 100_000;
export const MAX_HUMAN_PROJECTION_LIVE_DELIVERIES = 10_000;

export type HumanProjectionPublishResult =
  | {
      accepted: true;
      recipientUsers: number;
      matchedSessions: number;
      delivered: number;
      failed: number;
    }
  | {
      accepted: false;
      reason: "invalid_message" | "invalid_recipient_set" | "fanout_limit";
      recipientUsers: number;
      matchedSessions: number;
      delivered: 0;
      failed: 0;
    };

export type HumanProjectionSender = (
  socket: WebSocket,
  message: HumanServerMessage,
) => boolean;

export type HumanTraceAccessPublishInput = {
  message: HumanTraceAccessServerMessage;
};

export interface HumanProjectionSession {
  userId: string;
}

/**
 * Send one already-validated message to exactly the named recipients.
 *
 * Recipients are always an explicit set, never "everyone connected": the
 * bounded fanout is what keeps one committed event from becoming a broadcast.
 */
function publishToRecipientSessions(
  message: HumanServerMessage,
  recipients: Set<string>,
  sessions: Iterable<readonly [WebSocket, HumanProjectionSession]>,
  send: HumanProjectionSender,
): HumanProjectionPublishResult {
  if (!validRecipientSet(recipients)) {
    return rejected("invalid_recipient_set", safeSetSize(recipients), 0);
  }
  const targets: Array<readonly [WebSocket, HumanProjectionSession]> = [];
  for (const entry of sessions) {
    if (!recipients.has(entry[1].userId)) continue;
    targets.push(entry);
    if (targets.length > MAX_HUMAN_PROJECTION_LIVE_DELIVERIES) {
      return rejected("fanout_limit", recipients.size, targets.length);
    }
  }
  return deliverToSessions(message, recipients.size, targets, send);
}

/** Delivery accounting is shared after each caller has bounded its target selection. */
function deliverToSessions(
  message: HumanServerMessage,
  recipientUsers: number,
  targets: Array<readonly [WebSocket, HumanProjectionSession]>,
  send: HumanProjectionSender,
): HumanProjectionPublishResult {
  let delivered = 0;
  let failed = 0;
  for (const [socket] of targets) {
    try {
      if (send(socket, message)) delivered += 1;
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  return {
    accepted: true,
    recipientUsers,
    matchedSessions: targets.length,
    delivered,
    failed,
  };
}

/** Exact owner/viewer fanout for Authority-authored trace grant state changes. */
export function publishHumanTraceAccessToSessions(
  input: HumanTraceAccessPublishInput,
  sessions: Iterable<readonly [WebSocket, HumanProjectionSession]>,
  send: HumanProjectionSender,
): HumanProjectionPublishResult {
  const message = parseHumanTraceAccessServerMessage(input.message);
  if (!message) return rejected("invalid_message", 0, 0);
  return publishToRecipientSessions(
    message,
    new Set([message.grant.ownerUserId, message.grant.viewerUserId]),
    sessions,
    send,
  );
}

/** Metadata-only catalog wake-up for exactly the named Space members. */
export const publishHumanChannelCatalogChangedToSessions = recipientMessagePublisher(parseHumanChannelCatalogChangedMessage);

/** Metadata-only workspace-list wake-up for exactly the named principals. */
export const publishHumanWorkspaceResourceChangedToSessions = recipientMessagePublisher(parseHumanWorkspaceResourceChangedMessage);

function recipientMessagePublisher(parse: (value: unknown) => HumanServerMessage | null | undefined) {
  return (input: { message: unknown; recipientUserIds: readonly string[] },
    sessions: Iterable<readonly [WebSocket, HumanProjectionSession]>, send: HumanProjectionSender): HumanProjectionPublishResult => {
    const message = parse(input.message);
    if (!message) return rejected("invalid_message", 0, 0);
    return publishToRecipientSessions(message, new Set(input.recipientUserIds), sessions, send);
  };
}

function validRecipientSet(value: ReadonlySet<string>): boolean {
  if (!(value instanceof Set) || value.size > MAX_HUMAN_PROJECTION_RECIPIENT_USERS) {
    return false;
  }
  for (const userId of value) {
    if (
      typeof userId !== "string" || userId.length === 0 ||
      utf8ByteLength(userId) > 200
    ) return false;
  }
  return true;
}

function safeSetSize(value: ReadonlySet<string>): number {
  return value && Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : 0;
}

function rejected(
  reason: "invalid_message" | "invalid_recipient_set" | "fanout_limit",
  recipientUsers: number,
  matchedSessions: number,
): HumanProjectionPublishResult {
  return { accepted: false, reason, recipientUsers, matchedSessions, delivered: 0, failed: 0 };
}
