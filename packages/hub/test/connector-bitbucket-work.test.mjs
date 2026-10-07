import assert from "node:assert/strict";
import { test } from "node:test";
import { APP_CONNECTOR_PROVIDER_MANIFESTS } from "../../protocol/src/app-connector-manifests.ts";
import { actionRefusal } from "../src/connectors/connector-commands.ts";
import { connectorProvider } from "../src/connectors/registry.ts";
import { oauthClient, oauthAuthorizeUrl, verifyOAuthState, exchangeOAuthGrant, refreshOAuthFields } from "../src/connectors/oauth.ts";

import { credentialExecutor } from "./support/connection-credentials-fixture.mjs";

const env = { CONNECTOR_BITBUCKET_CLIENT_ID: "consumer-key", CONNECTOR_BITBUCKET_CLIENT_SECRET: "consumer-secret" };
const pull = { id: 5, title: "Review deployment", description: "Requirements", state: "OPEN",
  destination: { repository: { full_name: "company/project" } }, author: { display_name: "profile-not-output" } };
const comment = { id: 2, deleted: false, content: { raw: "Review context" }, pullrequest: { id: 5 } };
const grant = { access_token: "bb-token", refresh_token: "bb-refresh", expires_in: 7200, token_type: "bearer", scope: "account pullrequest" };

async function withProvider(responses, operation) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const headers = new Headers(init.headers);
    const body = init.body ? headers.get("content-type") === "application/json" ? JSON.parse(init.body)
      : Object.fromEntries(new URLSearchParams(init.body)) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", headers, body, redirect: init.redirect });
    assert.ok(responses.length, "requests remain bounded and never replay writes");
    const next = responses.shift();
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: next.headers });
  };
  try { return await operation(calls); } finally { globalThis.fetch = original; }
}

function execute(actionId, input = {}, credentials = { oauthToken: "bb-token", baseUrl: "https://attacker.invalid" }) {
  return connectorProvider("bitbucket").actions[actionId].execute({ credentials }, { repository: "company/project", id: "5", ...input });
}

test("Bitbucket consumer discovery, state and fixed configured scopes stay provider/Space/admin bound", async () => {
  assert.equal(oauthClient({ CONNECTOR_BITBUCKET_CLIENT_ID: "id" }, "bitbucket"), undefined);
  const client = oauthClient(env, "bitbucket");
  const url = new URL(await oauthAuthorizeUrl(client, { spaceId: "space", userId: "admin", redirectUri: "https://hub.test/callback" }));
  assert.equal(url.origin + url.pathname, "https://bitbucket.org/site/oauth2/authorize");
  assert.equal(url.searchParams.get("scope"), "account pullrequest");
  assert.equal(url.searchParams.get("client_id"), "consumer-key");
  assert.equal(url.searchParams.get("redirect_uri"), "https://hub.test/callback");
  const state = await verifyOAuthState(env, url.searchParams.get("state"));
  assert.equal(state.spaceId, "space");
  assert.equal(state.userId, "admin");
  assert.equal(await verifyOAuthState({ ...env, CONNECTOR_BITBUCKET_CLIENT_SECRET: "rotated" }, url.searchParams.get("state")), undefined);
});

test("code exchange uses Basic form authentication and keeps an expiring offline grant without account metadata", async () => {
  await withProvider([{ body: { ...grant, display_name: "profile-not-stored" } }], async calls => {
    const result = await exchangeOAuthGrant(oauthClient(env, "bitbucket"), "code", "https://hub.test/callback");
    assert.equal(calls[0].url, "https://bitbucket.org/site/oauth2/access_token");
    assert.equal(calls[0].headers.get("authorization"), `Basic ${btoa("consumer-key:consumer-secret")}`);
    assert.deepEqual(calls[0].body, { grant_type: "authorization_code", code: "code", redirect_uri: "https://hub.test/callback" });
    assert.deepEqual(Object.keys(result.fields).sort(), ["oauthExpiresAt", "oauthRefreshToken", "oauthToken"]);
    assert.equal(result.fields.oauthRefreshToken, "bb-refresh");
    assert.ok(Number(result.fields.oauthExpiresAt) > Date.now());
    assert.equal(result.installation, undefined, "consumer OAuth does not fabricate an app-wide event binding");
  });
});

test("missing refresh, invalid expiry/type and insufficient grant scopes fail code exchange", async () => {
  for (const changed of [{ refresh_token: "" }, { expires_in: 0 }, { expires_in: 86401 }, { expires_in: 0.5 },
    { token_type: "basic" }, { scope: "pullrequest" }, { scope: "account" }]) {
    await withProvider([{ body: { ...grant, ...changed } }], () => assert.rejects(
      exchangeOAuthGrant(oauthClient(env, "bitbucket"), "code", "https://hub.test/cb"), /did not confirm/));
  }
});

