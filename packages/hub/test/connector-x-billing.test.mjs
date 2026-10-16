import assert from "node:assert/strict";
import { test } from "node:test";
import { PaidXCalls } from "../src/billing-paid-calls.ts";
import { xProviderJson, xCallPrice } from "../src/connectors/x-oauth.ts";
import { withProviderResponses } from "./support/fetch-responses.mjs";

// PostgreSQL tests own balances/concurrency. These tests own the separate
// boundary between admission and actual HTTP, including retries and failures.
function fixture(overrides = {}) {
  const reservations = [], settlements = [];
  const receipts = new Map();
  const repository = {
    reserve: async input => {
      reservations.push(input);
      receipts.set(input.callId, input.units);
      return { callId: input.callId, reservedCredits: 120, chargedCredits: 120,
        remainingCredits: 1000, replayed: false };
    },
    settle: async input => {
      settlements.push(input);
      return { callId: input.callId, reservedCredits: 120,
        chargedCredits: receipts.has(input.callId) ? 120 * input.actualUnits / receipts.get(input.callId) : 30,
        remainingCredits: 1060, replayed: false };
    }, ...overrides,
  };
  const usage = new PaidXCalls(repository, { spaceId: "space", actorUserId: "human", billingKey: "command",
    creditsWaived: false }, async (_source, _operation, call) => call());
  return { usage, reservations, settlements };
}

test("X tariff metadata recognizes bare links and quote links without exporting text", () => {
  assert.deepEqual(xCallPrice("posts_create", { text: "No link in this post" }), { kind: "x_post", maximumUnits: 1 });
  for (const text of ["Read https://example.com/report", "Read example.com/report", "Read https://例子.中国", "README.md"]) {
    assert.deepEqual(xCallPrice("posts_create", { text }), { kind: "x_post_url", maximumUnits: 1 });
  }
  for (const text of ["Node.js and Next.js", "file.ts"]) {
    assert.deepEqual(xCallPrice("posts_create", { text }), { kind: "x_post", maximumUnits: 1 });
  }
  assert.deepEqual(xCallPrice("posts_create", { text: "A quote", quote_tweet_id: "123" }), { kind: "x_post_url", maximumUnits: 1 });
  assert.deepEqual(xCallPrice("user_posts_read"), { kind: "x_post_read", maximumUnits: 10 });
  assert.equal(xCallPrice("oauth_token"), undefined);
  assert.throws(() => xCallPrice("unknown"), /no configured credit price/u);
});

test("denied and replayed reservations never make an X HTTP request", async () => {
  for (const reserve of [async () => { throw Object.assign(new Error("Pro required"), { status: 402 }); },
    async () => ({ callId: "prior", reservedCredits: 30, chargedCredits: 30, remainingCredits: 100, replayed: true })]) {
    const { usage, settlements } = fixture({ reserve });
    const { calls } = await withProviderResponses([], () => assert.rejects(
      xProviderJson("/2/tweets", { method: "POST", json: { text: "Do not send" } }, usage.meter), /Pro required|already attempted/u));
    assert.equal(calls.length, 0);
    assert.equal(settlements.length, 0);
  }
});

test("admission completes before HTTP and provider rejection refunds while uncertain failures retain the reserve", async () => {
  let admit;
  const ready = new Promise(resolve => { admit = resolve; });
  const f = fixture({ reserve: async input => { await ready; return { callId: input.callId, reservedCredits: 30, chargedCredits: 30,
    remainingCredits: 100, replayed: false }; } });
  await withProviderResponses([{ body: { data: { id: "123" } } }], async calls => {
    const request = xProviderJson("/2/tweets", { method: "POST", json: { text: "Hello" } }, f.usage.meter);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 0);
    admit();
    await request;
    assert.equal(calls.length, 1);
  });
  for (const [status, units, outcome] of [[403,0,"rejected"], [503,1,"uncertain"]]) {
    const attempt = fixture();
    await withProviderResponses([{ status, body: {} }], () => assert.rejects(
      xProviderJson("/2/tweets", { method: "POST", json: { text: "Hello" } }, attempt.usage.meter)));
    assert.equal(attempt.settlements[0].actualUnits, units);
    assert.equal(attempt.settlements[0].outcome, outcome);
  }
});

