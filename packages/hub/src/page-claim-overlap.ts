import type { PageClaim } from "@xmatrix/protocol";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";

/**
 * Two conversations on one section (docs/design/pages-live-document.md §3):
 * a claim locks nothing, so whoever takes a section someone else is already on
 * is told who, and each of those is told about the newcomer, in their own
 * conversations. Each then decides: talk there, pick other work, or carry on
 * side by side. It is nobody's turn: the notice is context for live Runs.
 * Stable per pair of claims, so a renewed claim never repeats it.
 */
export async function tellPageClaimOverlap(env: Env, input: {
  spaceId: string; pageId: string; claim: PageClaim; others: PageClaim[];
}): Promise<void> {
  const { claim, others } = input;
  const where = `page:${input.pageId}${claim.blockId ? `#${claim.blockId}` : ""}`;
  const at = (other: PageClaim) => other.conversationId ? ` in channel:${other.conversationId}` : "";
  const tell = (to: PageClaim, about: PageClaim[], body: string) => {
    if (!to.conversationId || about.length === 0) return Promise.resolve();
    const key = `${to.claimId}:${about.map((other) => other.claimId).sort().join(",")}`;
    const messageId = `system:page-claim-overlap:${key}`.slice(0, 200);
    return dispatchProductMessageAppend(env, to.conversationId, {
      commandId: `product:page-claim-overlap:${key}`.slice(0, 200),
      messageId, channelId: to.conversationId, body,
      messageKind: "xmatrix.system.page-claim-overlap",
      principal: { kind: "user", id: to.ownerUserId },
      xmatrixAuthor: true,
      residual: { appMetadata: { xmatrixProvenance: "system_fact", xmatrixSystemNotice: true,
        xmatrixPageClaimOverlap: { version: 1, spaceId: input.spaceId, pageId: input.pageId, blockId: claim.blockId,
          claimIds: about.map((other) => other.claimId) } } },
    }).then((response) => {
      if (!response.ok) console.warn("page claim overlap notice not delivered", response.status);
    }, (error: unknown) => console.warn("page claim overlap notice not delivered", error));
  };
  const elsewhere = others.filter((other) => other.conversationId !== claim.conversationId);
  await tell(claim, elsewhere, [`Others are already on ${where}:`,
    ...elsewhere.map((other) => `- ${other.holder.label}${at(other)}`), "",
    "Nothing is locked. Talk to them there, pick other work, or carry on side by side."].join("\n"));
  await Promise.all(elsewhere.map((other) => tell(other, [claim],
    `${claim.holder.label} also started on ${where}${at(claim)}. Nothing is locked; talk there if your work overlaps.`)));
}
