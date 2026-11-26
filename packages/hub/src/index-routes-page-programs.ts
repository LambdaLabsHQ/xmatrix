import { PageControlError, PostgresPageRepository } from "@xmatrix/db";
import type { Hono } from "hono";
import { requireAuth, requestErrorStatus } from "./index-shared";
import { adoptPageProgramLibraries, pageProgramPreview, pageProgramStatus } from "./norn-page-programs";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { runPrincipalOf } from "./run-principal";
import type { Env } from "./types";

/**
 * A page's programs are its `norn run` blocks (docs/architecture/norn-host.md).
 * Whoever can read the page reads how each one stands.
 */

/** A page request's failure as its response; a repository's typed refusal by its status and code. */
export function pageRequestFailure(error: unknown): Response {
  const { status, code, detail } = error as { status?: unknown; code?: unknown; detail?: unknown };
  if (typeof status === "number" && status >= 400 && status < 500 && typeof code === "string") {
    return Response.json({ error: (error as Error).message, code, ...(detail ? { detail } : {}) }, { status });
  }
  return Response.json({ error: (error as Error).message }, { status: requestErrorStatus(error) });
}

async function readAuthorizedPage(c: { req: { raw: Request; param: (k: string) => string | undefined }; env: Env }) {
  const authUser = await requireAuth(c.req.raw, c.env);
  const spaceId = c.req.param("spaceId")!, pageId = c.req.param("pageId")!;
  const principal = runPrincipalOf(authUser);
  const pages = new PostgresPageRepository(createPostgresAuthorityDatabase(c.env, {
    applicationName: "xmatrix-page-automations", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
  const { page } = await pages.read({ requestId: crypto.randomUUID(), spaceId, pageId, principal });
  return { authUser, principal, spaceId, pageId, page };
}

export function registerPageProgramRoutes(app: Hono<{ Bindings: Env }>): void {
  // How each `norn run` block of the page stands. Reading the page as the caller is the access check.
  app.get("/api/spaces/:spaceId/pages/:pageId/programs", (c) => (async () => {
    const { principal, spaceId, pageId, page } = await readAuthorizedPage(c);
    return c.json({ programs: await pageProgramStatus(c.env, { spaceId, pageId, body: page.body, principal }) }, 200,
      { "cache-control": "no-store" });
  })().catch(pageRequestFailure));

  // Read-only preview of a proposed Page edit and v1-to-v2 ledger migration readiness.
  app.post("/api/spaces/:spaceId/pages/:pageId/programs/preview", (c) => (async () => {
    const { principal, spaceId, pageId, page } = await readAuthorizedPage(c);
    const payload = await c.req.json().catch(() => ({})) as { body?: unknown };
    const proposedBody = typeof payload?.body === "string" ? payload.body : undefined;
    const previews = await pageProgramPreview(c.env, { spaceId, pageId, currentBody: page.body, proposedBody, principal });
    return c.json({ previews }, 200, { "cache-control": "no-store" });
  })().catch(pageRequestFailure));

  // Explicitly adopts updated Space libraries (`norn 1 lib`) into running programs on this Page.
  app.post("/api/spaces/:spaceId/pages/:pageId/programs/adopt", (c) => (async () => {
    const { authUser, spaceId, pageId, page } = await readAuthorizedPage(c);
    if (!page.canEdit) throw new PageControlError("page_edit_forbidden", 403);
    const payload = await c.req.json().catch(() => ({})) as { names?: unknown };
    const names = Array.isArray(payload?.names)
      ? payload.names.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : undefined;
    const userId = authUser.agentRun?.ownerUserId ?? authUser.id;
    const result = await adoptPageProgramLibraries(c.env, { spaceId, pageId, userId, ...(names?.length ? { names } : {}) });
    return c.json(result, 200, { "cache-control": "no-store" });
  })().catch(pageRequestFailure));
}
