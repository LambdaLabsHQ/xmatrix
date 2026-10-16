import assert from "node:assert/strict";
import { test } from "node:test";

import { GMAIL_ACTIONS } from "../src/connectors/actions/gmail.ts";
import { xProviderJson } from "../src/connectors/x-oauth.ts";
import { judgeMessageSupersession } from "../src/message-supersession.ts";
import { USAGE_COST_LAYOUT, upstreamMeter } from "../src/usage-cost-metering.ts";
import { withProviderResponses } from "./support/fetch-responses.mjs";

/**
 * Operator-paid calls are metered per Space (docs/operations/usage-cost-metering.md):
 * ids, enums and numbers only, never the text a call carried, and metering
 * never changes the call it describes.
 */

const SPACE = "space-7f3a";
const EARLIER = "Progress: rotating the private key for customer-acme.";
const LATER = "Progress: rotation done, tokens reissued.";

function sink(overrides = {}) {
  const written = [];
  return { written, env: { XMATRIX_USAGE_COST_AE: { writeDataPoint: point => written.push(point) },
    CF_VERSION_METADATA: { id: "version-1" }, JEV_AI_GATEWAY_API_KEY: "jev-test-key", ...overrides } };
}

const report = (from, body, sequence) => ({ messageId: `m-${sequence}`, sequence, body, from,
  sentAt: new Date(Date.UTC(2026, 9, 16, 9, 0, sequence)).toISOString(), messageKind: "xmatrix.message.text" });
const agent = { kind: "agent", identityId: "agent:claude", instanceId: "instance-1" };

/** One supersession judgment through the real Jev client, against a stubbed AI Gateway. */
function judge(env, gateway) {
  const window = [report(agent, EARLIER, 1), report(agent, LATER, 2)];
  return withProviderResponses(gateway, () => judgeMessageSupersession({ env, channelId: "channel-1",
    messageId: "m-2", sequence: 2, principal: { kind: "agent", id: "agent:claude" },
    history: async () => ({ spaceId: SPACE, messages: window }),
    annotate: async () => null, publish: async () => {} }));
}

const answered = { body: { answers: { superseded: { type: "boolean", probability: 0.2 } },
  usage: { inputTokens: 812, outputTokens: 3 } } };

test("a Jev call is one datapoint in its Space with its feature and tokens, never its input", async () => {
  const { env, written } = sink();
  const { result, calls } = await judge(env, [answered]);
  assert.equal(result.reason, "still_needed");
  assert.equal(calls.length, 1);
  assert.equal(written.length, 1);
  const [point] = written;
  assert.deepEqual(point.indexes, [SPACE]);
  assert.deepEqual(point.blobs, [USAGE_COST_LAYOUT, "jev", "space", "supersession", "none", "typesafe-ai/jev",
    "ok", "none", "version-1"]);
  assert.deepEqual(point.doubles.slice(0, 3), [1, 812, 3]);
  assert.ok(point.doubles[3] >= 0);
  const serialized = JSON.stringify(point);
  for (const text of [EARLIER, LATER, "customer-acme", "jev-test-key", "channel-1", "agent:claude"]) {
    assert.ok(!serialized.includes(text), text);
  }
});

test("a failed Jev call is metered with its code and no tokens; the caller still sees the failure", async () => {
  const { env, written } = sink();
  const failure = { status: 429, body: { error: { message: "private request text", type: "rate_limit_error" } } };
  await assert.rejects(judge(env, [failure]), error => error.code === "jev_rate_limited");
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].blobs.slice(1, 8), ["jev", "space", "supersession", "none", "unknown", "error", "jev_rate_limited"]);
  assert.deepEqual(written[0].doubles.slice(0, 3), [1, 0, 0]);
  assert.ok(!JSON.stringify(written[0]).includes("private request text"));
});

test("without the dataset, or when its write throws, metered calls behave exactly as before", async () => {
  const { env: unbound } = sink({ XMATRIX_USAGE_COST_AE: undefined });
  assert.equal((await judge(unbound, [answered])).result.reason, "still_needed");
  const { env: broken } = sink({ XMATRIX_USAGE_COST_AE: { writeDataPoint: () => { throw new Error("dataset unavailable"); } } });
  assert.equal((await judge(broken, [answered])).result.reason, "still_needed");
  await assert.rejects(judge(broken, [{ status: 429, body: {} }]), error => error.code === "jev_rate_limited");
  const meter = upstreamMeter(undefined, { spaceId: SPACE, connector: "x", action: "post" });
  assert.equal(await meter("x", "posts_create", async () => "posted"), "posted");
});

test("each Composio call of a Gmail action is metered to its Space and action, without mail", async () => {
  const { env, written } = sink();
  const mailbox = { account: "ca_mailbox1", address: "owner@example.com", owner: "user:user-1" };
  const context = { credentials: { mailboxes: JSON.stringify([mailbox]), composioApiKey: "composio-project-key" },
    caller: { userId: "user-1" }, usage: upstreamMeter(env, { spaceId: SPACE, connector: "gmail", action: "search" }) };
  const gmail = (data, status = 200) => ({ body: { status, data } });
  await withProviderResponses([
    gmail({ messages: [{ id: "18f2a9c0d1e2b3a4" }, { id: "18f2a9c0d1e2b3a5" }] }),
    gmail({ id: "18f2a9c0d1e2b3a4", snippet: "Invoice for customer-acme", payload: { headers: [] } }),
    gmail({ error: { message: "Requested entity was not found." } }, 404),
  ], () => assert.rejects(GMAIL_ACTIONS.search.execute(context, { query: "from:billing@acme.test" }), /404|not found/u));
  // The message reads run concurrently, so their points arrive in either order.
  assert.deepEqual(written.map(point => point.blobs.slice(1, 8)).sort((a, b) => b[5].localeCompare(a[5])), [
    ["composio", "space", "gmail", "search", "proxy", "ok", "none"],
    ["composio", "space", "gmail", "search", "proxy", "ok", "none"],
    ["composio", "space", "gmail", "search", "proxy", "error", "http_404"],
  ]);
  assert.ok(written.every(point => point.indexes[0] === SPACE && point.doubles[0] === 1));
  const serialized = JSON.stringify(written);
  for (const text of ["billing@acme.test", "owner@example.com", "customer-acme", "ca_mailbox1", "composio-project-key"]) {
    assert.ok(!serialized.includes(text), text);
  }
});

test("X calls are metered by API operation, never by an id, handle or token", async () => {
  const { env, written } = sink();
  const meter = upstreamMeter(env, { spaceId: SPACE, connector: "x", action: "read_post" });
  const bearer = { headers: { authorization: "Bearer x-access-token" } };
  await withProviderResponses([{ body: { data: { id: "1846000000000000001" } } }, { status: 402, body: {} }], async () => {
    await xProviderJson("/2/tweets/1846000000000000001?tweet.fields=author_id,created_at", bearer, meter);
    await assert.rejects(xProviderJson("/2/users/2244994945/tweets?max_results=10&tweet.fields=author_id,created_at",
      bearer, meter), /402/u);
  });
  assert.deepEqual(written.map(point => point.blobs.slice(1, 8)), [
    ["x", "space", "x", "read_post", "posts_read", "ok", "none"],
    ["x", "space", "x", "read_post", "user_posts_read", "error", "http_402"],
  ]);
  const serialized = JSON.stringify(written);
  for (const text of ["1846000000000000001", "2244994945", "x-access-token"]) assert.ok(!serialized.includes(text), text);
});
