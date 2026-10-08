import assert from "node:assert/strict";
import test from "node:test";
import { getAppConnectorProvider } from "../src/app-connectors.ts";
import { actionRefusal } from "../src/connectors/connector-commands.ts";
import { channelMayCarryPrivateGitHubContent } from "../src/github-channel-exposure.ts";
import { preReviewConversationMode } from "../src/github-pre-review.ts";
import { githubRepositoryIsPublic } from "../src/github-subscription-domain.ts";
import { dispatchProductGitHubWebhook } from "../src/product-github-webhook-authority-adapter.ts";

function reader({ mode = "open", spaceId = "space-1", openParticipation = true, channelError, spaceError } = {}) {
  return {
    channel: async () => {
      if (channelError) throw new Error("channel read failed");
      return { id: "channel-1", spaceId, mode };
    },
    openParticipation: async () => {
      if (spaceError) throw new Error("governance read failed");
      return openParticipation;
    },
  };
}

test("a repository is public only when GitHub says so", () => {
  assert.equal(githubRepositoryIsPublic({ private: false, visibility: "public" }), true);
  assert.equal(githubRepositoryIsPublic({ private: false }), true);
  assert.equal(githubRepositoryIsPublic({ private: true }), false);
  assert.equal(githubRepositoryIsPublic({ private: false, visibility: "internal" }), false);
  assert.equal(githubRepositoryIsPublic({ private: false, visibility: "private" }), false);
  assert.equal(githubRepositoryIsPublic({ name: "repo" }), false, "unstated privacy is private");
  assert.equal(githubRepositoryIsPublic({ private: "false" }), false);
  assert.equal(githubRepositoryIsPublic(undefined), false);
});

test("private GitHub content reaches only Channels outside participants' reach", async () => {
  const input = { channelId: "channel-1", userId: "user-1" };
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ mode: "closed" }), input), true);
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ openParticipation: false }), input), true);
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ openParticipation: true }), input), false,
    "an open conversation of an open project is public");
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ spaceError: true }), input), false,
    "unknown participation fails closed");
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ channelError: true }), input), false,
    "an unreadable Channel fails closed");
  assert.equal(await channelMayCarryPrivateGitHubContent(reader({ mode: undefined }), input), false);
  assert.equal(await channelMayCarryPrivateGitHubContent(
    reader({ spaceId: "", openParticipation: false }), input), false);
});

test("a private repository's pre-review conversation is closed in a Space that may be public", async () => {
  const base = { spaceId: "space-1", restricted: false };
  assert.equal(await preReviewConversationMode(reader(), { ...base, repositoryPublic: false }), "closed");
  assert.equal(await preReviewConversationMode(reader({ spaceError: true }), { ...base, repositoryPublic: false }),
    "closed");
  assert.equal(await preReviewConversationMode(reader({ openParticipation: false }),
    { ...base, repositoryPublic: false }), "open");
  assert.equal(await preReviewConversationMode(reader(), { ...base, repositoryPublic: true }), "open");
  assert.equal(await preReviewConversationMode(reader({ openParticipation: false }),
    { ...base, restricted: true, repositoryPublic: true }), "closed");
});

test("a subscription is the Channel's policy to deny, without needing an Agent allow", () => {
  const subscribe = getAppConnectorProvider("github").actions.find((action) => action.id === "subscribe");
  assert.equal(subscribe.effect, "read");
  assert.match(actionRefusal({ providerId: "github", actionId: "subscribe", effect: subscribe.effect,
    mode: "deny", senderKind: "user" }) ?? "", /denied/u);
  assert.equal(actionRefusal({ providerId: "github", actionId: "subscribe", effect: subscribe.effect,
    mode: null, senderKind: "agent" }), undefined);
});

function webhookHarness(exposure) {
  const appended = [];
  const route = { installationId: "42", sourceRef: "github:repo:acme/app", sourceKind: "repository", spaceId: "space-1",
    channelId: "channel-1", connectionId: "connection-1", authorityRootUserId: "user-1" };
  return {
    appended,
    dependencies: {
      exposure,
      resolveRoutes: async () => [route],
      listConnections: async () => [{ id: "connection-1", providerId: "github", status: "configured",
        channelState: { channelId: "channel-1", bound: true, subscriptions: [
          { kind: "repository", source: "github:repo:acme/app", features: ["commits"] }] } }],
      append: async (_env, channelId, message) => {
        appended.push({ channelId, body: message.body });
        return { ok: true };
      },
    },
  };
}

function pushPayload(repository) {
  return {
    installation: { id: 42 },
    repository: { name: "app", owner: { login: "acme" }, ...repository },
    ref: "refs/heads/main",
    commits: [{ id: "abcdef1234567", message: "secret change" }],
  };
}

async function assertDeliveries(expected, cases) {
  for (const [label, repository, exposure] of cases) {
    const harness = webhookHarness(exposure);
    const result = await dispatchProductGitHubWebhook({ env: {}, event: "push", delivery: "d-1",
      payload: pushPayload(repository) }, harness.dependencies);
    assert.equal(result.delivered, expected, label);
    assert.equal(harness.appended.length, expected, label);
  }
}

test("a private repository's events are not delivered into a public Channel", () => assertDeliveries(0, [
  ["private repository, open project", { private: true }, reader()],
  ["privacy unstated", {}, reader()],
  ["participation unknown", { private: true }, reader({ spaceError: true })],
  ["Channel unreadable", { private: true }, reader({ channelError: true })],
]));

test("a repository's events still reach Channels that may carry them", () => assertDeliveries(1, [
  ["public repository, open project", { private: false, visibility: "public" }, reader()],
  ["private repository, closed Channel", { private: true }, reader({ mode: "closed" })],
  ["private repository, members-only Space", { private: true }, reader({ openParticipation: false })],
]));
