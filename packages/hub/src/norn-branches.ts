import { PostgresPageRepository } from "@xmatrix/db";
import { wakeAgentLaunchCoordinator } from "./agent-launch-coordinator-wake";
import { deterministicConversationIdSync } from "./deterministic-id";
import { effectivelyRestricted } from "./page-restriction";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { openConversation } from "./system-conversation";
import type { Env } from "./types";

/** A branch of a Page program (`forEach(~per)` / `Std.each` / `spawn(~key)`), routed to its own conversation. */
export interface NornBranchChannel {
  key: string;
  label: string;
  scope: string;
  channelId: string;
}

/** Deterministic conversation ID for one branch of a Page's Norn program. */
export function nornBranchConversationId(pageId: string, programName: string, branchKey: string): string {
  return deterministicConversationIdSync("norn-page-branch", pageId, programName, branchKey);
}

/**
 * Ensures each branch conversation exists (idempotently), links it to the
 * program's Page (and to the branch's target Page when `label` is a readable
 * Page ID in the Space), and wakes its coordinator so queued deliveries or
 * cancellations run immediately.
 */
export async function ensureAndWakeNornBranches(
  env: Env,
  input: {
    spaceId: string;
    pageId?: string | null;
    pageName?: string | null;
    programChannelId?: string;
    authorityUserId: string;
    branches?: readonly NornBranchChannel[];
    wakeChannels?: readonly string[];
  },
): Promise<void> {
  const wake = new Set<string>(input.wakeChannels ?? []);
  const branches = input.branches ?? [];
  if (branches.length && input.pageId && input.pageName) {
    const db = createPostgresAuthorityDatabase(env, {
      applicationName: "xmatrix-norn-branches",
      statementTimeoutMs: 5_000, transactionTimeoutMs: 15_000, lockTimeoutMs: 2_000,
    });
    const principal = { kind: "user" as const, id: input.authorityUserId };
    const pages = new PostgresPageRepository(db);
    const [hostPage, restricted] = await Promise.all([
      pages.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: input.pageId, principal })
        .then((res) => res.page, () => null),
      effectivelyRestricted(env, input.spaceId, input.pageId, input.authorityUserId).catch(() => false),
    ]);
    const pageTitle = hostPage?.title ?? input.pageName;
    const seen = new Set<string>();
    for (const branch of branches) {
      if (seen.has(branch.channelId)) continue;
      seen.add(branch.channelId);
      // When a branch partition key is a Space Page ID, use that Page's title and link it too.
      const targetPage = branch.label && branch.label !== input.pageId
        ? await pages.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId, pageId: branch.label, principal })
          .then((res) => res.page, () => null)
        : null;
      const displayLabel = targetPage?.title || branch.label || branch.key;
      await openConversation(env, {
        spaceId: input.spaceId,
        channelId: branch.channelId,
        name: `${pageTitle} · ${input.pageName} · ${displayLabel}`.slice(0, 120),
        mode: restricted ? "closed" : "open",
        metadata: {
          createdBy: "norn-page-branch",
          nornPageId: input.pageId,
          nornProgramName: input.pageName,
          nornBranchKey: branch.key,
          nornBranchLabel: displayLabel,
          ...(input.programChannelId ? { nornProgramChannelId: input.programChannelId } : {}),
        },
        userId: input.authorityUserId,
      });
      await pages.link({
        requestId: crypto.randomUUID(), spaceId: input.spaceId, principal,
        conversationId: branch.channelId, pageId: input.pageId, blockId: "", source: "reference",
      }).catch(() => undefined);
      if (targetPage) {
        await pages.link({
          requestId: crypto.randomUUID(), spaceId: input.spaceId, principal,
          conversationId: branch.channelId, pageId: targetPage.pageId, blockId: "", source: "reference",
        }).catch(() => undefined);
      }
      wake.add(branch.channelId);
    }
  }
  for (const channelId of wake) {
    await wakeAgentLaunchCoordinator(env, channelId, ["norn"]);
  }
}
