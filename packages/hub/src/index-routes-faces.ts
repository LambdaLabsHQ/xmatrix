import type { Context, Hono } from "hono";
import { readAgentFaces, readUserFaces, userFacesOf } from "@xmatrix/db";
import { MAX_FACES_PER_READ, type FacesRead } from "@xmatrix/protocol";
import { authAuthority, authPostgresTransaction, requireAuthD1 } from "./auth-authority";
import { requireAuth } from "./index-shared";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "./postgres-message-database-policy";
import { authorityFailure } from "./run-principal";
import type { Env } from "./types";

const facesDatabaseOptions = {
  applicationName: "xmatrix-faces",
  connectTimeoutMs: POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS,
  statementTimeoutMs: 5_000,
  transactionTimeoutMs: 10_000,
  lockTimeoutMs: 2_000,
} as const;

/** Each person's picture, read where accounts are kept. */
async function accountFaces(env: Env, userIds: readonly string[]): Promise<FacesRead["users"]> {
  if (userIds.length === 0) return [];
  if (authAuthority(env) === "postgres") {
    return authPostgresTransaction(env, "faces.users", (tx) => readUserFaces(tx, userIds), { statement: "single_read" });
  }
  const { results } = await requireAuthD1(env).prepare(
    `SELECT "id", "image" FROM "user" WHERE "id" IN (${userIds.map(() => "?").join(",")})`,
  ).bind(...userIds).all<{ id: string; image: string | null }>();
  return userFacesOf(userIds, results);
}

/** The distinct ids named by a repeated query parameter. */
function ids(c: Context<{ Bindings: Env }>, name: string): string[] {
  return [...new Set((c.req.queries(name) ?? []).map((id) => id.trim()).filter((id) => id && id.length <= 300))];
}

/**
 * Faces read by id (protocol faces.ts): `GET /api/spaces/:spaceId/faces?user=<userId>&agent=<instanceId>…`
 * answers each person's picture and each Agent Instance's harness mark, for a member of the Space. The Web
 * keeps them in its face directory, so a page asks once for every face it draws.
 */
export function registerFaceRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/spaces/:spaceId/faces", async (c) => {
    try {
      const authUser = await requireAuth(c.req.raw, c.env);
      const users = ids(c, "user");
      const agents = ids(c, "agent");
      if (users.length + agents.length > MAX_FACES_PER_READ) {
        return c.json({ code: "faces_too_many", message: `At most ${MAX_FACES_PER_READ} faces are read at once` }, 400);
      }
      // The Space's members read faces in it: the Agents' read checks that the reader is one.
      const agentFaces = await readAgentFaces(createPostgresAuthorityDatabase(c.env, facesDatabaseOptions), {
        requestId: crypto.randomUUID(), spaceId: c.req.param("spaceId"), userId: authUser.id, instanceIds: agents,
      });
      const read: FacesRead = { users: await accountFaces(c.env, users), agents: agentFaces };
      return c.json(read, 200, { "cache-control": "private, no-store" });
    } catch (error) {
      return authorityFailure(c, error);
    }
  });
}
