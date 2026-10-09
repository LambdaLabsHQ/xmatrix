import assert from "node:assert/strict";
import test from "node:test";
import { HUB_ROUTES } from "../../protocol/src/authority-foundation.ts";
import { createObservabilityMemoryApp } from "./support/observability-memory-routes.mjs";

const env = { RELAY_POSTGRES: { connectionString: "postgres://test" }, RELAY_POSTGRES_SHARD_ID: "shard-test",
  XMATRIX_SECRET_CATALOG_KEY: "material", SLACK_CLIENT_ID: "client", SLACK_CLIENT_SECRET: "secret" };
const state = `123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;

class SlackOAuthControlError extends Error {
  constructor(code, status, message) { super(message); this.code = code; this.status = status; }
}

function fixture(signedIn) {
  const approvals = [];
  class PostgresSlackOAuthRepository {
    async approve(input) {
      approvals.push(input);
      if (input.ownerUserId !== "owner") throw new SlackOAuthControlError("slack_oauth_not_found", 404, "Unknown Slack authorization state");
      if (!input.slackToken) throw new SlackOAuthControlError("slack_oauth_exchange_required", 428, "exchange required");
      return { ok: true };
    }
  }
  const imports = {
    "@xmatrix/db": { ControlError: SlackOAuthControlError, SlackOAuthControlError, PostgresSlackOAuthRepository },
    "./deployment-origins": { appOrigin: () => "https://xmatrix.test" },
    "./email-delivery": { escapeHtml: (value) => value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`) },
    "./index-shared": {
      requireAuth: async () => ({ id: signedIn }), requireHumanAuth: (user) => user,
      hubOrigin: () => "https://hub.test", productCommandId: (_request, kind, id) => `${kind}:${id}`,
      jsonErrors: async (context, run) => { try { return await run(); } catch (error) { return context.json({ error: error.message }, error.status ?? 500); } },
    },
  };
  const app = createObservabilityMemoryApp(imports);
  return { app, approvals };
}

function stubSlack() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return Response.json({ ok: true, authed_user: { access_token: "xoxp-token" }, team: { name: "Team" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const approve = (app) => app.request(HUB_ROUTES.slack_oauth_approve, { method: "POST",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ code: "one-use-code", state }) }, env);

test("the Slack callback hands the grant to the signed-in app and escapes a denial", async () => {
  const { app, approvals } = fixture("owner");
  const handoff = await app.request(`${HUB_ROUTES.slack_oauth_callback}?code=one-use-code&state=${encodeURIComponent(state)}`, {}, env);
  assert.equal(handoff.status, 302);
  const location = new URL(handoff.headers.get("location"));
  assert.equal(location.origin + location.pathname, "https://xmatrix.test/connect/slack");
  assert.equal(location.searchParams.get("code"), "one-use-code");
  assert.deepEqual(approvals, []);

  const denied = await app.request(`${HUB_ROUTES.slack_oauth_callback}?error=${encodeURIComponent("<script>x</script>")}`, {}, env);
  assert.equal(denied.status, 400);
  assert.doesNotMatch(await denied.text(), /<script>/u);
});

test("only the user who started the grant can approve it, and nobody else's attempt spends the code", async () => {
  const slack = stubSlack();
  try {
    const foreign = fixture("someone-else");
    const refused = await approve(foreign.app);
    assert.equal(refused.status, 404);
    assert.deepEqual(slack.calls, []);
    assert.equal(foreign.approvals.every((input) => input.ownerUserId === "someone-else" && !input.slackToken), true);

    const owner = fixture("owner");
    const approved = await approve(owner.app);
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), { ok: true });
    assert.equal(slack.calls.length, 1);
    assert.equal(owner.approvals.at(-1).slackToken, "xoxp-token");
    assert.equal(owner.approvals.at(-1).ownerUserId, "owner");
  } finally { slack.restore(); }
});
