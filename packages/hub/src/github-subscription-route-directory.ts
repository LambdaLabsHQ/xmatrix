import { PostgresAppRepository } from "@xmatrix/db";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";

export interface GitHubSubscriptionRoute {
  installationId: string;
  sourceRef: string;
  spaceId: string;
  channelId: string;
  connectionId: string;
  authorityRootUserId: string;
}

type DirectoryEnv = Pick<
  PostgresAuthorityFleetEnv,
  "RELAY_POSTGRES" | "RELAY_POSTGRES_SHARD_ID" |
  "RELAY_POSTGRES_SHARD_1" | "RELAY_POSTGRES_SHARD_1_ID" |
  "RELAY_POSTGRES_SHARD_2" | "RELAY_POSTGRES_SHARD_2_ID" |
  "RELAY_POSTGRES_SHARD_3" | "RELAY_POSTGRES_SHARD_3_ID" |
  "RELAY_POSTGRES_SHARD_4" | "RELAY_POSTGRES_SHARD_4_ID"
>;

export async function resolveGitHubSubscriptionRoutes(
  env: DirectoryEnv,
  installationId: string,
  sourceRef: string,
  feature: string,
): Promise<GitHubSubscriptionRoute[]> {
  const fleet = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-github-subscription-directory",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  });
  const partitions = await Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    new PostgresAppRepository(database).githubSubscriptionRoutes({
      requestId: `github-routes:${shardId}:${crypto.randomUUID()}`.slice(0, 200),
      installationId, sourceRef, feature, limit: 1_001,
    })));
  const routes = partitions.flat().sort((left, right) =>
    [left.channelId, left.spaceId, left.connectionId].join("\u001f").localeCompare(
      [right.channelId, right.spaceId, right.connectionId].join("\u001f"),
    ));
  if (routes.length > 1_000) throw new Error(
    "GitHub subscription route result exceeds 1,000 entries");
  return routes;
}
