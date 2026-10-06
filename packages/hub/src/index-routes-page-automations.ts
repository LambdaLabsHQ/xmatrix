import { PostgresAutomationRepository, PostgresPageRepository } from "@xmatrix/db";
import {
  automationReferences, automationTriggersFrom, insertAutomationReference, type AutomationTrigger, removeAutomationReference, replaceAutomationReference, type PageDocument,
} from "@xmatrix/protocol";
import type { Context, Hono } from "hono";
import type { AuthUser } from "./auth";
import { githubConnectionInstallationFor } from "./app-connectors";
import { automationEvaluatorBinding } from "./automation-evaluator-binding";
import {
  commandPayload, expressionPayload, hubBoundary, type AutomationRecord,
} from "./index-routes-automation";
import { sessionCall, sessionPrincipal } from "./index-routes-pages";
import { productCommandId, requireAuth, requestErrorStatus } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { commitAutomation } from "./automations";
import { createChannel } from "./spaces";
import { notifyWorkspaceResource } from "./workspace-resource-notification";
import { runPrincipalOf } from "./run-principal";
import type { Env } from "./types";
import { findAppConnection } from "./apps";

/**
 * A page's Automations (docs/design/pages-live-document.md §6). Each belongs
 * to its page and runs in a conversation of its own; its section is wherever
 * the page's text references it. Whoever can edit the page manages them,
 * people and Agents alike, and always as a Human: an Agent acts as its owner,
 * so what it sets up keeps running after its Run ends. An Automation is
 * attached only by its reference: it is created detached, and the page
 * revision that references it resumes it (§6.4).
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

/** A page restricted itself or through an ancestor keeps its Automations' conversations closed. */
async function effectivelyRestricted(env: Env, spaceId: string, pageId: string, userId: string): Promise<boolean> {
  const { pages } = await new PostgresPageRepository(database(env)).tree({ requestId: crypto.randomUUID(),
    spaceId, principal: { kind: "user", id: userId } });
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  for (let page = byId.get(pageId), depth = 0; page && depth < 64; page = page.parentPageId
    ? byId.get(page.parentPageId) : undefined, depth++) {
    if (page.accessMode === "restricted") return true;
  }
  return false;
}