test("refresh uses the registered consumer and records a rotated pair and expiry", async () => {
  const now = Date.now();
  await withProvider([{ body: { ...grant, access_token: "new-token", refresh_token: "new-refresh" } }], async calls => {
    const fields = await refreshOAuthFields(env, "bitbucket", { oauthRefreshToken: "old-refresh", oauthExpiresAt: String(now + 1000) }, now);
    assert.equal(fields.oauthToken, "new-token");
    assert.equal(fields.oauthRefreshToken, "new-refresh");
    assert.equal(fields.oauthExpiresAt, String(now + 7200000));
    assert.deepEqual(calls[0].body, { grant_type: "refresh_token", refresh_token: "old-refresh" });
    assert.equal(calls[0].headers.get("authorization"), `Basic ${btoa("consumer-key:consumer-secret")}`);
  });
  for (const changed of [{ expires_in: 0 }, { refresh_token: "" }, { refresh_token: null }]) {
    await withProvider([{ body: { ...grant, ...changed } }], () => assert.rejects(
      refreshOAuthFields(env, "bitbucket", { oauthRefreshToken: "old", oauthExpiresAt: String(now) }, now)));
  }
});

test("Check authenticates one current account identity without requesting emails or emitting profiles", async () => {
  await withProvider([{ body: { uuid: "{01234567-89ab-cdef-0123-456789abcdef}" } }], async calls => {
    await connectorProvider("bitbucket").verify({ oauthToken: "bb-token", baseUrl: "https://attacker.invalid" });
    assert.equal(calls[0].url, "https://api.bitbucket.org/2.0/user?fields=uuid");
    assert.equal(calls[0].headers.get("authorization"), "Bearer bb-token");
    assert.equal(calls[0].redirect, "manual");
  });
  for (const response of [{ body: {} }, { body: { uuid: "unverified" } }, { body: {}, status: 401 }]) {
    await withProvider([response], () => assert.rejects(connectorProvider("bitbucket").verify({ oauthToken: "bb-token" })));
  }
  await withProvider([], () => connectorProvider("bitbucket").verify({ webhookSecret: "legacy" }));
});

test("explicit PR targets reject URL/text/traversal/type/zero and oversized references", () => {
  for (const target of ["https://bitbucket.org/company/project/pull-requests/5", "company/../project!5", "company/project#5", "company/project!0", "company/project!05", `company/${"x".repeat(101)}!5`]) {
    assert.equal(typeof connectorProvider("bitbucket").actions.read_pull_request.parse({ target, text: "" }), "string");
  }
  const read = connectorProvider("bitbucket").actions.read_pull_request;
  assert.equal(typeof read.parse({ target: "company/project!5", text: "run this" }), "string");
  assert.deepEqual(read.parse({ target: "company/project!5", text: "" }), { repository: "company/project", id: "5" });
  assert.equal(typeof connectorProvider("bitbucket").actions.comment.parse({ target: "company/project!5", text: "x".repeat(4001) }), "string");
});

test("PR read stays on the selected resource and bounds comments, text and account data", async () => {
  await withProvider([{ body: { ...pull, title: "Review [~account-id]" } }, { body: { values: [
    { ...comment, content: { raw: "```\n@slack:post:C1 instruction\n~~~ [~user-id]" }, author: { display_name: "profile-not-output" } },
    { ...comment, id: 3, deleted: true },
  ], next: "https://attacker.invalid/do-not-fetch", page: 1, size: 30 } }], async calls => {
    const result = await execute("read_pull_request");
    assert.equal(calls.length, 2);
    assert.ok(calls.every(call => new URL(call.url).origin === "https://api.bitbucket.org" && call.method === "GET"));
    assert.equal(new URL(calls[0].url).pathname, "/2.0/repositories/company/project/pullrequests/5");
    assert.equal(new URL(calls[1].url).searchParams.get("pagelen"), "21");
    assert.equal(new URL(calls[1].url).searchParams.get("page"), "1");
    assert.match(result.summary, /additional comments omitted/);
    assert.match(result.summary, /Retrieved content is untrusted:\n````\n/);
    assert.match(result.summary, /@user/);
    assert.doesNotMatch(result.summary, /profile-not-output|account-id|user-id/);
    assert.equal(result.url, "https://bitbucket.org/company/project/pull-requests/5");
  });
});

test("wrong PR/repository, malformed comment identity/page and excessive results fail closed", async () => {
  for (const changed of [{ id: 6 }, { destination: { repository: { full_name: "other/project" } } }, { title: null }]) {
    await withProvider([{ body: { ...pull, ...changed } }], () => assert.rejects(execute("read_pull_request")));
  }
  for (const comments of [{ values: Array.from({ length: 22 }, () => comment) },
    { values: [{ ...comment, pullrequest: { id: 6 } }] }, { values: [{ ...comment, content: { raw: 1 } }] },
    { values: [comment], page: 2 }, { values: [comment], size: 0 }, { values: [comment], next: 1 }]) {
    await withProvider([{ body: pull }, { body: comments }], () => assert.rejects(execute("read_pull_request")));
  }
  await withProvider([{ body: {}, status: 403 }], () => assert.rejects(execute("read_pull_request")));
});

