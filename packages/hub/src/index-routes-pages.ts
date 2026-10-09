import { MAX_PAGE_CONVERSATIONS, PageControlError, PostgresPageRepository, readPageConversations,
  type PagePrincipal } from "@xmatrix/db";
import { ServiceUnavailable } from "./error-contract";
import { relayResponse } from "./private-response";
import type { Context, Hono } from "hono";
import { authorityFailure, requestPrincipal, runPrincipalOf } from "./run-principal";
import { requireAuth } from "./index-shared";
import { publishPreReviewVerdict } from "./github-pre-review";
import { gitHubFileReferenceHref, gitHubFileReferences, pageLineDiff, parseGitHubFileReference, type PageAwareness,
  type PageChanges, type PageConversation, type PageLink, type PageLinkAnchor, type PageTreeActivity } from "@xmatrix/protocol";
import { canonicalPageMarkdown } from "@xmatrix/protocol/page-document";
import type { AuthUser } from "./auth";
import { PAGE_SESSION_HEARTBEAT_PING, PAGE_SESSION_SUBPROTOCOL_PREFIX, pageSessionId } from "./page-session-do";
import { PAGE_DOCUMENT_FRAGMENT, type PageSessionPresent, type PageSessionPrincipal } from "./page-session";
import { pageConversation, pageTreeDiscussions, workingBySection } from "./page-conversations";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import { requireMachineDaemonAuth } from "./index-shared";
import { tellPageAutomationChannels } from "./page-automation-wake";
import { fireOwedAutomationTriggers } from "./automation-triggers";
import { readGitHubFile, type GitHubFileContent } from "./app-connectors";
import { findAppConnection } from "./apps";
import type { Env } from "./types";

/**
 * Pages (docs/design/pages-and-conversations.md): the Space's markdown page
 * tree, its revisions and conversation links. Every route
 * only names the principal; authorization lives in the page repository.
 */
/**
 * Page checkout waits as long as a message checkout. The 3s driver default
 * dies under Hyperdrive contention and is then reported as a database outage.
 * The statement, transaction and lock budgets stay where they are.
 */
export const pageDatabaseOptions = {
  applicationName: "xmatrix-pages",
  connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
  statementTimeoutMs: 5_000,
  transactionTimeoutMs: 10_000,
  lockTimeoutMs: 2_000,
} as const;

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, pageDatabaseOptions);
}

function repository(env: Env): PostgresPageRepository {
  return new PostgresPageRepository(database(env));
}

/**
 * The conversations a page's links name, as the caller sees them beside the
 * page (pages-live-document.md §4.4); the most recently linked first.
 */
async function linkedConversations(env: Env, spaceId: string, caller: PagePrincipal,
  links: readonly PageLink[]): Promise<PageConversation[]> {
  const conversationIds = [...new Set(links.map((link) => link.conversationId))].slice(0, MAX_PAGE_CONVERSATIONS);
  return (await readPageConversations(database(env), { requestId: crypto.randomUUID(), spaceId,
    principal: caller, conversationIds })).map(pageConversation);
}

const principal = requestPrincipal;

function failure(c: Context<{ Bindings: Env }>, error: unknown): Response {
  return authorityFailure(c, error, error instanceof PageControlError ? error.detail : undefined);
}

