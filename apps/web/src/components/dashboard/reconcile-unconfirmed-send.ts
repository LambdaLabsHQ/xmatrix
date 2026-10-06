/**
 * Whether a detached reconcile probe may still write what it read.
 *
 * The probe runs after the send returned, so between capture and merge the
 * viewer can log out or the token can rotate. Either abandons the read — a
 * probe must never become a way for a stale session to write history back.
 */
export function reconcileAuthorityIsCurrent(
  capturedToken: string | null,
  currentToken: string | null,
): boolean {
  // A probe without a token could never have been authorized in the first place.
  if (!capturedToken) return false;
  // Session identity must be unchanged: a rotation or re-login is a different
  // authorization context even for the same person.
  return currentToken === capturedToken;
}

/**
 * The reconcile loop itself, with its dependencies injected.
 *
 * This exists as its own unit because the last real defect here was not a wrong
 * decision — the matcher and the fence were both right — but glue that decided
 * correctly and then never removed the row. A test that re-implements the loop
 * cannot catch that, so production and tests drive exactly this function.
 */
export interface CommittedProbeMessage {
  messageId: string;
}

export interface ReconcileProbeDeps<TMessage extends CommittedProbeMessage> {
  clientMessageId: string;
  delaysMs: readonly number[];
  wait: (ms: number) => Promise<void>;
  /** Re-checked before each probe and again before committing its result. */
  authorityIsCurrent: () => boolean;
  /** False once the live echo or another read already retired the row. */
  isStillOutstanding: (clientMessageId: string) => boolean;
  /** Must reject when its deadline elapses rather than hang. */
  fetchPage: () => Promise<{ messages: readonly TMessage[] }>;
  /** Claim, merge and remove — the single production path that retires a row. */
  commitCommitted: (committed: TMessage) => void;
}

export type ReconcileProbeOutcome =
  | "reconciled"
  | "already-resolved"
  | "authority-lost"
  | "not-found";

export function reconnectableUnconfirmedSends<
  TChannel extends { id: string },
  TOutgoing extends { channelId: string; clientMessageId: string; status: string },
>(
  outgoing: readonly TOutgoing[],
  channels: readonly TChannel[],
): Array<{ outgoing: TOutgoing; channel: TChannel }> {
  const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
  return outgoing.flatMap((item) => {
    if (item.status !== "unconfirmed") return [];
    const channel = channelsById.get(item.channelId);
    return channel ? [{ outgoing: item, channel }] : [];
  });
}

export interface UnconfirmedSendReconcilerDeps<TMessage extends CommittedProbeMessage> {
  delaysMs: readonly number[];
  probeDeadlineMs: number;
  currentToken: () => string | null;
  isStillOutstanding: (clientMessageId: string) => boolean;
  fetchPage: (
    token: string,
    channelId: string,
    signal: AbortSignal,
  ) => Promise<{ messages: readonly TMessage[] }>;
  commitCommitted: (committed: TMessage, channelId: string) => void;
  wait?: (ms: number) => Promise<void>;
}

/**
 * Bind the shell's session and history dependencies once, keeping the
 * detached reconcile responsibility out of the already-large action hook.
 */
export function createUnconfirmedSendReconciler<TMessage extends CommittedProbeMessage>(
  deps: UnconfirmedSendReconcilerDeps<TMessage>,
) {
  return async (channelId: string, clientMessageId: string) => {
    const capturedToken = deps.currentToken();
    const readStillCurrent = () => reconcileAuthorityIsCurrent(capturedToken, deps.currentToken());

    return runUnconfirmedSendReconcile({
      clientMessageId,
      delaysMs: deps.delaysMs,
      wait: deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      authorityIsCurrent: readStillCurrent,
      isStillOutstanding: deps.isStillOutstanding,
      fetchPage: async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), deps.probeDeadlineMs);
        try {
          return await deps.fetchPage(capturedToken!, channelId, controller.signal);
        } finally {
          clearTimeout(timer);
        }
      },
      commitCommitted: (committed) => deps.commitCommitted(committed, channelId),
    });
  };
}

export async function runUnconfirmedSendReconcile<TMessage extends CommittedProbeMessage>(
  deps: ReconcileProbeDeps<TMessage>,
): Promise<ReconcileProbeOutcome> {
  for (const delayMs of deps.delaysMs) {
    await deps.wait(delayMs);
    if (!deps.authorityIsCurrent()) return "authority-lost";
    if (!deps.isStillOutstanding(deps.clientMessageId)) return "already-resolved";
    let page: { messages: readonly TMessage[] };
    try {
      page = await deps.fetchPage();
    } catch {
      // A failed or timed-out probe proves nothing; try again if attempts remain.
      continue;
    }
    // Re-checked after the await: authority can lapse while the page is in
    // flight, and merging then would let a stale read write history back.
    if (!deps.authorityIsCurrent()) return "authority-lost";
    const committed = page.messages.find(
      (entry) => entry.messageId === deps.clientMessageId,
    );
    if (committed) {
      deps.commitCommitted(committed);
      return "reconciled";
    }
  }
  return "not-found";
}

/**
 * Retire an outbound row against a committed message.
 *
 * Claim, then merge, then remove — all three, in that order. This is the exact
 * step that regressed once by merging without removing, which left the
 * canonical message beside a row that stayed "unconfirmed" forever. It takes
 * injected dependencies so production and its tests run this code, not a
 * reproduction of it.
 */
export interface CommitReconciledDeps<TMessage, TOutgoing> {
  committed: TMessage;
  outgoing: readonly TOutgoing[];
  claim: (committed: TMessage, outgoing: readonly TOutgoing[]) => string | undefined;
  /** Caches the canonical message. Caching alone retires nothing. */
  merge: (committed: TMessage) => void;
  remove: (clientMessageId: string) => void;
}

export function commitReconciledOutgoing<TMessage, TOutgoing>(
  deps: CommitReconciledDeps<TMessage, TOutgoing>,
): boolean {
  const claimed = deps.claim(deps.committed, deps.outgoing);
  // Merged regardless: a canonical message belongs in history even when no
  // outbound row corresponds to it.
  deps.merge(deps.committed);
  if (!claimed) return false;
  deps.remove(claimed);
  return true;
}
