import { PostgresAutomationRepository, PostgresPageRepository } from "@xmatrix/db";
import { pageSchedules, removeScheduleLine, setScheduleStatus, type PageDocument } from "@xmatrix/protocol";
import type { Context, Hono } from "hono";
import type { AuthUser } from "./auth";
import { automationEvaluatorBinding } from "./automation-evaluator-binding";
import { commandPayload, expressionPayload, hubBoundary, type AutomationRecord } from "./index-routes-automation";
import { sessionCall, sessionPrincipal } from "./index-routes-pages";
import { productCommandId, requireAuth, requestErrorStatus } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { commitAutomation } from "./automations";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import { runPrincipalOf } from "./run-principal";
import type { Env } from "./types";

/**
 * A page's Automations (docs/design/pages-live-document.md §6). Each is a
 * line of its page, which is what it is: the page session syncs each revision
 * that changes its lines (page-schedule-sync.ts), and pausing, resuming or
 * deleting one here changes its line. A conversation of its own times it, and
 * each occurrence runs in a fresh conversation linked to its section. Whoever
 * can edit the page manages them, people and Agents alike, and always as a
 * Human: an Agent acts as its owner, so what it sets up keeps running after
 * its Run ends.
 */

class Refusal extends Error {
  constructor(readonly response: Response) {
    super("refused");
  }
}

function refuse(status: number, code: string, error: string): never {
  throw new Refusal(Response.json({ error, code }, { status }));
}

function database(env: Env) {
  return createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-automations", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  });
}

/** The Human an Automation change is made as: the caller, or the Agent Run's owner. */
function humanOf(authUser: AuthUser): string {
  return authUser.agentRun?.ownerUserId ?? authUser.id;
}

/** The page as the caller, who must be able to edit it directly: an Agent on a suggest-only page asks a person. */
async function editablePage(env: Env, spaceId: string, pageId: string, authUser: AuthUser): Promise<PageDocument> {
  const { page } = await new PostgresPageRepository(database(env)).read({ requestId: crypto.randomUUID(),
    spaceId, pageId, principal: runPrincipalOf(authUser) });
  if (!page.canEdit) refuse(403, "page_edit_forbidden", "Only someone who can edit the page changes its Automations");
  if (authUser.agentRun && page.agentSuggestOnly) {
    refuse(403, "page_automation_needs_person",
      "This page takes an Agent's changes as suggestions; ask a person to change its Automations");
  }
  return page;
}

/** The page's Automations, each with the section its reference is in now (none when detached). */
async function pageAutomations(env: Env, spaceId: string, pageId: string, userId: string,
  /** The page's text, when the caller has already read it. */
  read?: Promise<{ page: PageDocument }>): Promise<AutomationRecord[]> {
  const [{ tasks }, { page }] = await Promise.all([
    new PostgresAutomationRepository(database(env)).listPage({ requestId: crypto.randomUUID(), spaceId, pageId, userId }),
    read ?? new PostgresPageRepository(database(env)).read({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: { kind: "user", id: userId } }),
  ]);
  const sections = new Map(pageSchedules(page.body).map((line) => [line.source, line.blockId]));
  return (tasks as AutomationRecord[]).map((automation) => {
    const blockId = sections.get(String(automation.source ?? ""));
    return blockId !== undefined ? { ...automation, blockId } : automation;
  });
}

async function pageAutomation(env: Env, spaceId: string, pageId: string, userId: string,
  automationId: string): Promise<AutomationRecord> {
  const found = (await pageAutomations(env, spaceId, pageId, userId)).find((item) => item.id === automationId);
  if (!found) refuse(404, "automation_not_found", "This page has no such Automation");
  return found;
}

/** Commits one Automation command; its conversation's coordinator times it. */
async function command(env: Env, request: Request, stableId: string, body: Record<string, unknown>): Promise<void> {
  await commitAutomation(env, {
    commandId: productCommandId(request, "domain", stableId), at: new Date().toISOString(), ...body,
  });
}

/**
 * Changes the page's text through its live session, as the caller, so the
 * change is merged with concurrent edits and attributed like any edit. The
 * committed revision is what attaches or detaches the Automation.
 */
async function editPageText(env: Env, page: PageDocument & { spaceId: string }, authUser: AuthUser,
  conversationId: string, change: (body: string) => string): Promise<void> {
  // The timer's private conversation is not a grant to this Agent. Attribute
  // its page edit to the actual Run's conversation, just like an ordinary edit.
  const editConversationId = authUser.agentRun?.channelId ?? conversationId;
  let baseRevision = page.headRevision;
  let body = page.body;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = change(body);
    if (next === body) return;
    const response = await sessionCall(env, page.spaceId, page.pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser, editConversationId), baseRevision, body: next,
      conversationIds: [editConversationId] });
    const payload = await response.json().catch(() => ({})) as {
      kind?: string; code?: string; error?: string; detail?: { headRevision?: number; body?: string } };
    if (response.ok) return;
    if (response.status !== 409 || payload.code !== "page_revision_conflict") {
      throw new Refusal(Response.json({ error: payload.error ?? "The page could not be updated",
        code: payload.code ?? "page_edit_failed" }, { status: response.status }));
    }
    baseRevision = Number(payload.detail?.headRevision);
    body = String(payload.detail?.body ?? "");
  }
  refuse(409, "page_revision_conflict", "The page kept changing; try again");
}

