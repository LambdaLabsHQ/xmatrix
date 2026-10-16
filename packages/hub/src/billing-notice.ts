import { sha256Hex } from "@xmatrix/protocol";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";

/**
 * Tells a Channel what the Space's billing policy asked it to be told after a
 * write, such as Agent credits crossing a threshold (docs/design/agent-credits.md).
 * The notice is keyed by the policy's key, so the same threshold is announced
 * once however many writes cross it at the same time. Posting follows the
 * commit it describes: its failure is logged, never turned into a failed write.
 */
export async function postBillingNotice(env: Env, channelId: string, notice: unknown): Promise<void> {
  if (!notice || typeof notice !== "object") return;
  const { key, body, userId } = notice as Record<string, unknown>;
  if (typeof key !== "string" || typeof body !== "string" || typeof userId !== "string") return;
  const digest = await sha256Hex(`${channelId}\0${key}`);
  try {
    const response = await dispatchProductMessageAppend(env, channelId, {
      commandId: `billing-notice:${digest}`.slice(0, 200),
      messageId: `system:billing-notice:${digest}`.slice(0, 200),
      channelId,
      body,
      messageKind: "xmatrix.system.credits",
      principal: { kind: "user", id: userId },
      xmatrixAuthor: true,
      residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
        source: "billing_notice", billingNoticeKey: key } },
    });
    if (!response.ok) throw new Error(`status ${response.status}`);
  } catch (error) {
    console.error("Billing notice failed", { channelId, key, error: error instanceof Error ? error.message : String(error) });
  }
}
