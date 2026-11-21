import assert from "node:assert/strict";
import test from "node:test";
import {
  githubDeliveryExcepted,
  githubSubscriptionExceptions,
  githubSubscriptionSelectionFromCommand,
  nextGitHubRepositoryFeatures,
} from "../src/github-subscription-domain.ts";
import { dispatchProductGitHubWebhook } from "../src/product-github-webhook-authority-adapter.ts";

test("a subscribe command names the accounts it leaves out beside its kinds of event", () => {
  assert.deepEqual(githubSubscriptionSelectionFromCommand("@github:subscribe:acme/app issues pulls except:Octocat"),
    { features: ["issues", "pulls"], exceptions: ["octocat"] });
  assert.deepEqual(githubSubscriptionSelectionFromCommand("@github:subscribe:acme/app except:@octocat, issues"),
    { features: ["issues"], exceptions: ["octocat"] });
  assert.deepEqual(githubSubscriptionSelectionFromCommand("@github:subscribe:acme/app pulls except:app-bot[bot]"),
    { features: ["pulls"], exceptions: ["app-bot[bot]"] });
  assert.deepEqual(githubSubscriptionSelectionFromCommand("@github:unsubscribe:acme/app except:octocat").features, [],
    "naming only an exception leaves the kinds alone");
  assert.deepEqual(githubSubscriptionSelectionFromCommand("@github:subscribe:acme/app pulls except:-bad please").exceptions, [],
    "an invalid login ends the selection like any other word");
});

test("exceptions are stored after the kinds and survive a change of kinds", () => {
  const first = nextGitHubRepositoryFeatures(undefined, ["pulls", "issues"], "subscribe", ["octocat"]);
  assert.deepEqual(first, ["issues", "pulls", "except:octocat"]);
  assert.deepEqual(githubSubscriptionExceptions(first), ["octocat"]);
  assert.deepEqual(nextGitHubRepositoryFeatures(first, ["checks"], "subscribe"),
    ["issues", "pulls", "checks", "except:octocat"]);
  assert.deepEqual(nextGitHubRepositoryFeatures(first, [], "unsubscribe", ["octocat"]), ["issues", "pulls"]);
  assert.deepEqual(nextGitHubRepositoryFeatures(first, ["issues", "pulls"], "unsubscribe"), [],
    "a relation with no kind of event left is empty");
  assert.deepEqual(nextGitHubRepositoryFeatures(undefined, [], "subscribe", ["octocat"]), []);
});

test("an excepted account's issues and pull requests are left out, whoever acts on them", () => {
  const exceptions = ["octocat"];
  assert.equal(githubDeliveryExcepted({ pull_request: { user: { login: "Octocat" } }, sender: { login: "other" } },
    exceptions), true);
  assert.equal(githubDeliveryExcepted({ issue: { user: { login: "other" } }, sender: { login: "octocat" } },
    exceptions), false, "someone else's issue stays, even when the excepted account acts on it");
  assert.equal(githubDeliveryExcepted({ sender: { login: "octocat" } }, exceptions), true);
  assert.equal(githubDeliveryExcepted({ pull_request: { user: { login: "octocat" } } }, []), false);
});

test("a repository subscription with an exception skips that account's pull requests", async () => {
  for (const [author, expected] of [["octocat", 0], ["contributor", 1]]) {
    const appended = [];
    const route = { relationId: "r-1", installationId: "42", sourceRef: "github:repo:acme/app", sourceKind: "repository",
      createdAt: "2026-01-01T00:00:00.000Z", spaceId: "space-1", channelId: "channel-1", connectionId: "connection-1",
      authorityRootUserId: "user-1", features: ["pulls", "except:octocat"] };
    const result = await dispatchProductGitHubWebhook({ env: {}, event: "pull_request", delivery: `d-${author}`,
      payload: {
        installation: { id: 42 }, action: "opened", sender: { login: author },
        repository: { name: "app", owner: { login: "acme" }, private: false, visibility: "public" },
        pull_request: { number: 7, title: "Change", html_url: "https://github.com/acme/app/pull/7", user: { login: author } },
      } }, {
      exposure: { channel: async () => ({ id: "channel-1", spaceId: "space-1", mode: "open" }), openParticipation: async () => true },
      resolveRoutes: async () => [route],
      delegated: async () => true,
      wake: async () => {},
      append: async (_env, channelId, message) => { appended.push({ channelId, body: message.body }); return { ok: true }; },
    });
    assert.equal(result.delivered, expected, author);
    assert.equal(appended.length, expected, author);
  }
});
