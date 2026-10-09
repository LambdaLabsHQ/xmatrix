import { DurableObject } from "cloudflare:workers";
import { AppControlError, PostgresAppRepository } from "@xmatrix/db";

import { SubscribedSourcesIndex } from "./github-subscribed-sources";
import { createPostgresAuthorityFleet, type PostgresAuthorityFleetEnv } from "./postgres-authority-fleet";
import type { Env } from "./types";

type IndexEnv = { GITHUB_SUBSCRIPTION_INDEX?: DurableObjectNamespace<GitHubSubscriptionIndex> };

/**
 * One GitHub App installation's subscribed sources: the repositories and
 * issues some relation of a GitHub connection linked to it subscribes to, and
 * for which features. It answers whether a delivery could have a route at all,
 * so a delivery nobody subscribed to (most CI events) never reaches
 * PostgreSQL. It is a superset of the routes: it ignores a connection's status
 * and a subscriber's current access, which only ever take routes away. So its
 * "no" is exact as long as every write that adds a relation, a feature or an
 * installation link makes it read again (`forget`) before that write answers.
 */
export class GitHubSubscriptionIndex extends DurableObject<Env> {
  private readonly index = new SubscribedSourcesIndex(this.ctx.storage, (installationId, limit) =>
    new PostgresAppRepository(directory(this.env)).githubSubscribedSources({
      requestId: `github-subscription-index:${crypto.randomUUID()}`, installationId, limit }));

  mayRoute(installationId: string, sourceRefs: readonly string[], feature: string): Promise<boolean> {
    return this.index.mayRoute(installationId, sourceRefs, feature);
  }

  forget(): Promise<void> {
    return this.index.forget();
  }
}

function directory(env: PostgresAuthorityFleetEnv) {
  return createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-github-subscription-index",
    statementTimeoutMs: 5_000,
    transactionTimeoutMs: 10_000,
    lockTimeoutMs: 2_000,
  }).directoryDatabase;
}

/** Whether a delivery could have a route; yes whenever the index cannot say. */
export async function githubDeliveryMayRoute(env: IndexEnv, installationId: string,
  sourceRefs: readonly string[], feature: string): Promise<boolean> {
  const namespace = env.GITHUB_SUBSCRIPTION_INDEX;
  if (!namespace) return true;
  try {
    return await namespace.get(namespace.idFromName(installationId)).mayRoute(installationId, sourceRefs, feature);
  } catch (error) {
    console.warn("GitHub subscription index unavailable; reading routes", {
      errorCode: error instanceof Error ? error.name : "unknown",
    });
    return true;
  }
}

/**
 * Tells each installation's index that its subscriptions may have widened. A
 * write answers only after every index heard; otherwise it fails retryable,
 * and its idempotent retry tells them again.
 */
export async function forgetGitHubSubscriptions(env: IndexEnv, installationIds: readonly string[] | undefined):
  Promise<void> {
  const namespace = env.GITHUB_SUBSCRIPTION_INDEX;
  if (!namespace || !installationIds?.length) return;
  try {
    await Promise.all(installationIds.map((id) => namespace.get(namespace.idFromName(id)).forget()));
  } catch {
    throw new AppControlError("github_subscription_index_unavailable", 503,
      "GitHub subscriptions are briefly unavailable; try again", true);
  }
}
