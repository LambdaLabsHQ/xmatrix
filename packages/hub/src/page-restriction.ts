import { PostgresPageRepository } from "@xmatrix/db";
import { createPostgresAuthorityDatabase } from "./postgres-authority-fleet";
import type { Env } from "./types";

/** A page restricted itself or through an ancestor keeps the conversations that work for it closed. */
export async function effectivelyRestricted(env: Env, spaceId: string, pageId: string, userId: string): Promise<boolean> {
  const repository = new PostgresPageRepository(createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-page-automations", statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000, lockTimeoutMs: 2_000,
  }));
  const { pages: tree } = await repository.tree({ requestId: crypto.randomUUID(),
    spaceId, principal: { kind: "user", id: userId } });
  const byId = new Map(tree.map((page) => [page.pageId, page]));
  for (let page = byId.get(pageId), depth = 0; page && depth < 64; page = page.parentPageId
    ? byId.get(page.parentPageId) : undefined, depth++) {
    if (page.accessMode === "restricted") return true;
  }
  return false;
}