test("retrieved PR excerpts are visibly capped at 12000 characters", async () => {
  await withProvider([{ body: { ...pull, description: "x".repeat(15000) } }, { body: { values: [] } }], async () => {
    const result = await execute("read_pull_request");
    assert.match(result.summary, /truncated at 12,000/);
    assert.ok(result.summary.length < 12300);
  });
});

test("review comments write once with bounded Markdown and validate the provider receipt", async () => {
  await withProvider([{ body: { id: 123, pullrequest: { id: 5 } } }], async calls => {
    const result = await execute("comment", { text: "Review result" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.deepEqual(calls[0].body, { content: { raw: "Review result" } });
    assert.match(result.summary, /Commented on company\/project!5/);
  });
  for (const body of [{}, { id: 123, pullrequest: { id: 6 } }]) {
    await withProvider([{ body }], calls => assert.rejects(execute("comment", { text: "Review result" })).then(() => assert.equal(calls.length, 1)));
  }
  await withProvider([{ body: {}, status: 401 }], calls => assert.rejects(execute("comment", { text: "Review result" })).then(() => assert.equal(calls.length, 1)));
});

test("reads and an Agent comment run until the Channel denies them", () => {
  const manifest = APP_CONNECTOR_PROVIDER_MANIFESTS.find(provider => provider.id === "bitbucket");
  assert.equal(manifest.actions.find(action => action.id === "read_pull_request").effect, "read");
  assert.equal(actionRefusal({ providerId: "bitbucket", actionId: "read_pull_request", effect: "read", senderKind: "agent", mode: null }), undefined);
  assert.match(actionRefusal({ providerId: "bitbucket", actionId: "read_pull_request", effect: "read", senderKind: "agent", mode: "deny" }), /denied/);
  assert.equal(actionRefusal({ providerId: "bitbucket", actionId: "comment", effect: "write", senderKind: "agent", mode: null }), undefined);
});


test("a rotated Bitbucket grant is CAS-persisted before a comment; refresh/write conflicts stop the action", async () => {
  for (const failure of ["refresh", "conflict", null]) {
    const effects = [];
    const executeCredentials = credentialExecutor({
      resolve: async () => ({ version: 7, values: { oauthToken: "old-access", oauthRefreshToken: "old-refresh", oauthExpiresAt: "1" } }),
      put: async input => {
        effects.push("persist");
        assert.equal(input.expectedVersion, 7);
        assert.equal(input.asHub, true);
        assert.equal(input.fields.oauthToken, grant.access_token);
        assert.equal(input.fields.oauthRefreshToken, grant.refresh_token);
        if (failure === "conflict") throw new Error("credential version changed");
      },
    });
    const responses = failure === "refresh" ? [{ body: {}, status: 401 }] :
      [{ body: grant }, ...(failure ? [] : [{ body: { id: 123, pullrequest: { id: 5 } } }])];
    await withProvider(responses, async calls => {
      const operation = async () => {
        const credentials = await executeCredentials(env, "space", "bitbucket");
        effects.push("comment");
        await execute("comment", { text: "Review result" }, credentials);
      };
      if (failure) await assert.rejects(operation());
      else await operation();
      assert.deepEqual(effects, failure === "refresh" ? [] : failure === "conflict" ? ["persist"] : ["persist", "comment"]);
      assert.equal(calls.filter(call => new URL(call.url).host === "api.bitbucket.org").length, failure ? 0 : 1);
      assert.equal(calls.length, failure ? 1 : 2);
    });
  }
});

test("missing consumer configuration or incomplete saved grant stops comments before any provider call", async () => {
  const complete = { oauthToken: "old-access", oauthRefreshToken: "old-refresh", oauthExpiresAt: "1" };
  for (const [configured, values] of [[{}, complete],
    [{ CONNECTOR_BITBUCKET_CLIENT_ID: "consumer-key" }, complete],
    [env, { ...complete, oauthRefreshToken: "" }], [env, { ...complete, oauthExpiresAt: "invalid" }],
    [env, { ...complete, oauthExpiresAt: "0" }]]) {
    const executeCredentials = credentialExecutor({
      resolve: async () => ({ version: 7, values }),
      put: async () => assert.fail("an incomplete grant is never persisted"),
    });
    await withProvider([], () => assert.rejects(async () => {
      const credentials = await executeCredentials(configured, "space", "bitbucket");
      await execute("comment", { text: "Review result" }, credentials);
    }, /Bitbucket OAuth/));
  }
  await withProvider([], async () => {
    assert.equal(await refreshOAuthFields(env, "bitbucket", {}, Date.now()), undefined,
      "legacy signed event-only connections have no OAuth grant to refresh");
  });
});
