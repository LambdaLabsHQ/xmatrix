import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { readDraftSummonIntents, registerSummonIntentRoutes } from "../src/index-routes-summon-intent.ts";

const body = "@codex fix it; @codex was the heading";
const summons = [{ start: 0, end: 6 }, { start: 15, end: 21 }];
test("preview reads each exact summon against the whole draft and authorized context", async () => {
  const calls = [];
  const channelContext = { messages: [{ body: "previous discussion" }] };
  const readings = await readDraftSummonIntents({ body, summons, channelContext, evaluate: async input => {
    calls.push(input);
    const choice = input.state.summon.start === 0 ? "summon" : "explanation";
    return { answers: { intent: { choice, probabilities: { summon: .5, explanation: .5 } } } };
  } });
  assert.deepEqual(readings, [{ ...summons[0], mention: "@codex", choice: "summon" },
    { ...summons[1], mention: "@codex", choice: "explanation" }]);
  for (const call of calls) {
    assert.equal(call.state.message, body);
    assert.deepEqual(call.state.channelContext, channelContext);
    assert.deepEqual(Object.keys(call.questions), ["intent"]);
    assert.equal(call.state.summon.authorKind, "user");
  }
});

test("preview refuses invalid model answers instead of manufacturing a launch", async () => {
  await assert.rejects(readDraftSummonIntents({ body, summons, channelContext: {},
    evaluate: async () => ({ answers: { intent: { choice: "unknown", probabilities: {} } } }) }));
});

test("preview refuses Agent callers and bounds draft size and range count before model work", async () => {
  const post = async (user, input) => {
    const app = new Hono();
    registerSummonIntentRoutes(app, async () => user);
    return app.request("/api/channels/c/summon-intent", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify(input) }, {});
  };
  assert.equal((await post({ id: "u", agentRun: {} }, { body, summons })).status, 401);
  for (const input of [{ body: "x".repeat(20_001), summons }, { body, summons: Array(5).fill(summons[0]) },
    { body, summons: [{ start: -1, end: 6 }] }, { body, summons: [{ start: 0, end: 100 }] },
    { body, summons: [{ start: .5, end: 6 }] }, { body: "", summons }]) {
    assert.equal((await post({ id: "u" }, input)).status, 400);
  }
  const unavailable = await post({ id: "u" }, { body, summons });
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.headers.get("cache-control"), "private, no-store");
});

test("each Human's previews are bounded before the draft is read, even while request limits only log", async () => {
  const counts = new Map();
  const env = { RATE_LIMIT_SUMMON_INTENT: { async limit({ key }) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { success: counts.get(key) <= 1 };
  } } };
  const post = async (id) => {
    const app = new Hono();
    registerSummonIntentRoutes(app, async () => ({ id }));
    return app.request("/api/channels/c/summon-intent", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ body, summons }) }, env);
  };
  assert.equal((await post("u")).status, 503, "the first preview reaches Jev's configuration check");
  const refused = await post("u");
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "60");
  assert.equal((await refused.json()).code, "rate_limited");
  assert.equal((await post("v")).status, 503, "each Human has their own allowance");
});