/** The page, as someone who may edit it, and one of its Automations, read as the Human acting. */
async function target(env: Env, authUser: AuthUser, spaceId: string, pageId: string, automationId: string) {
  const page = await editablePage(env, spaceId, pageId, authUser);
  const userId = humanOf(authUser);
  return { page, userId, current: await pageAutomation(env, spaceId, pageId, userId, automationId) };
}

/** The line a schedule was synced from; one that never was is not on the page to change. */
function lineOf(automation: AutomationRecord): string {
  const payload = automation.payload && typeof automation.payload === "object"
    ? automation.payload as Record<string, unknown> : {};
  if (typeof payload.source !== "string" || !payload.source) {
    refuse(409, "schedule_line_missing", "This Automation has no line on its page; write one to run it");
  }
  return payload.source;
}

/**
 * Pauses, resumes or deletes a page's schedule by changing its line, as the
 * caller, through the page's live session (docs/design/pages-live-document.md
 * §6.1): the line is what the schedule is, so the revision that changes it is
 * what pauses, resumes or deletes it. Running it now changes nothing on the
 * page: its next occurrence is due at once, as its author, and its cadence
 * continues from there.
 */
export async function changePageAutomation(env: Env, request: Request, authUser: AuthUser, spaceId: string,
  pageId: string, automationId: string, action: "pause" | "resume" | "run" | "delete"): Promise<AutomationRecord | undefined> {
  const { page, userId, current } = await target(env, authUser, spaceId, pageId, automationId);
  const source = lineOf(current);
  if (action !== "run") {
    await editPageText(env, { ...page, spaceId }, authUser, current.channelId, (text) => action === "delete"
      ? removeScheduleLine(text, source) : setScheduleStatus(text, source, action === "pause" ? "paused" : "running"));
    // The revision the edit commits is what pauses, resumes or deletes it; the page session syncs it.
    return undefined;
  }
  if (!current.capabilities.run || !current.enabled) {
    refuse(409, "forbidden", current.enabled ? "This Automation cannot run now" : "This Automation is paused; resume it to run it");
  }
  const parsed = expressionPayload(hubBoundary, current, {});
  const binding = automationEvaluatorBinding(current);
  if (!parsed || !binding) refuse(409, "invalid_request", "This Automation has nothing it can run");
  await command(env, request, `page-automation:${current.id}:run:${current.version}`, {
    actorUserId: userId, principal: { kind: "user", id: userId },
    viaAgentRun: Boolean(authUser.agentRun), kind: "automation_put", automationId: current.id,
    expectedVersion: current.version, channelId: current.channelId, nextRunAt: new Date().toISOString(),
    enabled: true,
    payload: commandPayload(hubBoundary, parsed, current, current.channelId, binding.actor,
      binding.authorityRootUserId, current.id),
    automationAction: "run",
  });
  const updated = await pageAutomation(env, spaceId, pageId, userId, current.id);
  await notifyPageAutomations(env, spaceId);
  return updated;
}

function notifyPageAutomations(env: Env, spaceId: string): Promise<void> {
  return notifyWorkspaceResource(env, { spaceId, resource: "automations" });
}

/** A refusal as its response; a repository's typed refusal by its status and code. */
export function pageAutomationFailure(error: unknown): Response {
  if (error instanceof Refusal) return error.response;
  const { status, code, detail } = error as { status?: unknown; code?: unknown; detail?: unknown };
  if (typeof status === "number" && status >= 400 && status < 500 && typeof code === "string") {
    return Response.json({ error: (error as Error).message, code, ...(detail ? { detail } : {}) }, { status });
  }
  return Response.json({ error: (error as Error).message }, { status: requestErrorStatus(error) });
}

export function registerPageAutomationRoutes(app: Hono<{ Bindings: Env }>): void {
  const base = "/api/spaces/:spaceId/pages/:pageId/automations";
  const run = (c: Context<{ Bindings: Env }>,
    work: (authUser: AuthUser, body: Record<string, unknown>) => Promise<unknown>, status: 200 | 201 = 200) =>
    (async () => {
      const authUser = await requireAuth(c.req.raw, c.env);
      const body = c.req.method === "GET" ? {}
        : await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
      return c.json(await work(authUser, body) as Record<string, unknown>, status, { "cache-control": "no-store" });
    })().catch(pageAutomationFailure);
  const ids = (c: Context<{ Bindings: Env }>) => [c.req.param("spaceId")!, c.req.param("pageId")!] as const;

  app.get(base, (c) => run(c, async (authUser) => {
    const [spaceId, pageId] = ids(c);
    // Reading the page as the caller is the access check, and its text says where each Automation is; the list,
    // read as its Human alongside, is answered only once that read has passed.
    const read = new PostgresPageRepository(database(c.env)).read({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: runPrincipalOf(authUser) });
    return { automations: await pageAutomations(c.env, spaceId, pageId, humanOf(authUser), read) };
  }));
  for (const action of ["pause", "resume", "run"] as const) {
    app.post(`${base}/:automationId/${action}`, (c) => run(c, async (authUser) => ({
      automation: await changePageAutomation(c.env, c.req.raw, authUser, ...ids(c), c.req.param("automationId")!,
        action) })));
  }
  app.delete(`${base}/:automationId`, (c) => run(c, async (authUser) => {
    const automationId = c.req.param("automationId")!;
    await changePageAutomation(c.env, c.req.raw, authUser, ...ids(c), automationId, "delete");
    return { ok: true, automationId };
  }));
}
