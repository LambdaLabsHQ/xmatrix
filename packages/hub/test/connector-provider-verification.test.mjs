import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorProvider } from "../src/connectors/registry.ts";

function stubFetch(body, status = 200) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: new Headers(init.headers), method: init.method ?? "GET", body: init.body });
    return new Response(JSON.stringify(body), { status });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const cases = [
  { id: "slack", credentials: { botToken: "fixture-bot" }, response: { ok: true, team_id: "T123456" }, url: "https://slack.com/api/auth.test", authorization: "Bearer fixture-bot" },
  { id: "linear", credentials: { oauthToken: "fixture-linear" }, response: { data: { viewer: { id: "linear-viewer" } } }, url: "https://api.linear.app/graphql", authorization: "Bearer fixture-linear" },
  { id: "gitlab", credentials: { oauthToken: "fixture-gitlab" }, response: { id: 42 }, url: "https://gitlab.com/api/v4/user", authorization: "Bearer fixture-gitlab" },
  { id: "jira", credentials: { oauthToken: "fixture-jira", cloudId: "granted-site" }, response: [{ id: "granted-site" }], url: "https://api.atlassian.com/oauth/token/accessible-resources", authorization: "Bearer fixture-jira" },
  { id: "sentry", credentials: { oauthToken: "fixture-sentry" }, response: [], url: "https://sentry.io/api/0/organizations/", authorization: "Bearer fixture-sentry" },
];

for (const fixture of cases) {
  test(`${fixture.id} Check sends the stored credential to a read-only provider endpoint`, async () => {
    const fetch = stubFetch(fixture.response);
    try {
      assert.equal(await connectorProvider(fixture.id).verify(fixture.credentials), undefined);
      assert.equal(fetch.calls.length, 1);
      assert.equal(fetch.calls[0].url, fixture.url);
      assert.equal(fetch.calls[0].headers.get("authorization"), fixture.authorization);
      assert.ok(["GET", "POST"].includes(fetch.calls[0].method));
      if (fixture.id === "linear") {
        assert.equal(JSON.parse(fetch.calls[0].body).query, "query { viewer { id } }");
      }
    } finally { fetch.restore(); }
  });
  test(`${fixture.id} rejected or malformed API replies fail the connection check`, async () => {
    for (const reply of [{ body: { error: "unauthorized" }, status: 401 }, { body: {}, status: 200 }]) {
      const fetch = stubFetch(reply.body, reply.status);
      try { await assert.rejects(connectorProvider(fixture.id).verify(fixture.credentials)); }
      finally { fetch.restore(); }
    }
  });
}

test("Slack HTTP 200 failure, Linear partial errors, and Jira's wrong site all fail closed", async () => {
  for (const [id, credentials, reply] of [
    ["slack", { botToken: "fixture-bot" }, { ok: false, error: "invalid_auth" }],
    ["linear", { oauthToken: "fixture-linear" }, { data: { viewer: { id: "viewer" } }, errors: [{ message: "unauthorized" }] }],
    ["jira", { oauthToken: "fixture-jira", cloudId: "site-one" }, [{ id: "site-two" }]],
    ["jira", { oauthToken: "fixture-jira" }, [{ id: "site-one" }]],
  ]) {
    const fetch = stubFetch(reply);
    try { await assert.rejects(connectorProvider(id).verify(credentials)); }
    finally { fetch.restore(); }
  }
});

test("pasted API keys retain their provider-specific authorization scheme", async () => {
  for (const fixture of [
    { id: "linear", credentials: { apiKey: "fixture-linear-key" }, reply: { data: { viewer: { id: "viewer" } } }, header: "authorization", value: "fixture-linear-key" },
    { id: "gitlab", credentials: { accessToken: "fixture-gitlab-key", baseUrl: "https://gitlab.example.test" }, reply: { id: 7 }, header: "private-token", value: "fixture-gitlab-key" },
    { id: "jira", credentials: { apiToken: "fixture-jira-key", email: "fixture@example.test", siteUrl: "https://jira.example.test" }, reply: { accountId: "opaque-account" }, header: "authorization", value: `Basic ${btoa("fixture@example.test:fixture-jira-key")}` },
    { id: "sentry", credentials: { authToken: "fixture-sentry-key" }, reply: [], header: "authorization", value: "Bearer fixture-sentry-key" },
  ]) {
    const fetch = stubFetch(fixture.reply);
    try {
      await connectorProvider(fixture.id).verify(fixture.credentials);
      assert.equal(fetch.calls[0].headers.get(fixture.header), fixture.value);
      if (fixture.id === "jira") assert.equal(fetch.calls[0].url, "https://jira.example.test/rest/api/3/myself");
      if (fixture.id === "gitlab") assert.equal(fetch.calls[0].url, "https://gitlab.example.test/api/v4/user");
    } finally { fetch.restore(); }
  }
});

test("connections configured only for signed incoming events never invent an API credential", async () => {
  const fetch = stubFetch({});
  try {
    for (const { id } of cases) await connectorProvider(id).verify({ signingSecret: "fixture-signing" });
    assert.equal(fetch.calls.length, 0);
  } finally { fetch.restore(); }
});
