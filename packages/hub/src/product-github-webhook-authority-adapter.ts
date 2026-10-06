import { plainRecord } from "@xmatrix/protocol";
import { resolveGitHubSubscriptionRoutes } from "./github-subscription-route-directory";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";
import { listAppConnections } from "./apps";
import {
  githubFeatureForWebhookEvent,
  githubWebhookRepositoryIdentity,
  githubWebhookMessageBody,
  type GitHubRepositoryFeature,
} from "./github-subscription-domain";

function record(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

function subscriptionAllows(
  connection: Record<string, unknown>,
  channelId: string,
  sourceRef: string,
  feature: GitHubRepositoryFeature,
): boolean {
  if (connection.id === undefined || connection.status !== "configured") return false;
  const channelState = record(connection.channelState);
  if (channelState.channelId !== channelId || channelState.bound !== true) {
    return false;
  }
  const subscriptions = Array.isArray(channelState.subscriptions) ? channelState.subscriptions : [];
  return subscriptions.some((value) => {
    const subscription = record(value);
    return subscription.kind === "repository" && subscription.source === sourceRef &&
      Array.isArray(subscription.features) && subscription.features.includes(feature);
  });
}

export async function dispatchProductGitHubWebhook(input: {
  env: Env;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
}): Promise<{ ok: true; delivered: number }> {
  const installationValue = record(input.payload.installation).id;
  const installationId = typeof installationValue === "string"
    ? installationValue.trim()
    : typeof installationValue === "number" ? String(installationValue) : "";
  const repository = githubWebhookRepositoryIdentity(input.payload);
  const feature = githubFeatureForWebhookEvent(input.event, input.payload);
  if (!installationId || !repository || !feature) return { ok: true, delivered: 0 };
  const routes = await resolveGitHubSubscriptionRoutes(input.env, installationId, repository.sourceRef);
  const body = githubWebhookMessageBody(input.event, input.payload, repository);
  let delivered = 0;
  for (let offset = 0; offset < routes.length; offset += 8) {
    const batch = routes.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async (route): Promise<number> => {
      const principal = { kind: "user" as const, id: route.authorityRootUserId };
      const listed = await listAppConnections(input.env, { spaceId: route.spaceId, channelId: route.channelId,
        actorUserId: route.authorityRootUserId }).catch(() => null);
      if (!listed) return 0;
      const connection = listed.map(record).find((candidate) => candidate.id === route.connectionId);
      if (!connection || !subscriptionAllows(connection, route.channelId, repository.sourceRef, feature)) return 0;
      const appAuthorId = typeof connection.providerId === "string" ? connection.providerId : "";
      if (!appAuthorId) return 0;
      const messageId = `app:github:${input.delivery}:${route.channelId}`.slice(0, 200);
      const response = await dispatchProductMessageAppend(input.env, route.channelId, {
        commandId: `product:github-webhook:${input.delivery}:${route.channelId}`.slice(0, 200),
        messageId,
        channelId: route.channelId,
        body,
        principal,
        appAuthorId,
      });
      return response.ok ? 1 : 0;
    }));
    delivered += results.reduce((sum, value) => sum + value, 0);
  }
  return { ok: true, delivered };
}
