import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerSearchRerankRoutes, rerankSearchCandidates } from "../src/index-routes-search-rerank.ts";

const candidates = [
  { key: "channel:a", kind: "conversation", title: "#app/connector", detail: "updated 141d ago" },
  { key: "channel:b", kind: "conversation", title: "#Connector 消息唤醒 agent instance" },
  { key: "page:p", kind: "page", title: "Connector 平台" },
];

test("Jev reads each result and the best one; answers outside the candidates are dropped", async () => {
  let asked;
  const reading = await rerankSearchCandidates({ query: "connector wake", candidates, evaluate: async (input) => {
    asked = input;
    return { answers: { best: { type: "choice", choice: "r1" }, r0: { type: "boolean", probability: 0.05 },
      r1: { type: "boolean", probability: 0.97 }, r2: { type: "boolean", probability: 1.4 } } };
  } });
  assert.deepEqual(reading, { best: "channel:b", results: [
    { key: "channel:a", probability: 0.05 }, { key: "channel:b", probability: 0.97 },
    { key: "page:p", probability: 1 }] });
  assert.equal(asked.state.QUERY, "connector wake");
  assert.deepEqual(Object.keys(asked.questions).sort(), ["best", "r0", "r1", "r2"]);
  assert.deepEqual(Object.keys(asked.questions.best.criteria), ["r0", "r1", "r2", "none"]);
  assert.equal(asked.state.RESULTS.r0.about, "updated 141d ago");

  const none = await rerankSearchCandidates({ query: "x", candidates, evaluate: async () => ({
    answers: { best: { type: "choice", choice: "none" }, r0: { type: "boolean" } } }) });
  assert.deepEqual(none, { best: null, results: [] });
});

const post = async ({ user = { id: "u" }, input, plan = "pro", metered = true, env = {} }) => {
  const app = new Hono();
  registerSearchRerankRoutes(app, async () => user, () => async () => plan, metered);
  return app.request("/api/search/rerank", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(input) }, env);
};
const valid = { spaceId: "s", query: "connector", candidates };

test("only a Human in a Pro Space is read, and input is bounded before any model work", async () => {
  assert.equal((await post({ user: { id: "u", agentRun: {} }, input: valid })).status, 401);
  for (const input of [{ ...valid, query: "" }, { ...valid, query: "x".repeat(201) }, { ...valid, spaceId: "" },
    { ...valid, candidates: candidates.slice(0, 1) }, { ...valid, candidates: Array(21).fill(0).map((_, i) =>
      ({ key: `k${i}`, kind: "page", title: "t" })) }, { ...valid, candidates: [candidates[0], candidates[0]] },
    { ...valid, candidates: [candidates[0], { ...candidates[1], title: "x".repeat(301) }] }]) {
    assert.equal((await post({ input })).status, 400, JSON.stringify(input).slice(0, 80));
  }
  assert.equal((await post({ input: valid, plan: "free" })).status, 403);
  const unavailable = await post({ input: valid });
  assert.equal(unavailable.status, 503, "a Pro Space reaches Jev's configuration check");
  assert.equal(unavailable.headers.get("cache-control"), "private, no-store");
  assert.equal((await post({ input: valid, plan: "free", metered: false })).status, 503,
    "an unmetered deployment admits every Space");
});

test("each Human's reorderings are bounded even while request limits only log", async () => {
  const counts = new Map();
  const env = { RATE_LIMIT_SEARCH_RERANK: { async limit({ key }) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return { success: counts.get(key) <= 1 };
  } } };
  assert.equal((await post({ input: valid, env })).status, 503);
  const refused = await post({ input: valid, env });
  assert.equal(refused.status, 429);
  assert.equal((await post({ user: { id: "v" }, input: valid, env })).status, 503, "each Human has their own allowance");
});
