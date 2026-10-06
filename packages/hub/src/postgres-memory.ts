import {
  PostgresAssistantMemoryRepository,
  PostgresSharedMemoryRepository,
  type AuthorityDatabase,
} from "@xmatrix/db";

import { postgresAuthorityDatabase, type PostgresAuthorityBindingEnv } from "./postgres-authority-http";

/** Each user's key/value Shared Memory, on the directory shard. */
export function sharedMemoryRepository(
  env: PostgresAuthorityBindingEnv,
  database?: AuthorityDatabase,
): PostgresSharedMemoryRepository {
  return new PostgresSharedMemoryRepository(
    postgresAuthorityDatabase(env, "Shared Memory", "xmatrix-hub-shared-memory", database),
  );
}

/** Each user's Assistant Memory snapshot, on the directory shard. */
export function assistantMemoryRepository(
  env: PostgresAuthorityBindingEnv,
  database?: AuthorityDatabase,
): PostgresAssistantMemoryRepository {
  return new PostgresAssistantMemoryRepository(
    postgresAuthorityDatabase(env, "Assistant Memory", "xmatrix-hub-assistant-memory", database),
  );
}
