import { utf8ByteLength } from "@xmatrix/protocol";
import { AppControlError, PostgresAppRepository, type AuthorityDatabase } from "@xmatrix/db";

import { getAppConnectorProvider, type AppConnectorConnectionView } from "./app-connectors";
import { forgetGitHubSubscriptions, type GitHubSubscriptionIndex } from "./github-subscription-index";
import { postgresAuthorityDatabase, type PostgresAuthorityBindingEnv } from "./postgres-authority-http";

type SubscriptionIndexEnv = PostgresAuthorityBindingEnv & {
  GITHUB_SUBSCRIPTION_INDEX?: DurableObjectNamespace<GitHubSubscriptionIndex>;
};

/** A write that may have widened GitHub subscriptions answers once their indexes forgot them. */
async function afterGitHubSubscriptionWrite<T extends object>(env: SubscriptionIndexEnv, result: T): Promise<T> {
  const { githubInstallations, ...answer } = result as T & { githubInstallations?: string[] };
  await forgetGitHubSubscriptions(env, githubInstallations);
  return (githubInstallations ? answer : result) as T;
}

/** App connections, their source relations and executions live on the directory shard. */
export function appRepository(env: PostgresAuthorityBindingEnv, database?: AuthorityDatabase): PostgresAppRepository {
  return new PostgresAppRepository(postgresAuthorityDatabase(env, "Agent/App policy",
    "xmatrix-hub-agent-app-policy", database));
}

/** Connects or reconfigures one of a Space's apps under its provider's own policy. */
export async function upsertAppConnection(env: SubscriptionIndexEnv, input: {
  commandId: string; spaceId: string; actorUserId: string; providerId: string; body: Record<string, unknown>;
}) {
  const provider = getAppConnectorProvider(input.providerId.trim().toLowerCase());
  if (!provider) throw new AppControlError("invalid_app_request", 400, "Unsupported app connector provider");
  if (utf8ByteLength(JSON.stringify(input.body)) > 64 * 1024) {
    throw new AppControlError("invalid_app_request", 400, "body is too large");
  }
  return afterGitHubSubscriptionWrite(env, await appRepository(env).upsert({ commandId: input.commandId,
    spaceId: input.spaceId, actorUserId: input.actorUserId,
    provider: { id: provider.id, name: provider.name, authMode: provider.auth.type,
      scopes: provider.auth.scopes, secretRefs: provider.auth.secretRefs,
      capabilities: (provider.auth.capabilities ?? []).map((capability) => ({
        id: capability.id, scopes: capability.scopes,
      })), metadataFields: (provider.connectionMetadata ?? []).map((field) => field.id) },
    body: input.body, at: new Date().toISOString() }));
}

type AppCommandKind = Parameters<PostgresAppRepository["command"]>[1];

/**
 * One idempotent App command — deleting or checking a connection, putting or
 * removing a source relation, recording or finishing an execution — by the
 * principal it names.
 */
export async function appCommand(env: SubscriptionIndexEnv, kind: AppCommandKind, input: Record<string, unknown>) {
  return afterGitHubSubscriptionWrite(env, await appRepository(env).command({ ...input, at: new Date().toISOString() },
    kind));
}

/** One of a Space's app connections, as a user who may see it reads it. */
export function getAppConnection(env: PostgresAuthorityBindingEnv, input: { connectionId: string; actorUserId: string; allowMissing?: boolean }) {
  return appRepository(env).getConnection({ requestId: crypto.randomUUID(), ...input });
}

/**
 * A Space's connection to one provider as a user reads it, or null when there
 * is none they may see: callers treat that the same as not connected.
 */
export async function findAppConnection(env: PostgresAuthorityBindingEnv, input: {
  spaceId: string; providerId: string; actorUserId: string;
}): Promise<AppConnectorConnectionView | null> {
  try {
    const { connection } = await getAppConnection(env, { connectionId: `${input.spaceId}:${input.providerId}`,
      actorUserId: input.actorUserId });
    return connection as unknown as AppConnectorConnectionView | null;
  } catch {
    return null;
  }
}

/** Every app connection of a Space a user may see, following the cursor. */
export async function listAppConnections(env: PostgresAuthorityBindingEnv, input: {
  spaceId: string; actorUserId: string; channelId?: string;
}): Promise<Record<string, unknown>[]> {
  const repository = appRepository(env);
  const connections: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listConnections({ requestId: crypto.randomUUID(), ...input, cursor, limit: 200 });
    connections.push(...page.connections);
    cursor = page.cursor;
  } while (cursor);
  return connections;
}

/** Every app source relation of a Channel its principal may see, following the cursor. */
export async function listAppSourceRelations(env: PostgresAuthorityBindingEnv, input: {
  channelId: string; principal: { kind: "user" | "agent"; id: string };
}): Promise<Record<string, unknown>[]> {
  const repository = appRepository(env);
  const relations: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listRelations({ requestId: crypto.randomUUID(), ...input, cursor, limit: 200 });
    relations.push(...page.relations);
    cursor = page.cursor;
  } while (cursor);
  return relations;
}

/** Every app execution of a Space a user may see, following the cursor. */
export async function listAppExecutions(env: PostgresAuthorityBindingEnv, input: {
  spaceId: string; actorUserId: string;
}): Promise<Record<string, unknown>[]> {
  const repository = appRepository(env);
  const executions: Record<string, unknown>[] = [];
  let cursor: string | null = null;
  do {
    const page = await repository.listExecutions({ requestId: crypto.randomUUID(), ...input, cursor, limit: 200 });
    executions.push(...page.executions);
    cursor = page.cursor;
  } while (cursor);
  return executions;
}
