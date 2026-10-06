import { plainRecord } from "@xmatrix/protocol";
import { PostgresGovernanceRepository, PostgresPageRepository } from "@xmatrix/db";
import { githubConnectionInstallationIds, publishGitHubCheckRun } from "./app-connectors";
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
 * The `xmatrix/claim` check (docs/design/pages-and-conversations.md §5.6): a
 * pull request names the page block it works on with the block's link, and
 * passes when its author, through their linked GitHub account, holds a claim
 * on that block. A merged pull request completes the claim. A pull request
 * that names no block gets no check, so a required check keeps it out.
 */
export const CLAIM_CHECK_NAME = "xmatrix/claim";
const CHECKED_ACTIONS = new Set(["opened", "reopened", "edited", "synchronize", "ready_for_review"]);
/** A new change to review; an edited description is not one. */
const REVIEWED_ACTIONS = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);
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

export async function checkPullRequestClaims(env: Env, payload: Record<string, unknown>): Promise<void> {
  const pull = record(payload.pull_request);
  const action = String(payload.action ?? "");
  const url = typeof pull.html_url === "string" ? pull.html_url : "";
  const references = pageReferences(typeof pull.body === "string" ? pull.body : "");
  if (!url || references.length === 0) return;
  const spaces = [...new Set(references.map((reference) => reference.spaceId))];

  if (action === "closed") {
    if (pull.merged !== true) return;
    const authorId = record(pull.user).id;
    const author = typeof authorId === "number" || typeof authorId === "string"
      ? await authUserByGitHubId(env, String(authorId)) : null;
    const installationId = String(record(payload.installation).id ?? "");
    for (const spaceId of spaces) {
      const { completed } = await pages(env).completePullRequestClaims({ requestId: crypto.randomUUID(), spaceId,
        pullRequestUrl: url });
      await askForWriteback(env, { pullRequestUrl: url, completed });
      // The sections those claims were on now owe an update; their `owed` Automations run.
      for (const pageId of new Set(completed.map((claim) => claim.pageId))) {
        await fireOwedAutomationTriggers(env, { spaceId, pageId,
          blockIds: completed.filter((claim) => claim.pageId === pageId).map((claim) => claim.blockId),
          event: { id: `owed:${url}:${pageId}`.slice(0, 200), kind: "owed", url,
            summary: `Pull request ${url} was merged, so the section it claimed owes an update` } })
          .catch((error: unknown) => console.error("owed Automation triggers failed", error));
      }
      if (author) await promoteContributor(env, { spaceId, userId: author, installationId, pullRequestUrl: url });
    }
    return;
  }
  if (!CHECKED_ACTIONS.has(action)) return;
  const [owner, repo] = String(record(payload.repository).full_name ?? "").split("/");
  const headSha = String(record(pull.head).sha ?? "");
  const authorId = record(pull.user).id;
  if (!owner || !repo || !headSha || (typeof authorId !== "number" && typeof authorId !== "string")) return;
  const userId = await authUserByGitHubId(env, String(authorId));

  for (const spaceId of spaces) {
    const results = [];
    for (const reference of references.filter((item) => item.spaceId === spaceId)) {
      const result = await pages(env).pullRequestClaim({ requestId: crypto.randomUUID(), spaceId,
        pageId: reference.pageId, blockId: reference.blockId, ownerUserId: userId, pullRequestUrl: url });
      if (result) results.push({ reference, ...result });
    }
    const first = results[0];
    if (!first) continue;
    const connection = await findAppConnection(env, { spaceId, providerId: "github", actorUserId: first.spaceOwnerUserId });
    if (connection?.status !== "configured") continue;
    const link = (reference: PageReference) => `${appOrigin(env)}/app/${encodeURIComponent(spaceId)}/pages?page=${
      encodeURIComponent(reference.pageId)}${reference.blockId ? `#${reference.blockId}` : ""}`;
    const held = results.find((result) => result.claim);
    const where = (result: typeof first) =>
      `${result.pageTitle ?? "a missing page"}${result.reference.blockId ? ` › #${result.reference.blockId}` : ""}`;
    await publishGitHubCheckRun(env, connection, { owner, repo }, held ? {
      name: CLAIM_CHECK_NAME, headSha, conclusion: "success", detailsUrl: link(held.reference),
      title: `${held.claim!.holder.label} holds ${where(held)}`,
      summary: `This pull request does the work claimed on [${where(held)}](${link(held.reference)}). ` +
        "Merging it completes the claim.",
    } : {
      name: CLAIM_CHECK_NAME, headSha, conclusion: "failure", detailsUrl: link(first.reference),
      title: userId ? "No claim on the referenced block" : "GitHub account not linked to xMatrix",
      summary: userId
        ? `Claim ${results.map((result) => `[${where(result)}](${link(result.reference)})`).join(", ")} ` +
          "first — with Claim on the page, or `xmatrix page claim <page-id> --block <heading>` for your Agent — " +
          "then push or edit this pull request to check again."
        : "Link your GitHub account in xMatrix (Settings → Profile → GitHub) so this pull request counts as your " +
          "claimed work, then push or edit it to check again.",
    });
    const number = Number(pull.number);
    if (held && REVIEWED_ACTIONS.has(action) && pull.draft !== true && Number.isInteger(number)) {
      await startPreReview(env, { spaceId, spaceOwnerUserId: first.spaceOwnerUserId, connection,
        pull: { url, owner, repo, number }, pageId: held.reference.pageId, blockId: held.reference.blockId,
        restricted: held.restricted, holder: held.claim!.holder.label, blockLink: link(held.reference) });
    }
  }
}

/**
 * The pull request did the work claimed on a section, so the section owes an
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
    const body = [`${input.pullRequestUrl} is merged. It did the work claimed on:`, ...sections, "",
      "Update what these sections say now with `xmatrix page edit`, or run `xmatrix page done -m \"<why>\"` " +
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
  const governance = new PostgresGovernanceRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-governance", statementTimeoutMs: 5_000, transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
  const role = await governance.roleOf({ requestId: crypto.randomUUID(), spaceId: input.spaceId, userId: input.userId });
  if (role !== "participant") return;
  const { ownerUserId } = await governance.read({ requestId: crypto.randomUUID(), spaceId: input.spaceId });
  const connection = await findAppConnection(env, { spaceId: input.spaceId, providerId: "github", actorUserId: ownerUserId });
  if (!connection || !githubConnectionInstallationIds(connection).includes(input.installationId)) return;
  await changeMembership(env, {
    commandId: `space-contributor:${input.spaceId}:${input.userId}`.slice(0, 200),
    actorUserId: ownerUserId, at: new Date().toISOString(), kind: "space_member_put",
    spaceId: input.spaceId, userId: input.userId, role: "member",
  });
}
