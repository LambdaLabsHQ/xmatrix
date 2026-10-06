/**
 * Deciding which outbound row a committed message retires.
 *
 * A human HTTP append persists the caller's `clientMessageId` *as* the durable
 * `messageId` (`index-routes-channel-agent.ts`: `body.clientMessageId?.trim() ||
 * crypto.randomUUID()`), so a committed message carries exact identity even
 * though no field is spelled `clientMessageId`. Exact identity is therefore
 * always tried first; the content heuristic is a legacy fallback only. It lives
 * here so it is testable — a wrong answer retires somebody else's message.
 */

export interface ClaimableOutgoingMessage {
  clientMessageId: string;
  channelId: string;
  body: string;
  attachments: readonly unknown[];
  sentAt: string;
  status: "pending" | "unconfirmed" | "failed";
}

export interface ClaimableCommittedMessage {
  messageId: string;
  channelId: string;
  body?: string;
  sentAt: string;
  attachments?: readonly unknown[];
}

/** Rows a committed message is allowed to retire. */
export function claimableOutgoingMessages(
  entry: ClaimableCommittedMessage,
  pending: readonly ClaimableOutgoingMessage[],
): ClaimableOutgoingMessage[] {
  // Only `pending`. An `unconfirmed` row has exact identity and is resolved by
  // `claimByDurableMessageId`; exposing it to a content guess could retire it
  // on the strength of a similar-looking message instead of its own.
  return pending.filter(
    (item) => item.channelId === entry.channelId && item.status === "pending",
  );
}

/**
 * Exact identity: the committed `messageId` is the `clientMessageId` that was
 * sent. This resolves a row regardless of body, timing, or order, and is the
 * only mechanism an `unconfirmed` row relies on — no part of it is a guess.
 */
export function claimByDurableMessageId(
  entry: ClaimableCommittedMessage,
  pending: readonly ClaimableOutgoingMessage[],
): string | undefined {
  return pending.find(
    (item) => item.channelId === entry.channelId &&
      item.status !== "failed" &&
      item.clientMessageId === entry.messageId,
  )?.clientMessageId;
}

/** How close a lone candidate may be in time before it is claimed blind. */
export const LONE_CANDIDATE_MAX_SKEW_MS = 120_000;

export function matchClaimableOutgoing(
  entry: ClaimableCommittedMessage,
  pending: readonly ClaimableOutgoingMessage[],
): string | undefined {
  // Exact identity must be tried first. Running the content heuristic first
  // would let a same-bodied `pending` row steal a canonical echo that exactly
  // identifies an `unconfirmed` one.
  const exact = claimByDurableMessageId(entry, pending);
  if (exact) return exact;

  // Legacy fallback, deliberately limited to `pending`: an `unconfirmed` row
  // converges on its durable messageId above, and letting a guess retire it
  // would dress an unknown result up as a certain one.
  const channelPending = claimableOutgoingMessages(entry, pending);
  if (channelPending.length === 0) return undefined;

  const body = entry.body ?? "";
  const bodyMatches = channelPending.filter((item) => item.body === body);
  if (bodyMatches.length === 1) return bodyMatches[0].clientMessageId;
  if (bodyMatches.length > 1) {
    return bodyMatches
      .slice()
      .sort(
        (left, right) =>
          Math.abs(Date.parse(entry.sentAt) - Date.parse(left.sentAt)) -
          Math.abs(Date.parse(entry.sentAt) - Date.parse(right.sentAt)),
      )[0]?.clientMessageId;
  }

  if (!body && entry.attachments?.length) {
    const attachmentMatches = channelPending.filter(
      (item) => !item.body && item.attachments.length === entry.attachments!.length,
    );
    if (attachmentMatches.length === 1) return attachmentMatches[0].clientMessageId;
  }

  if (channelPending.length === 1) {
    const deltaMs = Math.abs(Date.parse(entry.sentAt) - Date.parse(channelPending[0].sentAt));
    if (Number.isFinite(deltaMs) && deltaMs < LONE_CANDIDATE_MAX_SKEW_MS) {
      return channelPending[0].clientMessageId;
    }
  }
  return undefined;
}
