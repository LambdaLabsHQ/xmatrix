import { PostgresPageMigrationRepository } from "@xmatrix/db";
import type { Hono } from "hono";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { requireAuth, requireHumanAuth } from "./index-shared";
import { authorityFailure, runPrincipalOf } from "./run-principal";
import { launchTargetRepos } from "./launch-target-repositories";
import { startPageImport } from "./page-import";
import { jsonBody, NO_STORE } from "./route-json";
import type { Env } from "./types";

/**
 * A Space's move to pages (docs/design/pages-and-conversations-migration.md §3):
 * an Agent Run of a Space owner or admin reads and submits a drafted page tree;
 * an owner or admin reviews it and drops or renames pages; they apply it, or a
 * Run of theirs does on an owner's or admin's message. Routes
 * only name the principal; authorization lives in the repository.
 */
function repository(env: Env): PostgresPageMigrationRepository {
  return new PostgresPageMigrationRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-migration", statementTimeoutMs: 20_000,
    transactionTimeoutMs: 60_000, lockTimeoutMs: 5_000,
  }));
}

function titles(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"));
}

export function registerPageMigrationRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = "/api/spaces/:spaceId/page-migration";

  app.get(path, async (c) => {
    try {
      return c.json(await repository(c.env).get({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
        principal: runPrincipalOf(await requireAuth(c.req.raw, c.env)) }), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });

  // Import onboarding: the Space's repositories to start from, and starting.
  // Both are an owner's or admin's, which reading the migration checks.
  app.get(`${path}/import/repositories`, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      await repository(c.env).get({ requestId: crypto.randomUUID(), spaceId, principal: runPrincipalOf(user) });
      return c.json(await launchTargetRepos(c.env, spaceId, user.id), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });

  app.post(`${path}/import`, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      const migration = await repository(c.env).get({ requestId: crypto.randomUUID(), spaceId,
        principal: runPrincipalOf(user) });
      if (migration.state === "applied") {
        return c.json({ error: "This Space already runs on pages", code: "page_migration_applied" }, 409);
      }
      const input = await jsonBody(c);
      return c.json(await startPageImport(c.env, { spaceId, userId: user.id,
        repository: typeof input.repository === "string" ? input.repository.trim() : "" }), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });

  app.put(`${path}/draft`, async (c) => {
    try {
      const principal = runPrincipalOf(await requireAuth(c.req.raw, c.env));
      const input = await jsonBody(c);
      return c.json(await repository(c.env).submit({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
        principal, version: Number(input.version), draft: input.draft }), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });

  app.patch(`${path}/draft`, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const input = await jsonBody(c);
      return c.json(await repository(c.env).revise({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
        principal: { kind: "user", id: user.id }, version: Number(input.version),
        drop: Array.isArray(input.drop) ? input.drop.filter((key): key is string => typeof key === "string") : [],
        titles: titles(input.titles) }), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });

  app.post(`${path}/apply`, async (c) => {
    try {
      const principal = runPrincipalOf(await requireAuth(c.req.raw, c.env));
      const input = await jsonBody(c);
      return c.json(await repository(c.env).apply({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"),
        principal, version: Number(input.version) }), 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });
}