test("one bounded media reservation covers the upload and settlement uses only attempted billable calls", async () => {
  const f = fixture();
  const settle = await f.usage.reserveMedia(4);
  await withProviderResponses([{ body: { data: { id: "123" } } }, { status: 403, body: {} }], async () => {
    await xProviderJson("/2/media/upload/initialize", { method: "POST" }, f.usage.meter);
    await assert.rejects(xProviderJson("/2/media/upload/123/append", { method: "POST" }, f.usage.meter));
  });
  await settle();
  await settle();
  assert.equal(f.reservations.length, 1);
  assert.equal(f.reservations[0].units, 4);
  assert.equal(f.settlements.length, 1);
  assert.equal(f.settlements[0].actualUnits, 1);
});

test("a timeline reserves its maximum but settles actual returned resources; OAuth calls are not charged", async () => {
  const f = fixture();
  await withProviderResponses([{ body: { data: [{ id: "1" }, { id: "2" }] } }, { body: {} }], async () => {
    await xProviderJson("/2/users/123/tweets?max_results=10&tweet.fields=author_id,created_at", {}, f.usage.meter);
    await xProviderJson("/2/oauth2/token", { method: "POST" }, f.usage.meter);
  });
  assert.equal(f.reservations.length, 1);
  assert.equal(f.reservations[0].units, 10);
  assert.equal(f.settlements[0].actualUnits, 2);
});

// A provider success must survive a local settlement/notice outage: neither
// path is authority to repeat a public post or silently release its reserve.
test("local settlement uncertainty and notice failure preserve the upstream outcome", async () => {
  let attempts = 0;
  const f = fixture({ settle: async () => { attempts++; throw new Error("database unavailable"); } });
  await withProviderResponses([{ body: { data: { id: "published" } } }], async calls => {
    const result = await xProviderJson("/2/tweets", { method: "POST", json: { text: "Once" } }, f.usage.meter);
    assert.equal(result.data.id, "published");
    assert.equal(calls.length, 1);
  });
  assert.equal(attempts, 2);
  assert.match(f.usage.summary(), /reserved \(settlement pending\)/u);
  const repository = { reserve: async input => ({ callId: input.callId, reservedCredits: 30,
    remainingCredits: 100 }), settle: async input => ({ callId: input.callId, chargedCredits: 30,
    remainingCredits: 100 }) };
  const usage = new PaidXCalls(repository, { spaceId: "space", actorUserId: "human", billingKey: "command",
    creditsWaived: false, announce: async () => { throw new Error("notice unavailable"); } },
    async (_source, _operation, call) => call());
  await withProviderResponses([{ body: { data: { id: "also-published" } } }], async () => {
    assert.equal((await xProviderJson("/2/tweets", { method: "POST", json: { text: "Once" } }, usage.meter)).data.id,
      "also-published");
  });
  assert.match(usage.summary(), /30 credits charged/u);
});

test("authorization revoked after reservation refunds before making any provider request", async () => {
  const settlements = [];
  const usage = new PaidXCalls({ reserve: async input => ({ callId: input.callId, reservedCredits: 30,
    remainingCredits: 100 }), settle: async input => { settlements.push(input); return { chargedCredits: 0,
    remainingCredits: 130 }; } }, { spaceId: "space", actorUserId: "human", billingKey: "command",
    creditsWaived: false, beforeCall: async () => { throw new Error("access revoked"); } },
    async (_source, _operation, call) => call());
  const { calls } = await withProviderResponses([], () => assert.rejects(xProviderJson("/2/tweets",
    { method: "POST", json: { text: "Do not send" } }, usage.meter), /access revoked/u));
  assert.equal(calls.length, 0);
  assert.equal(settlements[0].actualUnits, 0);
  assert.equal(settlements[0].outcome, "rejected");
});
