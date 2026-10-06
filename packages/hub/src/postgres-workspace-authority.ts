import { PostgresWorkspaceRepository, type AuthorityDatabase } from "@xmatrix/db";

import { postgresAuthorityDatabase, type PostgresAuthorityBindingEnv } from "./postgres-authority-http";

/** Registered directories live on the directory shard, keyed by their owner. */
export function workspaceRepository(
  env: PostgresAuthorityBindingEnv,
  database?: AuthorityDatabase,
): PostgresWorkspaceRepository {
  return new PostgresWorkspaceRepository(
    postgresAuthorityDatabase(env, "workspace", "xmatrix-hub-workspace", database),
  );
}

/** Every directory an owner registered, on one Machine when named, following the cursor. */
export async function listOwnerWorkspaces(
  repository: PostgresWorkspaceRepository,
  ownerUserId: string,
  machineId?: string,
): Promise<Record<string, unknown>[]> {
  const workspaces: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page = await repository.list({
      requestId: crypto.randomUUID(), ownerUserId, limit: 200, cursor,
      ...(machineId ? { machineId } : {}),
    });
    workspaces.push(...page.workspaces);
    cursor = page.cursor;
  } while (cursor);
  return workspaces;
}
