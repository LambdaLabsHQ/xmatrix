import { readDueFirstMessageSummons, type AuthorityDatabase, type PendingFirstMessageSummon } from "@xmatrix/db";

import { startNewConversation, summonFirstMessageHarness } from "./product-message-post-commit";
import { readFirstMessageBody } from "./registration-launch-dispatch";
import type { Env } from "./types";

interface FirstMessageSummonPorts {
  summon: typeof summonFirstMessageHarness;
  start: typeof startNewConversation;
  readBody: typeof readFirstMessageBody;
}

const PORTS: FirstMessageSummonPorts = { summon: summonFirstMessageHarness, start: startNewConversation,
  readBody: readFirstMessageBody };

/**
 * Finish the first messages of this Channel whose summon no request finished.
 * The request that sent one runs its decision and summon in a background
 * budget that can end first, and then nothing else would. A decided harness
 * is summoned; an undecided message is decided again (the decision is written
 * once, so this never starts a second Agent) and then summoned. Every step is
 * idempotent by the first message's id; a summon that dispatched is marked,
 * and one that fails stays due for the next pass.
 */
export async function reconcileFirstMessageSummons(env: Env, database: AuthorityDatabase, channelId: string,
  ports: FirstMessageSummonPorts = PORTS): Promise<void> {
  const due = await database.transaction({ requestId: `first-message-summon:${channelId}`.slice(0, 200),
    operation: "first-message-summon.due" }, tx => readDueFirstMessageSummons(tx, channelId));
  for (const pending of due) {
    try {
      await finish(env, channelId, pending, ports);
    } catch (error) {
      console.warn("First message summon could not be finished", { channelId, messageId: pending.messageId,
        error: error instanceof Error ? error.message : String(error) });
    }
  }
}

async function finish(env: Env, channelId: string, pending: PendingFirstMessageSummon, ports: FirstMessageSummonPorts) {
  if (pending.harness) {
    await ports.summon({ env, channelId, messageId: pending.messageId, actorUserId: pending.authorUserId,
      harness: pending.harness });
    return;
  }
  const source = await ports.readBody(env, { channelId, messageId: pending.messageId, authorUserId: pending.authorUserId });
  if (!source) return;
  await ports.start({ env, channelId, messageId: pending.messageId, body: source.body,
    actorUserId: pending.authorUserId, senderKind: source.authorKind });
}
