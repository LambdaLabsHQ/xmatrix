import { plainRecord } from "@xmatrix/protocol";
import { PostgresGovernanceRepository, PostgresPageRepository } from "@xmatrix/db";
import { githubConnectionInstallationIds, githubRepositoryDelegated,
  type AppConnectorConnectionView } from "./app-connectors";
import { authUserByGitHubId } from "./auth-authority";
import { startPreReview } from "./github-pre-review";
import { appOrigin } from "./deployment-origins";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";
import { fireOwedAutomationTriggers } from "./automation-triggers";
import { findAppConnection } from "./apps";
import { changeMembership } from "./spaces";

/**
 * Pull requests that name page blocks (docs/design/pages-and-conversations.md
 * §5.6). Naming a block gates nothing: there is no claim to hold and no check
 * to pass (decided 2026-10-19, coordination is lock-free). When one opens or
 * gets new commits and its author is a member of the Space, the Space owner's
 * Agent pre-reviews it on the block it names; once merged, the sections it
 * names owe an update, and a participant author becomes a contributor.
 */
/** What may change the blocks a pull request names. */
const CREDITED_ACTIONS = new Set(["opened", "reopened", "edited", "synchronize", "ready_for_review"]);
/** A new change to review; an edited description is not one. */
const REVIEWED_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
/** Who may have the Space owner's Agent review their pull request: whoever may edit its pages. */
const REVIEWED_ROLES = new Set(["owner", "admin", "member"]);
const MAX_REFERENCES = 5;

export interface PageReference { spaceId: string; pageId: string; blockId: string }

/** Page block links in a pull request's text: `/app/<space>/pages?page=<page>#<block>` or `/p/<space>/<page>#<block>`. */
export function pageReferences(text: string): PageReference[] {
  const found = new Map<string, PageReference>();
  const id = "[A-Za-z0-9._:~-]+";
  const patterns = [
    new RegExp(`/app/(${id})/pages\\?(?:[^\\s)#]*&)?page=(${id})[^\\s)#]*(?:#([a-z0-9-]+))?`, "gu"),
    new RegExp(`/p/(${id})/(${id})(?:#([a-z0-9-]+))?`, "gu"),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const reference = { spaceId: decodeURIComponent(match[1]!), pageId: decodeURIComponent(match[2]!),
        blockId: match[3] ?? "" };
      found.set(`${reference.spaceId}\n${reference.pageId}\n${reference.blockId}`, reference);
    }
  }
  return [...found.values()].slice(0, MAX_REFERENCES);
}

