import { PostgresAppRepository } from "@xmatrix/db";
import { githubDeliveryMayRoute, type GitHubSubscriptionIndex } from "./github-subscription-index";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";

export interface GitHubSubscriptionRoute {
  relationId: string;
  installationId: string;
  sourceRef: string;
  sourceKind: "repository" | "issue";
  createdAt: string;
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
> & { GITHUB_SUBSCRIPTION_INDEX?: DurableObjectNamespace<GitHubSubscriptionIndex> };

/**
 * The Channels subscribed to one GitHub delivery's sources. App connections
 * and their source relations are written only to the directory shard (see
 * `appRepository`), so one directory read answers; the Space shards hold none
 * (2026-10-09: every delivery also asked each Space shard, an empty read).
 */
export async function resolveGitHubSubscriptionRoutes(
  env: DirectoryEnv,
  installationId: string,
  sourceRefs: string[],
  feature: string,
): Promise<GitHubSubscriptionRoute[]> {
  // A delivery none of whose sources anyone subscribed to has no route.
  if (!await githubDeliveryMayRoute(env, installationId, sourceRefs, feature)) return [];
  const directory = createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-github-subscription-directory",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  }).directoryDatabase;
  const routes = await new PostgresAppRepository(directory).githubSubscriptionRoutes({
    requestId: `github-routes:${crypto.randomUUID()}`.slice(0, 200),
    installationId, sourceRefs, feature, limit: 1_001,
  });
  if (routes.length > 1_000) throw new Error(
    "GitHub subscription route result exceeds 1,000 entries");
  return routes;
}
