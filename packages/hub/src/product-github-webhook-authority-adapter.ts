import { plainRecord } from "@xmatrix/protocol";
import { githubCommitCheckVerdict, type GitHubCommitCheckVerdict } from "./app-connectors";
import { resolveGitHubSubscriptionRoutes } from "./github-subscription-route-directory";
import {
  githubIssueSourceRef,
  githubIssueSubscriptionCurrent,
  githubPullRequestClosed,
  githubPullRequestEventMessage,
  githubSettledCheckSuiteSha,
  githubWebhookIssueNumbers,
} from "./github-pull-request-subscription";
import { wakeRestingInstances } from "./registration-launch-dispatch";
import { dispatchProductMessageAppend } from "./product-message-append";
import type { Env } from "./types";
import { appCommand } from "./apps";
import {
  channelExposureReader,
  githubContentAllowedInChannel,
  type ChannelExposureReader,
} from "./github-channel-exposure";
import {
  githubFeatureForWebhookEvent,
  githubRepositoryIsPublic,
  githubWebhookRepositoryIdentity,
  githubWebhookMessageBody,
} from "./github-subscription-domain";

function record(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

export interface ProductGitHubWebhookDependencies {
  resolveRoutes: typeof resolveGitHubSubscriptionRoutes;
  append: typeof dispatchProductMessageAppend;
  exposure: ChannelExposureReader;
  checkVerdict: typeof githubCommitCheckVerdict;
  wake: typeof wakeRestingInstances;
  command: typeof appCommand;
}

/**
 * Route one GitHub delivery to the Channels subscribed to its repository or to
 * the issue or pull request it is about. A repository subscription posts every
 * event of its features; a pull request's subscription posts what its opener
 * needs to hear (githubPullRequestEventMessage) and ends when it closes. Like
 * any message a live Instance would receive, a post wakes the Channel's
 * resting Instances (docs/instance-sleep.md §3).
 */
export async function dispatchProductGitHubWebhook(input: {
  env: Env;
  event: string;
  delivery: string;
  payload: Record<string, unknown>;
}, dependencies: Partial<ProductGitHubWebhookDependencies> = {}): Promise<{ ok: true; delivered: number }> {
  const resolveRoutes = dependencies.resolveRoutes ?? resolveGitHubSubscriptionRoutes;
  const append = dependencies.append ?? dispatchProductMessageAppend;
  const exposure = dependencies.exposure ?? channelExposureReader(input.env);
  const checkVerdict = dependencies.checkVerdict ?? githubCommitCheckVerdict;
  const wake = dependencies.wake ?? wakeRestingInstances;
  const command = dependencies.command ?? appCommand;
  const installationValue = record(input.payload.installation).id;
  const installationId = typeof installationValue === "string"
    ? installationValue.trim()
    : typeof installationValue === "number" ? String(installationValue) : "";
  const repository = githubWebhookRepositoryIdentity(input.payload);
  const feature = githubFeatureForWebhookEvent(input.event, input.payload);
  if (!installationId || !repository || !feature) return { ok: true, delivered: 0 };
  /* A private repository's events reach only Channels people outside the
     Space cannot read; unstated privacy counts as private. */
  const repositoryPublic = githubRepositoryIsPublic(input.payload.repository);
  const repositoryName = `${repository.owner}/${repository.repo}`;
  const issues = new Map(githubWebhookIssueNumbers(input.event, input.payload)
    .map((number) => [githubIssueSourceRef(repositoryName, number), number]));
  const routes = await resolveRoutes(input.env, installationId, [repository.sourceRef, ...issues.keys()], feature);
  const repositoryBody = githubWebhookMessageBody(input.event, input.payload, repository);
  /* Each pull request must still have this head; share reads across its routes. */
  const settledSha = githubSettledCheckSuiteSha(input.event, input.payload);
  const verdicts = new Map<number, Promise<GitHubCommitCheckVerdict | undefined>>();
  const closed = githubPullRequestClosed(input.event, input.payload);
  let delivered = 0;
  for (let offset = 0; offset < routes.length; offset += 8) {
    const batch = routes.slice(offset, offset + 8);
    const results = await Promise.all(batch.map(async (route): Promise<number> => {
      const principal = { kind: "user" as const, id: route.authorityRootUserId };
      const number = route.sourceKind === "issue" ? issues.get(route.sourceRef) : undefined;
      if (route.sourceKind === "issue" &&
          (number === undefined || !githubIssueSubscriptionCurrent(input.event, input.payload, route.createdAt))) return 0;
      if (settledSha && number !== undefined && !verdicts.has(number)) {
        verdicts.set(number, checkVerdict(input.env, installationId, repository.owner, repository.repo, settledSha, number)
          .catch((error: unknown) => {
            console.error("GitHub check verdict failed", { delivery: input.delivery,
              error: error instanceof Error ? error.message : String(error) });
            return undefined;
          }));
      }
      const verdict = number === undefined ? undefined : await verdicts.get(number);
      const body = number === undefined ? repositoryBody : githubPullRequestEventMessage({
        event: input.event, payload: input.payload, repository, number,
        ...(verdict ? { verdict } : {}) });
      /* A closed pull request ends its subscription, said or not. */
      const end = number !== undefined && closed
        ? () => command(input.env, "remove-relation", {
          commandId: `product:github-pull-request:${input.delivery}:${route.channelId}:remove`.slice(0, 200),
          relationId: route.relationId, principal,
        }).catch((error: unknown) => {
          console.error("Pull request subscription end failed", { channelId: route.channelId,
            error: error instanceof Error ? error.message : String(error) });
        })
        : undefined;
      try {
        if (!body) return 0;
        if (!await githubContentAllowedInChannel(exposure, { repositoryPublic, channelId: route.channelId,
          userId: route.authorityRootUserId })) return 0;
        /* A verdict is one message per settling, whichever suite's delivery reports it. */
        const key = number !== undefined && verdict && verdict.state !== "pending"
          ? `ci:${settledSha}:${number}:${verdict.settledAt}`
          : input.delivery;
        const messageId = `app:github:${key}:${route.channelId}`.slice(0, 200);
        const response = await append(input.env, route.channelId, {
          commandId: `product:github-webhook:${key}:${route.channelId}`.slice(0, 200),
          messageId,
          channelId: route.channelId,
          body,
          principal,
          appAuthorId: "github",
        });
        if (!response.ok) return 0;
        await wake(input.env, { commandId: `resting-wake:${messageId}`.slice(0, 200), channelId: route.channelId,
          sourceMessageId: messageId, prompt: body }).catch((error: unknown) => {
          console.error("Resting Instance wake failed", { channelId: route.channelId, messageId,
            error: error instanceof Error ? error.message : String(error) });
        });
        return 1;
      } finally {
        await end?.();
      }
    }));
    delivered += results.reduce((sum, value) => sum + value, 0);
  }
  return { ok: true, delivered };
}
