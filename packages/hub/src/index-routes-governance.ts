import { PostgresGovernanceRepository } from "@xmatrix/db";
import type { Context, Hono } from "hono";
import { authHasGitHubAccount } from "./auth-authority";
import { productCommandId, requireAuth, requireHumanAuth } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { authorityFailure } from "./run-principal";
import { changeMembership } from "./spaces";
import { jsonBody, NO_STORE } from "./route-json";
import type { Env } from "./types";

/**
 * How an open project is run (docs/design/open-project-governance.md): its
 * owners open it and name its governance page; anyone with a linked GitHub
 * account joins it as a participant.
 */
function repository(env: Env): PostgresGovernanceRepository {
  return new PostgresGovernanceRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-governance", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
}

async function governanceResponse(c: Context<{ Bindings: Env }>,
  work: () => ReturnType<PostgresGovernanceRepository["read"]>): Promise<Response> {
  try {
    const governance = await work();
    return c.json({ openParticipation: governance.openParticipation, governancePageId: governance.governancePageId },
      200, NO_STORE);
  } catch (error) {
    return authorityFailure(c, error);
  }
}

export function registerGovernanceRoutes(app: Hono<{ Bindings: Env }>): void {
  const path = "/api/spaces/:spaceId/governance";

  // Public: an open project says so on its public pages.
  app.get(path, async (c) => governanceResponse(c, () =>
    repository(c.env).read({ requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId") })));

  app.put(path, async (c) => governanceResponse(c, async () => {
    const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
    const input = await jsonBody(c);
    return repository(c.env).update({ requestId: crypto.randomUUID(),
      spaceId: c.req.param("spaceId"), userId: user.id,
      ...(typeof input.openParticipation === "boolean" ? { openParticipation: input.openParticipation } : {}),
      ...(typeof input.governancePageId === "string" || input.governancePageId === null
        ? { governancePageId: input.governancePageId as string | null } : {}) });
  }));

  // Joining an open project: its owners consented by opening it, so the
  // membership is recorded as theirs to have granted.
  app.post(`${path}/participation`, async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const spaceId = c.req.param("spaceId");
      const governance = await repository(c.env).read({ requestId: crypto.randomUUID(), spaceId });
      const role = await repository(c.env).roleOf({ requestId: crypto.randomUUID(), spaceId, userId: user.id });
      if (role) return c.json({ role }, 200, NO_STORE);
      if (!governance.openParticipation) {
        return c.json({ error: "This project is not open to join", code: "space_not_open" }, 403);
      }
      if (!await authHasGitHubAccount(c.env, user.id)) {
        return c.json({ error: "Link your GitHub account in your profile to join an open project",
          code: "github_account_required" }, 403);
      }
      await changeMembership(c.env, {
        commandId: productCommandId(c.req.raw, "domain", `space-participate:${spaceId}:${user.id}`),
        actorUserId: governance.ownerUserId, at: new Date().toISOString(), kind: "space_member_put",
        spaceId, userId: user.id, role: "participant", email: user.email, name: user.name,
      });
      return c.json({ role: "participant" }, 200, NO_STORE);
    } catch (error) {
      return authorityFailure(c, error);
    }
  });
}