/** The page's Automations, each with the section its reference is in now (none when detached). */
async function pageAutomations(env: Env, spaceId: string, pageId: string, userId: string): Promise<AutomationRecord[]> {
  const [{ tasks }, { page }] = await Promise.all([
    new PostgresAutomationRepository(database(env)).listPage({ requestId: crypto.randomUUID(), spaceId, pageId, userId }),
    new PostgresPageRepository(database(env)).read({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: { kind: "user", id: userId } }),
  ]);
  const sections = automationReferences(page.body);
  return (tasks as AutomationRecord[]).map((automation) => sections.has(automation.id)
    ? { ...automation, blockId: sections.get(automation.id) } : automation);
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
  let baseRevision = page.headRevision;
  let body = page.body;
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = change(body);
    if (next === body) return;
    const response = await sessionCall(env, page.spaceId, page.pageId, "/internal/edit", {
      principal: sessionPrincipal(authUser, conversationId), baseRevision, body: next,
      conversationIds: [conversationId] });
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

function initialNextRunAt(env: Env, intervalMinutes: number): string {
  const mockDelay = env.XMATRIX_MOCK_AUTH_TOKEN ? Number(env.XMATRIX_MOCK_SCHEDULE_DELAY_MS) : Number.NaN;
  const delayMs = Number.isSafeInteger(mockDelay) && mockDelay >= 250 ? mockDelay : intervalMinutes * 60_000;
  return new Date(Date.now() + delayMs).toISOString();
}

/** The authoring fields: an instruction is the natural-language text posted each time. */
function authoring(body: Record<string, unknown>): Record<string, unknown> {
  const { instruction, ...rest } = body;
  return typeof instruction === "string"
    ? { ...rest, expression: { kind: "text", language: "natural-language", text: instruction } } : rest;
}

function invalidAuthoring(): never {
  refuse(400, "invalid_request", `instruction is required and intervalMinutes must be between ${
    hubBoundary.AUTOMATION_MIN_INTERVAL_MINUTES} and ${hubBoundary.AUTOMATION_MAX_INTERVAL_MINUTES}`);
}

/**
 * The triggers a writer gave, validated; each GitHub one records the
 * installation of the Space's connection that covers its repository, so only
 * that installation's events fire it (docs/design/pages-live-document.md §6.2).
 */
async function resolvedTriggers(env: Env, spaceId: string, userId: string,
  value: unknown): Promise<AutomationTrigger[]> {
  let triggers: AutomationTrigger[];
  try {
    triggers = automationTriggersFrom(value);
  } catch (error) {
    refuse(400, "invalid_trigger", (error as Error).message);
  }
  const connection = async (providerId: string) => {
    const view = await findAppConnection(env, { spaceId, providerId, actorUserId: userId });
    return view?.status === "configured" ? view : undefined;
  };
  /* A connector event trigger needs that provider connected to the Space. */
  for (const provider of new Set(triggers.flatMap((trigger) => trigger.kind === "event" ? [trigger.provider] : []))) {
    if (!await connection(provider)) {
      refuse(409, "connector_connection_required", `Connect ${provider} for this Space to trigger on its events`);
    }
  }
  if (!triggers.some((trigger) => trigger.kind === "merged" || trigger.kind === "ci-failed")) return triggers;
  const github = await connection("github");
  if (!github) {
    refuse(409, "github_connection_required", "Connect GitHub for this Space to trigger on its repositories");
  }
  return Promise.all(triggers.map(async (trigger) => {
    if (trigger.kind === "owed" || trigger.kind === "event") return trigger;
    const [owner, repo] = trigger.repository.split("/") as [string, string];
    const installationId = await githubConnectionInstallationFor(env, github, owner, repo).catch(() =>
      refuse(409, "github_repository_not_connected",
        `This Space's GitHub connection does not cover ${trigger.repository}`));
    return { ...trigger, installationId };
  }));
}

function blockOf(body: Record<string, unknown>): string {
  return typeof body.blockId === "string" ? body.blockId.trim() : "";
}

export async function createPageAutomation(env: Env, request: Request, authUser: AuthUser, spaceId: string,
  pageId: string, body: Record<string, unknown>): Promise<AutomationRecord> {
  const page = await editablePage(env, spaceId, pageId, authUser);
  const userId = humanOf(authUser);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
  if (!name) refuse(400, "invalid_request", "name is required");
  const parsed = expressionPayload(hubBoundary, undefined, { ...authoring(body), name });
  if (!parsed) invalidAuthoring();
  const triggers = await resolvedTriggers(env, spaceId, userId, body.triggers);
  if (triggers.length) parsed.payload.triggers = triggers;
  const automationId = crypto.randomUUID();
  const channelId = crypto.randomUUID();
  await createChannel(env, {
    commandId: productCommandId(request, "create-channel", `page-automation:${automationId}`),
    channelId, spaceId, name: name.slice(0, 80),
    mode: await effectivelyRestricted(env, spaceId, pageId, userId) ? "closed" : "open",
    metadata: { createdBy: "page-automation", fromPageId: pageId }, principal: { kind: "user", id: userId },
  });
  const blockId = blockOf(body);
  await new PostgresPageRepository(database(env)).link({ requestId: crypto.randomUUID(), spaceId,
    principal: { kind: "user", id: userId }, conversationId: channelId, pageId,
    ...(blockId ? { blockId } : {}), source: "manual" });
  await command(env, request, `page-automation:${automationId}:create`, {
    actorUserId: userId, principal: { kind: "user", id: userId }, kind: "automation_put",
    // An Agent Run acts as its owner, but never with a Human admin's creation exception.
    viaAgentRun: Boolean(authUser.agentRun), automationId,
    expectedVersion: 0, channelId, pageId, detached: true, enabled: false,
    nextRunAt: initialNextRunAt(env, parsed.intervalMinutes),
    payload: commandPayload(hubBoundary, parsed, undefined, channelId, { kind: "user", id: userId }, userId,
      automationId),
    automationAction: "create",
  });
  await editPageText(env, { ...page, spaceId }, authUser, channelId,
    (text) => insertAutomationReference(text, blockId, automationId, name));
  const created = await pageAutomation(env, spaceId, pageId, userId, automationId);
  await notifyPageAutomations(env, spaceId);
  return created;
}

/** The page, as someone who may edit it, and one of its Automations, read as the Human acting. */
async function target(env: Env, authUser: AuthUser, spaceId: string, pageId: string, automationId: string) {
  const page = await editablePage(env, spaceId, pageId, authUser);
  const userId = humanOf(authUser);
  return { page, userId, current: await pageAutomation(env, spaceId, pageId, userId, automationId) };
}

function expectedVersionOf(body: Record<string, unknown>, automation: AutomationRecord): number {
  const version = Number(body.expectedVersion);
  if (!Number.isSafeInteger(version) || version !== automation.version) {
    refuse(409, "conflict", "expectedVersion must match the current Automation version");
  }
  return version;
}

/**
 * Edits, pauses or resumes a page's Automation. An Automation runs as its
 * author, so an edit by anyone else replaces it with their own and points the
 * page's reference at the replacement.
 */
export async function changePageAutomation(env: Env, request: Request, authUser: AuthUser, spaceId: string,
  pageId: string, automationId: string, action: "update" | "pause" | "resume",
  body: Record<string, unknown>): Promise<AutomationRecord> {
  const { page, userId, current } = await target(env, authUser, spaceId, pageId, automationId);
  const version = expectedVersionOf(body, current);
  if (!current.capabilities[action]) {
    refuse(409, current.detachedAt ? "automation_detached" : "forbidden", current.detachedAt
      ? "Its reference is not on the page; put the reference back to resume it"
      : `This Automation cannot ${action} now`);
  }
  const parsed = expressionPayload(hubBoundary, current, action === "update" ? authoring(body) : {});
  const binding = automationEvaluatorBinding(current);
  if (!parsed || !binding) invalidAuthoring();
  if (action === "update" && body.triggers !== undefined) {
    const triggers = await resolvedTriggers(env, spaceId, userId, body.triggers);
    if (triggers.length) parsed.payload.triggers = triggers;
    else delete parsed.payload.triggers;
  }
  if (action === "update" && binding.authorityRootUserId !== userId) {
    const replacementId = crypto.randomUUID();
    await command(env, request, `page-automation:${replacementId}:replace`, {
      actorUserId: userId, principal: { kind: "user", id: userId }, kind: "automation_put",
    // An Agent Run acts as its owner, but never with a Human admin's creation exception.
    viaAgentRun: Boolean(authUser.agentRun),
      automationId: replacementId, expectedVersion: 0, channelId: current.channelId, pageId,
      // It resumes when the page's reference points at it, as the original did.
      detached: current.enabled || Boolean(current.detachedAt), enabled: false, nextRunAt: current.nextRunAt,
      payload: commandPayload(hubBoundary, parsed, undefined, current.channelId, { kind: "user", id: userId }, userId,
        replacementId),
      automationAction: "update", replacesAutomation: { automationId: current.id, expectedVersion: version },
    });
    await editPageText(env, { ...page, spaceId }, authUser, current.channelId,
      (text) => replaceAutomationReference(text, current.id, replacementId));
    const replaced = await pageAutomation(env, spaceId, pageId, userId, replacementId);
    await notifyPageAutomations(env, spaceId);
    return replaced;
  }
  const retimed = action === "resume" || parsed.intervalMinutes !== current.intervalMinutes;
  await command(env, request, `page-automation:${current.id}:${action}:${version}`, {
    actorUserId: userId, principal: { kind: "user", id: userId }, kind: "automation_put",
    // An Agent Run acts as its owner, but never with a Human admin's creation exception.
    viaAgentRun: Boolean(authUser.agentRun), automationId: current.id,
    expectedVersion: version, channelId: current.channelId,
    nextRunAt: retimed ? new Date(Date.now() + parsed.intervalMinutes * 60_000).toISOString() : current.nextRunAt,
    enabled: action === "pause" ? false : action === "resume" ? true : current.enabled,
    payload: commandPayload(hubBoundary, parsed, current, current.channelId, binding.actor,
      binding.authorityRootUserId, current.id),
    automationAction: action,
  });
  const updated = await pageAutomation(env, spaceId, pageId, userId, current.id);
  await notifyPageAutomations(env, spaceId);
  return updated;
}

/** Deletes a page's Automation and takes its reference out of the page. */
export async function deletePageAutomation(env: Env, request: Request, authUser: AuthUser, spaceId: string,
  pageId: string, automationId: string, body: Record<string, unknown>): Promise<void> {
  const { page, userId, current } = await target(env, authUser, spaceId, pageId, automationId);
  const version = expectedVersionOf(body, current);
  await command(env, request, `page-automation:${current.id}:delete:${version}`, {
    actorUserId: userId, principal: { kind: "user", id: userId }, kind: "automation_remove",
    automationId: current.id, expectedVersion: version,
  });
  await editPageText(env, { ...page, spaceId }, authUser, current.channelId,
    (text) => removeAutomationReference(text, current.id));
  await notifyPageAutomations(env, spaceId);
}

/** Puts a detached Automation's reference back into a section, which resumes it. */
async function reattachPageAutomation(env: Env, authUser: AuthUser, spaceId: string, pageId: string,
  automationId: string, body: Record<string, unknown>): Promise<AutomationRecord> {
  const { page, userId, current } = await target(env, authUser, spaceId, pageId, automationId);
  await editPageText(env, { ...page, spaceId }, authUser, current.channelId, (text) =>
    insertAutomationReference(removeAutomationReference(text, current.id), blockOf(body), current.id,
      String(current.name || "Automation")));
  const attached = await pageAutomation(env, spaceId, pageId, userId, current.id);
  await notifyPageAutomations(env, spaceId);
  return attached;
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
    // Reading the page as the caller is the access check; the list is then read as its Human.
    await new PostgresPageRepository(database(c.env)).read({ requestId: crypto.randomUUID(), spaceId, pageId,
      principal: runPrincipalOf(authUser) });
    return { automations: await pageAutomations(c.env, spaceId, pageId, humanOf(authUser)) };
  }));
  app.post(base, (c) => run(c, async (authUser, body) => ({
    automation: await createPageAutomation(c.env, c.req.raw, authUser, ...ids(c), body) }), 201));
  app.patch(`${base}/:automationId`, (c) => run(c, async (authUser, body) => ({
    automation: await changePageAutomation(c.env, c.req.raw, authUser, ...ids(c), c.req.param("automationId")!,
      "update", body) })));
  for (const action of ["pause", "resume"] as const) {
    app.post(`${base}/:automationId/${action}`, (c) => run(c, async (authUser, body) => ({
      automation: await changePageAutomation(c.env, c.req.raw, authUser, ...ids(c), c.req.param("automationId")!,
        action, body) })));
  }
  app.post(`${base}/:automationId/reference`, (c) => run(c, async (authUser, body) => ({
    automation: await reattachPageAutomation(c.env, authUser, ...ids(c), c.req.param("automationId")!, body) })));
  app.delete(`${base}/:automationId`, (c) => run(c, async (authUser, body) => {
    const [spaceId, pageId] = ids(c);
    const automationId = c.req.param("automationId")!;
    const version = c.req.query("expectedVersion");
    await deletePageAutomation(c.env, c.req.raw, authUser, spaceId, pageId, automationId,
      version === undefined ? body : { ...body, expectedVersion: version });
    return { ok: true, automationId };
  }));
}
