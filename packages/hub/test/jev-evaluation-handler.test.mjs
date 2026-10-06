import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateJevRequest,
} from "../src/jev-evaluation-handler.ts";
const env = { JEV_AI_GATEWAY_API_KEY: "provider-secret" };
const input = { state: "Build passed", questions: { passed: { type: "boolean", instructions: "Did it pass?" } } };
const request = (body = input, headers = { "content-type": "application/json" }) =>
  new Request("https://hub.example/api/ai/jev/evaluate", { method: "POST", headers, body: JSON.stringify(body) });
const readBody = async (request, limit) => {
  const body = await request.arrayBuffer();
  return body.byteLength > limit ? null : body;
};

test("rejects unauthorized and unconfigured calls before parsing or provider access", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not call provider"));
  const unread = async () => assert.fail("must not read caller body");
  await assert.rejects(evaluateJevRequest(request(), env, async () => { throw new Error("expired Run"); }, unread));
  assert.equal((await evaluateJevRequest(request(), env, async () => "", unread)).status, 403);
  assert.equal((await evaluateJevRequest(request(), {}, async () => "owner", unread)).status, 503);
  assert.equal((await evaluateJevRequest(request(), { JEV_AI_GATEWAY_API_KEY: " " }, async () => "owner", unread)).status, 503);
});

test("rejects caller-selected authority, endpoints and oversized bodies", async (t) => {
  t.mock.method(globalThis, "fetch", async () => assert.fail("must not call provider"));
  for (const extra of [{ ownerUserId: "owner" }, { model: "other" }, { apiKey: "caller" }, { baseURL: "https://attacker.example" }]) {
    assert.equal((await evaluateJevRequest(request({ ...input, ...extra }), env, async () => "owner", readBody)).status, 400);
  }
  assert.equal((await evaluateJevRequest(request(input, {}), env, async () => "owner", readBody)).status, 415);
  assert.equal((await evaluateJevRequest(request({ ...input, state: "x".repeat(70_000) }), env, async () => "owner", readBody)).status, 413);
  assert.equal((await evaluateJevRequest(request({ state: "x", questions: {} }), env, async () => "owner", readBody)).status, 400);
});

test("every authenticated account can evaluate without an account list, using only the Worker secret", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls++;
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer provider-secret");
    assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    assert.equal(init.redirect, "manual");
    return Response.json({ answers: { passed: { type: "boolean", probability: 0.9 } }, usage: { inputTokens: 10, outputTokens: 2 } });
  });
  const response = await evaluateJevRequest(request(), env, async () => "previously-unlisted-owner", readBody);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const result = await response.json();
  assert.deepEqual(Object.keys(result).sort(), ["answers", "model", "usage"]);
  assert.equal(result.answers.passed.probability, 0.9);
  assert.equal(calls, 1);
});

test("provider errors never expose credentials or response bodies", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { type: "rate_limit_error", message: "provider-secret" } }, { status: 429 }));
  const response = await evaluateJevRequest(request(), env, async () => "owner", readBody);
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: "jev_rate_limited" });
});
