import { tellPageClaimOverlap } from "./page-claim-overlap";
import { PostgresPageRepository } from "@xmatrix/db";
import { automationReferences, parseAutoLaunchMentions, plainRecord } from "@xmatrix/protocol";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { deterministicConversationId } from "./deterministic-id";
import { openConversation } from "./system-conversation";
import { getChannel } from "./spaces";
import type { Env } from "./types";

function pages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-automations", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

/** A page restricted itself or through an ancestor keeps its Automations' conversations closed. */
export async function effectivelyRestricted(env: Env, spaceId: string, pageId: string, userId: string): Promise<boolean> {
  const { pages: tree } = await pages(env).tree({ requestId: crypto.randomUUID(),
    spaceId, principal: { kind: "user", id: userId } });
  const byId = new Map(tree.map((page) => [page.pageId, page]));
  for (let page = byId.get(pageId), depth = 0; page && depth < 64; page = page.parentPageId
    ? byId.get(page.parentPageId) : undefined, depth++) {
    if (page.accessMode === "restricted") return true;
  }
  return false;
}

/** `name · 10-09 18:46 UTC`: tells one occurrence's conversation from the next. */
export function occurrenceConversationName(name: string, scheduledFor: string): string {
  const at = new Date(scheduledFor).toISOString();
  const stamp = `${at.slice(5, 10)} ${at.slice(11, 16)} UTC`;
  return `${name.trim().slice(0, 80 - stamp.length - 3)} · ${stamp}`;
}

/**
 * Opens the conversation one Automation occurrence runs in
 * (docs/design/pages-live-document.md §6.1), as the Automation's authority
 * root, and links it to the section that references the Automation. Every
 * occurrence starts clean: what carries over lives on the page, not in an
 * earlier occurrence's conversation. Idempotent per occurrence, so a retried
 * dispatch reopens the same conversation.
 *
 * An occurrence that starts an Agent also claims the section for its
 * conversation, as the Automation, beside anyone else on it (a claim locks
 * nothing; each is told of the other). The Run takes that claim over when it
 * claims the section, and writing the section settles it; a Run that never
 * starts, or ends without writing, leaves the claim to lapse, and the section
 * then owes an update like any other abandoned work (§5.2).
 */
export async function openOccurrenceConversation(env: Env, input: {
  spaceId: string; pageId: string; automationId: string; occurrenceId: string; name: string;
  scheduledFor: string; userId: string; body: string; privateEvents: boolean;
}): Promise<string> {
  const principal = { kind: "user" as const, id: input.userId };
  const channelId = await deterministicConversationId("automation-occurrence", input.occurrenceId);
  const repository = pages(env);
  const [{ page }, restricted] = await Promise.all([
    repository.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId, principal }),
    effectivelyRestricted(env, input.spaceId, input.pageId, input.userId),
  ]);
  await openConversation(env, { spaceId: input.spaceId, channelId, userId: input.userId,
    name: occurrenceConversationName(input.name, input.scheduledFor), mode: restricted || input.privateEvents ? "closed" : "open",
    metadata: { createdBy: "page-automation", fromPageId: input.pageId, automationId: input.automationId,
      automationOccurrenceId: input.occurrenceId } });
  if (input.privateEvents) {
    // A retry can find a conversation the old Hub opened before marking the
    // occurrence prepared. Refuse it instead of appending private data there.
    const result = await getChannel(env, { spaceId: input.spaceId, channelId, principal });
    const channel = plainRecord(result.channel);
    if (channel?.spaceId !== input.spaceId || channel.mode !== "closed") {
      throw new Error("automation_private_event_requires_closed_conversation");
    }
  }
  const blockId = automationReferences(page.body).get(input.automationId);
  await repository.link({ requestId: crypto.randomUUID(), spaceId: input.spaceId, principal,
    conversationId: channelId, pageId: input.pageId, ...(blockId ? { blockId } : {}), source: "reference" });
  if (blockId && parseAutoLaunchMentions(input.body).length > 0) {
    // The occurrence is on its section. Nothing is locked: whoever else is on it is told, and so is it.
    const held = await repository.claim({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId,
      principal, blockId, conversationId: channelId, holderLabel: input.name.trim().slice(0, 200) || "Automation" })
      .catch((error: unknown) => {
        // A person's own claim there is theirs; the occurrence does not take it over.
        if ((error as { code?: unknown }).code !== "page_block_claimed") throw error;
        return null;
      });
    if (held) await tellPageClaimOverlap(env, { spaceId: input.spaceId, pageId: input.pageId, ...held });
  }
  return channelId;
}