function record(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

function pages(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-claim-check", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

function governance(env: Env): PostgresGovernanceRepository {
  return new PostgresGovernanceRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-governance", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

/**
 * The Space's configured GitHub connection, only when it covers the
 * installation the webhook came from and that installation's linking
 * administrator administers the repository now. GitHub signs which
 * installation, and so which repositories, a delivery speaks for; a pull
 * request from any other installation or repository, or a delivery naming
 * none, cannot touch the Space's claims or fire its owed Automations. Missing
 * evidence fails closed.
 */
async function connectedGitHub(env: Env, spaceId: string, installationId: string, owner: string, repo: string):
  Promise<AppConnectorConnectionView | null> {
  if (!installationId) return null;
  const space = await governance(env).read({ requestId: crypto.randomUUID(), spaceId }).catch(() => null);
  if (!space) return null;
  const connection = await findAppConnection(env, { spaceId, providerId: "github", actorUserId: space.ownerUserId });
  return connection?.status === "configured" &&
    await githubRepositoryDelegated(env, connection, installationId, owner, repo) ? connection : null;
}

export async function onPullRequestNamingBlocks(env: Env, payload: Record<string, unknown>): Promise<void> {
  const pull = record(payload.pull_request);
  const action = String(payload.action ?? "");
  const url = typeof pull.html_url === "string" ? pull.html_url : "";
  const references = pageReferences(typeof pull.body === "string" ? pull.body : "");
  if (!url || references.length === 0) return;
  const spaces = [...new Set(references.map((reference) => reference.spaceId))];
  const installationId = String(record(payload.installation).id ?? "").trim();
  const [owner, repo] = String(record(payload.repository).full_name ?? "").split("/");
  if (!installationId || !owner || !repo) return;

  if (action === "closed") {
    if (pull.merged !== true) return;
    const authorId = record(pull.user).id;
    const author = typeof authorId === "number" || typeof authorId === "string"
      ? await authUserByGitHubId(env, String(authorId)) : null;
    for (const spaceId of spaces) {
      if (!await connectedGitHub(env, spaceId, installationId, owner, repo)) continue;
      const login = record(pull.user).login;
      const { completed } = await pages(env).completePullRequestWork({ requestId: crypto.randomUUID(), spaceId,
        pullRequestUrl: url, ownerUserId: author, authorLabel: typeof login === "string" ? login : "",
        references: references.filter((reference) => reference.spaceId === spaceId) });
      await askForWriteback(env, { pullRequestUrl: url, completed });
      // The sections it named now owe an update; their `owed` Automations run.
      for (const pageId of new Set(completed.map((claim) => claim.pageId))) {
        await fireOwedAutomationTriggers(env, { spaceId, pageId,
          blockIds: completed.filter((claim) => claim.pageId === pageId).map((claim) => claim.blockId),
          event: { id: `owed:${url}:${pageId}`.slice(0, 200), kind: "owed", url,
            summary: `Pull request ${url} was merged, so the section it names owes an update` } })
          .catch((error: unknown) => console.error("owed Automation triggers failed", error));
      }
      if (author) await promoteContributor(env, { spaceId, userId: author, installationId, pullRequestUrl: url });
    }
    return;
  }
  if (!CREDITED_ACTIONS.has(action)) return;
  const authorId = record(pull.user).id;
  if (typeof authorId !== "number" && typeof authorId !== "string") return;
  const userId = await authUserByGitHubId(env, String(authorId));
  if (!userId) return;
  const login = typeof record(pull.user).login === "string" ? String(record(pull.user).login) : "its author";
  const number = Number(pull.number);
  const reviewed = REVIEWED_ACTIONS.has(action) && pull.draft !== true && Number.isInteger(number);

  for (const spaceId of spaces) {
    // Only a pull request from the Space's own installation counts in it.
    const connection = await connectedGitHub(env, spaceId, installationId, owner, repo);
    if (!connection) continue;
    // A pre-review spends the Space owner's Agent, so it is for the Space's own members, not anyone who opens a pull request.
    const role = await governance(env).roleOf({ requestId: crypto.randomUUID(), spaceId, userId }).catch(() => null);
    let review = reviewed && role !== null && REVIEWED_ROLES.has(role);
    for (const reference of references.filter((item) => item.spaceId === spaceId)) {
      // A claim the author still holds there is credited with the pull request, so merging it settles that claim.
      const named = await pages(env).pullRequestClaim({ requestId: crypto.randomUUID(), spaceId,
        pageId: reference.pageId, blockId: reference.blockId, ownerUserId: userId, pullRequestUrl: url });
      if (!review || !named?.pageTitle) continue;
      review = false;
      const blockLink = `${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/pages?page=${
        encodeURIComponent(reference.pageId)}${reference.blockId ? `#${reference.blockId}` : ""}`;
      await startPreReview(env, { spaceId, spaceOwnerUserId: named.spaceOwnerUserId, connection,
        pull: { url, owner, repo, number }, pageId: reference.pageId, blockId: reference.blockId,
        restricted: named.restricted, author: named.claim?.holder.label ?? login, blockLink });
    }
  }
}

/**
 * The pull request did the work on a section, so the section owes an
 * update (pages-live-document.md §5). The conversation that did the work hears
 * it from GitHub at once: its Run, if still live, writes the section back or
 * says nothing there changed. A section nobody answers for stays marked owed.
 */
async function askForWriteback(env: Env, input: { pullRequestUrl: string;
  completed: Array<{ pageId: string; pageTitle: string | null; blockId: string; conversationId: string | null;
    ownerUserId: string }> }): Promise<void> {
  const byConversation = new Map<string, typeof input.completed>();
  for (const claim of input.completed) {
    if (!claim.conversationId) continue;
    byConversation.set(claim.conversationId, [...(byConversation.get(claim.conversationId) ?? []), claim]);
  }
  for (const [conversationId, claims] of byConversation) {
    const sections = claims.map((claim) => `- ${claim.pageTitle ?? "a page"}${claim.blockId ? ` › #${claim.blockId}` : ""}` +
      ` — \`xmatrix page read ${claim.pageId}${claim.blockId ? ` --block ${claim.blockId}` : ""}\``);
    const body = [`${input.pullRequestUrl} is merged. It did the work on:`, ...sections, "",
      "Rewrite these sections to what is true now with `xmatrix page edit` (the pull request keeps the evidence), or run `xmatrix page done -m \"<why>\"` " +
      "if the merge changed nothing there."].join("\n");
    await dispatchProductMessageAppend(env, conversationId, {
      commandId: `product:page-writeback:${conversationId}:${input.pullRequestUrl}`.slice(0, 200),
      // One request per pull request and conversation, however often GitHub redelivers.
      messageId: `app:github:writeback:${conversationId}:${input.pullRequestUrl}`.slice(0, 200),
      channelId: conversationId, body, appAuthorId: "github",
      principal: { kind: "user", id: claims[0]!.ownerUserId },
    }).catch((error: unknown) => console.warn("page write-back request not delivered", error));
  }
}

/**
 * A merged pull request that names one of a project's blocks, from a
 * repository that project's own GitHub installation covers, makes a
 * participant author a contributor (open-project-governance.md §2).
 */
async function promoteContributor(env: Env, input: { spaceId: string; userId: string; installationId: string;
  pullRequestUrl: string }): Promise<void> {
  const spaces = governance(env);
  const role = await spaces.roleOf({ requestId: crypto.randomUUID(), spaceId: input.spaceId, userId: input.userId });
  if (role !== "participant") return;
  const { ownerUserId } = await spaces.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId });
  const connection = await findAppConnection(env, { spaceId: input.spaceId, providerId: "github", actorUserId: ownerUserId });
  if (!connection || !githubConnectionInstallationIds(connection).includes(input.installationId)) return;
  await changeMembership(env, {
    commandId: `space-contributor:${input.spaceId}:${input.userId}`.slice(0, 200),
    actorUserId: ownerUserId, at: new Date().toISOString(), kind: "space_member_put",
    spaceId: input.spaceId, userId: input.userId, role: "member",
  });
}
