import { PostgresPageRepository } from "@xmatrix/db";
import { automationReferences, parseAutoLaunchMentions } from "@xmatrix/protocol";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { deterministicConversationId, openConversation } from "./system-conversation";
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
 * conversation, as the Automation. The Run takes that claim over when it
 * claims the section, and writing the section settles it; a Run that never
 * starts, or ends without writing, leaves the claim to lapse, and the section
 * then owes an update like any other abandoned work (§5.2).
 */
export async function openOccurrenceConversation(env: Env, input: {
  spaceId: string; pageId: string; automationId: string; occurrenceId: string; name: string;
  scheduledFor: string; userId: string; body: string;
}): Promise<string> {
  const principal = { kind: "user" as const, id: input.userId };
  const channelId = await deterministicConversationId("automation-occurrence", input.occurrenceId);
  const repository = pages(env);
  const [{ page }, restricted] = await Promise.all([
    repository.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId, principal }),
    effectivelyRestricted(env, input.spaceId, input.pageId, input.userId),
  ]);
  await openConversation(env, { spaceId: input.spaceId, channelId, userId: input.userId,
    name: occurrenceConversationName(input.name, input.scheduledFor), mode: restricted ? "closed" : "open",
    metadata: { createdBy: "page-automation", fromPageId: input.pageId, automationId: input.automationId,
      automationOccurrenceId: input.occurrenceId } });
  const blockId = automationReferences(page.body).get(input.automationId);
  await repository.link({ requestId: crypto.randomUUID(), spaceId: input.spaceId, principal,
    conversationId: channelId, pageId: input.pageId, ...(blockId ? { blockId } : {}), source: "reference" });
  if (blockId && parseAutoLaunchMentions(input.body).length > 0) {
    // Someone already on the section keeps it: the instruction has the Run stand down for them.
    await repository.claim({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId,
      principal, blockId, conversationId: channelId, holderLabel: input.name.trim().slice(0, 200) || "Automation" })
      .catch((error: unknown) => {
        if ((error as { code?: unknown }).code !== "page_block_claimed") throw error;
      });
  }
  return channelId;
}
