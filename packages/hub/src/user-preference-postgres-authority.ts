import {
  ControlError,
  DatabaseContractError,
  PostgresSpacePlacementDirectory,
  PostgresUserPreferenceRepository,
  type DatabaseRequestContext,
  type AuthorityDatabase,
  type SpacePlacement,
} from "@xmatrix/db";

import {
  createPostgresAuthorityDatabase,
  type PostgresAuthorityFleetEnv,
} from "./postgres-authority-fleet";

interface UserPreferencePostgresEnv extends PostgresAuthorityFleetEnv {
  RELAY_POSTGRES?: { connectionString: string };
  RELAY_POSTGRES_SHARD_ID?: string;
}

export function userPreferenceDatabaseContext(
  requestId: string,
  operation: string,
  value: SpacePlacement,
): DatabaseRequestContext {
  if (value.state !== "active" || value.targetShardId !== null) {
    throw new Error(`Space placement is ${value.state}; user preference access is fenced`);
  }
  return Object.freeze({
    requestId,
    operation,
    placement: Object.freeze({
      spaceId: value.spaceId,
      shardId: value.shardId,
      placementEpoch: value.placementEpoch,
    }),
  });
}

export async function postgresUserPreferenceAccess(
  env: UserPreferencePostgresEnv,
  input: { requestId: string; operation: string; spaceId: string },
  dependencies: { database?: AuthorityDatabase } = {},
): Promise<{
  repository: PostgresUserPreferenceRepository;
  context: DatabaseRequestContext;
  close: () => Promise<void>;
}> {
  const database = dependencies.database ?? createPostgresAuthorityDatabase(env, {
    applicationName: "xmatrix-hub-user-preference",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  });
  const session = database.openSession();
  try {
    const directory = new PostgresSpacePlacementDirectory(session);
    const placement = await directory.resolve({
      requestId: input.requestId,
      operation: "space-placement.resolve",
    }, input.spaceId);
    return {
      repository: new PostgresUserPreferenceRepository(session),
      context: userPreferenceDatabaseContext(
        input.requestId,
        input.operation,
        placement,
      ),
      close: () => session.close(),
    };
  } catch (error) {
    await session.close();
    throw error;
  }
}

/** One preference operation on the Space's active placement; an invalid value is the caller's error. */
async function withUserPreferences<T>(env: UserPreferencePostgresEnv, input: { requestId: string; operation: string;
  spaceId: string }, work: (repository: PostgresUserPreferenceRepository, context: DatabaseRequestContext) => Promise<T>,
  dependencies: { database?: AuthorityDatabase } = {}): Promise<T> {
  const access = await postgresUserPreferenceAccess(env, input, dependencies);
  try {
    return await work(access.repository, access.context);
  } catch (error) {
    if (error instanceof DatabaseContractError) throw new ControlError("invalid_user_preference", 400, error.message);
    throw error;
  } finally {
    await access.close();
  }
}

type LocaleUpdate = Omit<Parameters<PostgresUserPreferenceRepository["updateLocale"]>[1], "spaceId" | "userId">;
type ChannelViewUpdate = Omit<Parameters<PostgresUserPreferenceRepository["updateChannelView"]>[1], "spaceId" | "userId">;

/** A user's display and editing locale in one Space. */
export function readLocalePreference(env: UserPreferencePostgresEnv, input: { spaceId: string; userId: string },
  dependencies: { database?: AuthorityDatabase } = {}) {
  return withUserPreferences(env, { requestId: crypto.randomUUID(), operation: "user-preference.read",
    spaceId: input.spaceId }, (repository, context) => repository.readLocale(context, input.spaceId, input.userId),
  dependencies);
}

/** A user's Channel list view in one Space: follow-up schedule and pinned Channels. */
export function readChannelViewPreference(env: UserPreferencePostgresEnv, input: { spaceId: string; userId: string },
  dependencies: { database?: AuthorityDatabase } = {}) {
  return withUserPreferences(env, { requestId: crypto.randomUUID(), operation: "user-preference.read",
    spaceId: input.spaceId }, (repository, context) => repository.readChannelView(context, input.spaceId, input.userId),
  dependencies);
}

/** Changes a user's locale preference at the version they read, then reads it back. */
export function updateLocalePreference(env: UserPreferencePostgresEnv,
  input: { spaceId: string; userId: string; update: LocaleUpdate },
  dependencies: { database?: AuthorityDatabase } = {}) {
  return withUserPreferences(env, { requestId: input.update.commandId, operation: "user-preference.update",
    spaceId: input.spaceId }, async (repository, context) => {
    const written = await repository.updateLocale(context, { ...input.update, spaceId: input.spaceId, userId: input.userId });
    return { ...await repository.readLocale(context, input.spaceId, input.userId), reused: written.reused };
  }, dependencies);
}

/** Changes a user's Channel list view at the version they read, then reads it back. */
export function updateChannelViewPreference(env: UserPreferencePostgresEnv,
  input: { spaceId: string; userId: string; update: ChannelViewUpdate },
  dependencies: { database?: AuthorityDatabase } = {}) {
  return withUserPreferences(env, { requestId: input.update.commandId, operation: "user-preference.update",
    spaceId: input.spaceId }, async (repository, context) => {
    const written = await repository.updateChannelView(context, { ...input.update, spaceId: input.spaceId, userId: input.userId });
    return { ...await repository.readChannelView(context, input.spaceId, input.userId), reused: written.reused };
  }, dependencies);
}