async function json(c: Context<{ Bindings: Env }>): Promise<Record<string, unknown>> {
  return c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function integer(value: unknown): number {
  return typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
}

const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * Files read for page embeds in the last minute, per Space connection, so a
 * busy page does not spend GitHub's rate limit. A failed read is not kept.
 */
const GITHUB_FILE_CACHE_MS = 60_000;
const GITHUB_FILE_CACHE_ENTRIES = 200;
const githubFiles = new Map<string, { at: number; file: Promise<GitHubFileContent> }>();

function cachedGitHubFile(key: string, read: () => Promise<GitHubFileContent>): Promise<GitHubFileContent> {
  const now = Date.now();
  const hit = githubFiles.get(key);
  if (hit && now - hit.at < GITHUB_FILE_CACHE_MS) return hit.file;
  githubFiles.delete(key);
  const file = read();
  githubFiles.set(key, { at: now, file });
  file.catch(() => { if (githubFiles.get(key)?.file === file) githubFiles.delete(key); });
  while (githubFiles.size > GITHUB_FILE_CACHE_ENTRIES) githubFiles.delete(githubFiles.keys().next().value!);
  return file;
}

/** The page named by the route, read as the caller, which is also its access check. */
async function readAsCaller(c: Context<{ Bindings: Env }>) {
  const spaceId = c.req.param("spaceId")!;
  const pageId = c.req.param("pageId")!;
  const authUser = await requireAuth(c.req.raw, c.env);
  const { page } = await repository(c.env).read({ requestId: crypto.randomUUID(), spaceId, pageId,
    principal: runPrincipalOf(authUser) });
  return { spaceId, pageId, authUser, page };
}

export function sessionPrincipal(authUser: AuthUser, conversationId?: string): PageSessionPrincipal {
  const run = authUser.agentRun;
  if (!run) return { kind: "user", id: authUser.id, label: authUser.name || authUser.email };
  return { kind: "agent", id: run.agentId, label: run.agentName || run.agentId, ownerUserId: run.ownerUserId,
    runProof: { runId: run.runId, instanceId: run.instanceId ?? "", executionKey: run.executionKey },
    conversationId: conversationId ?? run.channelId };
}

/** Tells a live session that the head or its settings changed outside it. */
async function refreshSession(env: Env, spaceId: string, pageId: string, authUser: AuthUser,
  settings: { agentSuggestOnly?: boolean; redact?: { needle: string; replacement: string } } = {}): Promise<void> {
  if (!env.RELAY_PAGE_SESSION) return;
  await sessionCall(env, spaceId, pageId, "/internal/reload", { principal: sessionPrincipal(authUser), ...settings });
}

function pageSession(env: Env, spaceId: string, pageId: string): DurableObjectStub {
  const namespace = env.RELAY_PAGE_SESSION;
  if (!namespace) throw new PageControlError("page_session_unavailable", 503, "Live page sessions are unavailable");
  return namespace.get(namespace.idFromName(pageSessionId(spaceId, pageId)));
}

export async function sessionCall(env: Env, spaceId: string, pageId: string, path: string,
  body: Record<string, unknown>): Promise<Response> {
  return pageSession(env, spaceId, pageId).fetch(new Request(`https://page-session${path}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ spaceId, pageId, ...body }),
  }));
}

async function sessionResponse(c: Context<{ Bindings: Env }>, work: () => Promise<Response>): Promise<Response> {
  try {
    return relayResponse(await work(), { "content-type": "application/json", ...NO_STORE });
  } catch (error) {
    return failure(c, error);
  }
}

/** Who is on the page right now, from its live session; nobody when it has none. */
async function sessionPresent(env: Env, spaceId: string, pageId: string): Promise<PageSessionPresent[]> {
  if (!env.RELAY_PAGE_SESSION) return [];
  return pageSession(env, spaceId, pageId).fetch(new Request("https://page-session/internal/presence"))
    .then((response) => response.ok ? response.json() as Promise<{ present: PageSessionPresent[] }> : { present: [] })
    .then((result) => result.present, () => []);
}

/** Shows everyone on the page the claims now in force. */
async function announceClaims(c: Context<{ Bindings: Env }>): Promise<void> {
  if (!c.env.RELAY_PAGE_SESSION) return;
  const spaceId = c.req.param("spaceId")!;
  const pageId = c.req.param("pageId")!;
  const { claims } = await repository(c.env).claims({ requestId: crypto.randomUUID(), spaceId, pageId,
    principal: await principal(c) });
  await sessionCall(c.env, spaceId, pageId, "/internal/claims", { claims });
}

export function registerPageRoutes(app: Hono<{ Bindings: Env }>): void {
  const base = "/api/spaces/:spaceId/pages";
  const run = <T>(c: Context<{ Bindings: Env }>, work: () => Promise<T>) =>
    work().then((result) => c.json(result as Record<string, unknown>, 200, NO_STORE), (error) => failure(c, error));

  // `xmatrix page done`: the Run's work changed nothing more on the pages, so
  // the sections its conversation's ended claims left owing an update are settled.
  app.post("/api/channels/:channelId/page-writeback", async (c) => run(c, async () => repository(c.env)
    .settleWriteback({ requestId: crypto.randomUUID(), conversationId: c.req.param("channelId"),
      principal: await principal(c) })));

  // A Run knows its conversation, not its Space: resolve the Space it may read pages in.
  app.get("/api/channels/:channelId/page-space", async (c) => run(c, async () => repository(c.env)
    .spaceOfConversation({ requestId: crypto.randomUUID(), conversationId: c.req.param("channelId"),
      principal: await principal(c) })));

  app.get(base, async (c) => run(c, async () => repository(c.env).tree({
    requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: await principal(c),
  })));

  // Ctrl+F: title and current text of every page the caller can read.
  app.get(`${base}/search`, async (c) => run(c, async () => repository(c.env).search({
    requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: await principal(c),
    query: c.req.query("query") ?? "",
  })));

  // The Pages list's Recent changes: the pages that changed last and what each change was.
  app.get(`${base}/recent-changes`, async (c) => run(c, async () => {
    const limit = c.req.query("limit");
    return repository(c.env).recentChanges({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: await principal(c),
      ...(limit ? { limit: Number(limit) } : {}),
    });
  }));

  app.post(base, async (c) => run(c, async () => {
    const body = await json(c);
    return repository(c.env).create({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: await principal(c),
      title: body.title as string,
      ...(body.parentPageId !== undefined ? { parentPageId: body.parentPageId as string | null } : {}),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(body.afterPageId !== undefined ? { afterPageId: body.afterPageId as string | null } : {}),
      ...(body.accessMode !== undefined ? { accessMode: body.accessMode as "open" | "restricted" } : {}),
    });
  }));

  app.get(`${base}/:pageId`, async (c) => run(c, async () => {
    const revision = c.req.query("revision");
    const conversationId = c.req.query("conversationId");
    const blockId = c.req.query("blockId");
    const spaceId = c.req.param("spaceId");
    const pageId = c.req.param("pageId");
    const authUser = await requireAuth(c.req.raw, c.env);
    const result = await repository(c.env).read({
      requestId: crypto.randomUUID(), spaceId, pageId, principal: runPrincipalOf(authUser),
      ...(revision ? { revision: Number(revision) } : {}),
      ...(conversationId ? { conversationId } : {}),
      ...(blockId ? { blockId } : {}),
    });
    // An Agent reading a page shows on it, where someone has it open.
    if (authUser.agentRun && c.env.RELAY_PAGE_SESSION) {
      c.executionCtx.waitUntil(sessionCall(c.env, spaceId, pageId, "/internal/view", {
        principal: sessionPrincipal(authUser, conversationId), blockId: blockId ?? "",
      }).then(() => undefined, () => undefined));
    }
    return result;
  }));

  // Every content edit goes through the page's live session, which merges it
  // with concurrent edits, streams it to readers under the editor's cursor and
  // commits it. Co-authors come only from the session, never from a client.
  app.put(`${base}/:pageId`, async (c) => sessionResponse(c, async () => {
    const body = await json(c);
    // Reading the page as the caller authorizes them before the session
    // shows them anything, including the current text of a conflict.
    const { spaceId, pageId, authUser } = await readAsCaller(c);
    const conversationIds = stringList(body.conversationIds);
    return sessionCall(c.env, spaceId, pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser, conversationIds[0]), baseRevision: integer(body.baseRevision),
      body: typeof body.body === "string" ? body.body : "", conversationIds,
    });
  }));

  // Publishing is a Space owner's or admin's own act; the repository refuses
  // Agents and pages that are not open to every member.
  app.put(`${base}/:pageId/publication`, async (c) => run(c, async () => {
    const body = await json(c);
    return repository(c.env).publish({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      pageId: c.req.param("pageId"), principal: await principal(c), published: body.published === true });
  }));

  // What a reader of each section should know besides its text
  // (pages-live-document.md §3): when and where it last changed, who has
  // taken it, who is on it now. People see it on the page; Agents read it
  // with the page.
  app.get(`${base}/:pageId/awareness`, async (c) => run(c, async (): Promise<PageAwareness> => {
    const spaceId = c.req.param("spaceId");
    const pageId = c.req.param("pageId");
    const caller = await principal(c);
    // Reading the updates checks the caller may read the page; the rest follows it.
    const { headRevision, order, updates, owed } = await repository(c.env).blockUpdates({ requestId: crypto.randomUUID(),
      spaceId, pageId, principal: caller });
    const [{ claims }, present, { links }] = await Promise.all([
      repository(c.env).claims({ requestId: crypto.randomUUID(), spaceId, pageId, principal: caller }),
      sessionPresent(c.env, spaceId, pageId),
      repository(c.env).links({ requestId: crypto.randomUUID(), spaceId, pageId, principal: caller }),
    ]);
    const discussions = links.filter((link) => link.anchor && !link.resolvedAt);
    const working = workingBySection(links, await linkedConversations(c.env, spaceId, caller, links));
    // In the page's order; a claim or a person on a section that is gone comes last.
    const blockIds = new Set([...order, ...claims.map((claim) => claim.blockId),
      ...discussions.map((link) => link.blockId), ...owed.keys(),
      ...present.map((person) => person.blockId ?? ""), ...working.keys()]);
    return { pageId, headRevision, blocks: [...blockIds].map((blockId) => ({
      blockId, updated: updates.get(blockId) ?? null,
      claims: claims.filter((claim) => claim.blockId === blockId),
      present: present.filter((person) => (person.blockId ?? "") === blockId)
        .map(({ name, kind, activity, conversationId }) => ({ name, kind, activity, blockId, conversationId })),
      discussions: discussions.filter((link) => link.blockId === blockId)
        .map((link) => ({ linkId: link.linkId, conversationId: link.conversationId, quote: link.anchor!.quote })),
      owed: owed.get(blockId) ?? null,
      working: working.get(blockId) ?? [],
    })) };
  }));

  // How far the caller has read the page: what changed after it is shown as a
  // change when they open the page again (pages-live-document.md §3.1).
  app.get(`${base}/:pageId/read`, async (c) => run(c, async () => repository(c.env).readState({
    requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
    principal: await principal(c) })));
  app.put(`${base}/:pageId/read`, async (c) => run(c, async () => {
    const body = await json(c);
    return repository(c.env).markRead({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      pageId: c.req.param("pageId"), principal: await principal(c), revision: integer(body.revision) });
  }));

  // Claims: a lease on a block, so the Space sees who is on what. Anyone who
  // edits the page claims; an owner or admin opens a block for competition.
  app.get(`${base}/:pageId/claims`, async (c) => run(c, async () => repository(c.env).claims({
    requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
    principal: await principal(c) })));
  app.post(`${base}/:pageId/claims`, async (c) => run(c, async () => {
    const body = await json(c);
    const authUser = await requireAuth(c.req.raw, c.env);
    const result = await repository(c.env).claim({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      pageId: c.req.param("pageId"), principal: runPrincipalOf(authUser),
      ...(typeof body.blockId === "string" ? { blockId: body.blockId } : {}),
      ...(body.minutes !== undefined ? { minutes: integer(body.minutes) } : {}),
      ...(authUser.agentRun ? { conversationId: authUser.agentRun.channelId } : {}) });
    await announceClaims(c);
    return result;
  }));
  app.delete(`${base}/:pageId/claims/:claimId`, async (c) => run(c, async () => {
    const result = await repository(c.env).releaseClaim({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"), claimId: c.req.param("claimId"),
      principal: await principal(c) });
    if (result.released) {
      await announceClaims(c);
      // A released claim whose section was not written back owes an update; its `owed` Automations run.
      const blockId = result.blockId ?? "";
      const { owed } = await repository(c.env).blockUpdates({ requestId: crypto.randomUUID(),
        spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"), principal: await principal(c) });
      if (owed.has(blockId)) {
        await fireOwedAutomationTriggers(c.env, { spaceId: c.req.param("spaceId")!, pageId: c.req.param("pageId")!,
          blockIds: [blockId], event: { id: `owed:claim:${c.req.param("claimId")}`.slice(0, 200),
            kind: "owed", summary: `A claim on #${blockId || "the page"} was released, so it owes an update` } })
          .catch((error: unknown) => console.error("owed Automation triggers failed", error));
      }
    }
    return { released: result.released };
  }));
  app.put(`${base}/:pageId/competition`, async (c) => run(c, async () => {
    const body = await json(c);
    return repository(c.env).setCompetition({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      pageId: c.req.param("pageId"), principal: await principal(c), open: body.open === true,
      ...(typeof body.blockId === "string" ? { blockId: body.blockId } : {}) });
  }));

  // A pull request's review conversation records its pre-review verdict, as
  // the Agent reviewing it there, on the head commit that Run reviewed.
  app.post("/api/channels/:channelId/pre-review", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const channelId = c.req.param("channelId");
      const run = authUser.agentRun;
      if (!run || run.channelId !== channelId) {
        return c.json({ error: "Only the Agent reviewing in this conversation records its verdict",
          code: "pre_review_agent_only" }, 403);
      }
      const body = await json(c);
      if (body.verdict !== "pass" && body.verdict !== "changes") {
        return c.json({ error: "verdict is pass or changes", code: "invalid_request" }, 400);
      }
      const summary = typeof body.summary === "string" ? body.summary.trim() : "";
      if (!summary || summary.length > 4_000) {
        return c.json({ error: "summary is 1-4000 characters", code: "invalid_request" }, 400);
      }
      return c.json(await publishPreReviewVerdict(c.env, { channelId, actorUserId: run.ownerUserId,
        runId: run.runId, verdict: body.verdict, summary }), 200, NO_STORE);
    } catch (error) {
      return failure(c, error);
    }
  });

  // A public page for anyone, signed in or not, with who is on it right now.
  // A page that is not public is not found, whatever the reason.
  app.get("/api/public/spaces/:spaceId/pages/:pageId", async (c) => {
    try {
      const spaceId = c.req.param("spaceId");
      const pageId = c.req.param("pageId");
      const { page } = await repository(c.env).publicRead({ requestId: crypto.randomUUID(), spaceId, pageId });
      // Names and what they are doing; never their conversations or where they are.
      const present = (await sessionPresent(c.env, spaceId, pageId))
        .map(({ name, color, kind, activity }) => ({ name, color, kind, activity }));
      return c.json({ page, present }, 200, { "cache-control": "public, max-age=10" });
    } catch (error) {
      // Not public, missing, or in no such Space: all the same to a reader.
      if (error instanceof PageControlError && error.status === 404) {
        return c.json({ error: "Page not found", code: "page_not_found" }, 404);
      }
      return failure(c, error);
    }
  });

  // A live session: the caller's access is checked now and re-checked by the session.
  app.post(`${base}/:pageId/live`, async (c) => {
    try {
      // A page is a document now (pages-live-document.md §4.1). A client that
      // still edits it as markdown text would write where nobody reads, so it
      // is told to reload instead of joining.
      if ((await json(c)).document !== PAGE_DOCUMENT_FRAGMENT) {
        return c.json({ error: "This page editor is out of date; reload to keep editing", code: "page_client_outdated" },
          409, NO_STORE);
      }
      const { spaceId, pageId, authUser, page } = await readAsCaller(c);
      const ticket = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
      const registered = await sessionCall(c.env, spaceId, pageId, "/internal/ticket", {
        ticket, principal: sessionPrincipal(authUser), canEdit: page.canEdit,
      });
      if (!registered.ok) throw new ServiceUnavailable("page_session_unavailable", "Page session is unavailable");
      return c.json({ protocol: `${PAGE_SESSION_SUBPROTOCOL_PREFIX}${ticket}`,
        socketPath: `/ws/pages/${encodeURIComponent(spaceId)}/${encodeURIComponent(pageId)}`,
        canEdit: page.canEdit, headRevision: page.headRevision, heartbeat: PAGE_SESSION_HEARTBEAT_PING }, 200, NO_STORE);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get("/ws/pages/:spaceId/:pageId", async (c) => {
    try {
      const protocol = c.req.header("sec-websocket-protocol")?.split(",")[0]?.trim() ?? "";
      if (c.req.header("Upgrade") !== "websocket" || !protocol.startsWith(PAGE_SESSION_SUBPROTOCOL_PREFIX)) {
        return c.json({ error: "Expected a page session WebSocket" }, 426);
      }
      const headers = new Headers(c.req.raw.headers);
      headers.set("x-xmatrix-page-ticket", protocol.slice(PAGE_SESSION_SUBPROTOCOL_PREFIX.length));
      return await pageSession(c.env, c.req.param("spaceId"), c.req.param("pageId"))
        .fetch(new Request("https://page-session/ws", { headers }));
    } catch (error) {
      return failure(c, error);
    }
  });

  app.patch(`${base}/:pageId`, async (c) => run(c, async () => {
    const body = await json(c);
    const authUser = await requireAuth(c.req.raw, c.env);
    const result = await repository(c.env).update({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
      principal: runPrincipalOf(authUser),
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.parentPageId !== undefined ? { parentPageId: body.parentPageId as string | null } : {}),
      ...(body.afterPageId !== undefined ? { afterPageId: body.afterPageId as string | null } : {}),
      ...(body.accessMode !== undefined ? { accessMode: body.accessMode as "open" | "restricted" } : {}),
      ...(typeof body.agentSuggestOnly === "boolean" ? { agentSuggestOnly: body.agentSuggestOnly } : {}),
      ...(Array.isArray(body.access) ? { access: body.access as Array<{ userId: string; access: "read" | "edit" }> } : {}),
    });
    if (typeof body.agentSuggestOnly === "boolean") {
      await refreshSession(c.env, c.req.param("spaceId"), c.req.param("pageId"), authUser,
        { agentSuggestOnly: body.agentSuggestOnly });
    }
    return result;
  }));

  // Removal goes through the page's session, so it is ordered after any write in flight.
  app.delete(`${base}/:pageId`, async (c) => sessionResponse(c, async () => {
    const authUser = await requireAuth(c.req.raw, c.env);
    return sessionCall(c.env, c.req.param("spaceId"), c.req.param("pageId"), "/internal/remove",
      { principal: sessionPrincipal(authUser) });
  }));

  // What changed since a revision the caller read (`xmatrix page read --since`):
  // the revisions after it and their diff, compared as documents so a change
  // of markdown style is no change (pages-live-document.md §3.1).
  app.get(`${base}/:pageId/changes`, async (c) => run(c, async (): Promise<PageChanges> => {
    const since = Number(c.req.query("since"));
    if (!Number.isSafeInteger(since) || since < 1) throw new PageControlError("invalid_request", 400, "since is a revision");
    const spaceId = c.req.param("spaceId");
    const pageId = c.req.param("pageId");
    const caller = await principal(c);
    const read = (revision?: number) => repository(c.env).read({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: caller, ...(revision ? { revision } : {}) }).then((result) => result.page);
    const [head, before] = await Promise.all([read(), read(since)]);
    const { revisions } = await repository(c.env).history({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: caller, limit: 50 });
    return {
      pageId, since, headRevision: head.headRevision,
      revisions: revisions.filter((revision) => revision.revision > since && revision.kind !== "suggestion")
        .sort((a, b) => a.revision - b.revision),
      diff: pageLineDiff(canonicalPageMarkdown(before.body), canonicalPageMarkdown(head.body)),
    };
  }));

  app.get(`${base}/:pageId/history`, async (c) => run(c, async () => {
    const before = c.req.query("before");
    const limit = c.req.query("limit");
    return repository(c.env).history({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
      principal: await principal(c),
      ...(before ? { before: Number(before) } : {}), ...(limit ? { limit: Number(limit) } : {}),
    });
  }));

  // A GitHub file the page embeds (pages-live-document.md §6.5), read through
  // as the caller: only a file the page's head text references, only through
  // this Space's GitHub connection, and never stored.
  app.get(`${base}/:pageId/github-file`, async (c) => {
    try {
      const { spaceId, authUser, page } = await readAsCaller(c);
      const reference = parseGitHubFileReference(c.req.query("href") ?? "");
      if (!reference) return c.json({ error: "href is not a GitHub file embed", code: "invalid_request" }, 400);
      const href = gitHubFileReferenceHref(reference);
      if (!gitHubFileReferences(page.body).includes(href)) {
        return c.json({ error: "The page does not embed this file", code: "page_github_file_not_referenced" }, 404);
      }
      const connection = await findAppConnection(c.env, { spaceId, providerId: "github",
        actorUserId: authUser.agentRun?.ownerUserId ?? authUser.id });
      if (!connection || connection.status !== "configured") {
        return c.json({ error: "Connect GitHub for this Space to show embedded files",
          code: "github_connection_required" }, 409);
      }
      const [owner, repo] = reference.repository.split("/") as [string, string];
      const read = () => readGitHubFile(c.env, connection, { owner, repo, path: reference.path, ref: reference.ref });
      // A changed installation/grant must not reuse the old connection's content.
      const file = Number.isSafeInteger(connection.version) && connection.version! > 0
        ? await cachedGitHubFile(`${connection.id}\u0000${connection.version}\u0000${href}`, read)
        : await read();
      return c.json(file as unknown as Record<string, unknown>, 200, NO_STORE);
    } catch (error) {
      return failure(c, error);
    }
  });

  app.post(`${base}/:pageId/revisions/:revision/promote`, async (c) => run(c, async () => {
    const body = await json(c);
    const authUser = await requireAuth(c.req.raw, c.env);
    const result = await repository(c.env).promote({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
      principal: runPrincipalOf(authUser), revision: Number(c.req.param("revision")),
      baseRevision: integer(body.baseRevision),
    });
    await tellPageAutomationChannels(c.env, result.automationChannels);
    await refreshSession(c.env, c.req.param("spaceId"), c.req.param("pageId"), authUser);
    return { page: result.page, revision: result.revision };
  }));

  // Redaction also replaces the text of a live session, whose CRDT then drops the deleted content.
  app.post(`${base}/:pageId/purge`, async (c) => run(c, async () => {
    const body = await json(c);
    const authUser = await requireAuth(c.req.raw, c.env);
    const result = await repository(c.env).purge({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), pageId: c.req.param("pageId"),
      principal: runPrincipalOf(authUser), needle: body.needle as string,
      ...(typeof body.replacement === "string" ? { replacement: body.replacement } : {}),
    });
    await refreshSession(c.env, c.req.param("spaceId"), c.req.param("pageId"), authUser, { redact: {
      needle: body.needle as string,
      replacement: typeof body.replacement === "string" ? body.replacement : "[redacted]",
    } });
    return result;
  }));

  app.get("/api/spaces/:spaceId/page-links", async (c) => run(c, async () => {
    const pageId = c.req.query("pageId");
    const conversationId = c.req.query("conversationId");
    const spaceId = c.req.param("spaceId");
    const caller = await principal(c);
    const result = await repository(c.env).links({
      requestId: crypto.randomUUID(), spaceId, principal: caller,
      ...(pageId ? { pageId } : {}), ...(conversationId ? { conversationId } : {}),
    });
    // A page's links come with what the page shows beside each conversation.
    return pageId ? { ...result, conversations: await linkedConversations(c.env, spaceId, caller, result.links) }
      : result;
  }));

  // The page tree's activity: who is reading or editing each page from a live
  // Run, and its open discussions, with what this reader has not read there.
  app.get("/api/spaces/:spaceId/page-links/agents", async (c) => run(c, async () => {
    const spaceId = c.req.param("spaceId");
    const caller = await principal(c);
    const { pages } = await repository(c.env).agentsOnPages({ requestId: crypto.randomUUID(), spaceId, principal: caller });
    // Newest first, so a Space with more open discussions than are read describes the recent ones.
    const conversationIds = [...new Set(pages.flatMap((page) => page.discussions))].slice(0, MAX_PAGE_CONVERSATIONS);
    const conversations = new Map((conversationIds.length === 0 ? [] : await readPageConversations(database(c.env), {
      requestId: crypto.randomUUID(), spaceId, principal: caller, conversationIds,
    })).map((record) => [record.conversationId, pageConversation(record)]));
    return { pages: pages.map(({ discussions, ...page }): PageTreeActivity =>
      ({ ...page, discussions: pageTreeDiscussions(discussions, conversations) })) };
  }));

  app.post("/api/spaces/:spaceId/page-links", async (c) => run(c, async () => {
    const body = await json(c);
    const who = await principal(c);
    // Agents link by reference; humans may also correct links by hand.
    const source = who.kind === "agent" ? "reference"
      : body.source === "reference" ? "reference" : "manual";
    return repository(c.env).link({
      requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: who,
      conversationId: body.conversationId as string, pageId: body.pageId as string,
      ...(typeof body.blockId === "string" ? { blockId: body.blockId } : {}), source,
      // A discussion started on a range of text (pages-live-document.md §4.3).
      ...(body.anchor && typeof body.anchor === "object" ? { anchor: body.anchor as PageLinkAnchor } : {}),
    });
  }));

  // A discussion is resolved once its outcome is in the page; people and Agents who edit the page do it.
  app.put("/api/spaces/:spaceId/page-links/:linkId/resolution", async (c) => run(c, async () => {
    const body = await json(c);
    return repository(c.env).resolveLink({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      principal: await principal(c), linkId: c.req.param("linkId"), resolved: body.resolved !== false });
  }));

  app.delete("/api/spaces/:spaceId/page-links/:linkId", async (c) => run(c, async () => repository(c.env).unlink({
    requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: await principal(c),
    linkId: c.req.param("linkId"),
  })));

  // The pages a conversation is linked to, whole, for the mirror a Run reads:
  // as the caller, or through the Machine Daemon as the Machine's owner.
  const linkedPages = (env: Env, conversationId: string, reader: PagePrincipal) =>
    repository(env).conversationPages({ requestId: crypto.randomUUID(), conversationId, principal: reader });

  app.get("/api/channels/:channelId/pages", async (c) => run(c, async () =>
    linkedPages(c.env, c.req.param("channelId"), await principal(c))));

  const daemonRead = <T>(c: Context<{ Bindings: Env }>, read: (caller: PagePrincipal) => Promise<T>) =>
    run(c, async () => {
      const machine = await requireMachineDaemonAuth(c.req.raw, c.env);
      return read({ kind: "user", id: machine.ownerUserId });
    });

  app.get("/api/machine-daemon/channels/:channelId/pages", async (c) => daemonRead(c, (caller) =>
    linkedPages(c.env, c.req.param("channelId"), caller)));

  // The daemon renders the page tree into the mirror its Runs read, as the Machine's owner.
  app.get("/api/machine-daemon/spaces/:spaceId/pages", async (c) => daemonRead(c, (caller) =>
    repository(c.env).tree({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), principal: caller })));

  app.get("/api/machine-daemon/spaces/:spaceId/pages/:pageId", async (c) => daemonRead(c, (caller) =>
    repository(c.env).read({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
      pageId: c.req.param("pageId"), principal: caller })));
}
