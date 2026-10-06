import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJevClient, JEV_MODEL } from "../packages/decision-model/src/jev.mjs";

const input = {
  state: { message: "The build passed, ready for review." },
  questions: {
    passed: { type: "boolean", instructions: "Did the build pass?" },
    next: { type: "choice", instructions: "Choose the next step.", criteria: { review: "Ready for review", retry: "Build failed" } },
    urgency: { type: "score", instructions: "Assess urgency.", criteria: ["low", "high"] },
  },
};
const answers = {
  passed: { type: "boolean", probability: 0.99 },
  next: { type: "choice", choice: "review", probabilities: { review: 0.9, retry: 0.1 } },
  urgency: { type: "score", score: 0.1, probabilities: { 0: 0.9, 1: 0.1 } },
};

test("uses the real SDK evaluation transport for all three question types", async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: "test-secret", zeroDataRetention: true, fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
    const headers = new Headers(init.headers);
    assert.equal(headers.get("authorization"), "Bearer test-secret");
    assert.equal(headers.get("ai-model-id"), JEV_MODEL);
    assert.equal(init.redirect, "manual");
    assert.deepEqual(JSON.parse(init.body), { ...input, providerOptions: { gateway: { zeroDataRetention: true } } });
    return Response.json({ answers, usage: { inputTokens: 100, outputTokens: 10 }, providerMetadata: { private: { value: "omit" } } });
  } });
  const result = await client.evaluate(input);
  assert.deepEqual(result, { model: JEV_MODEL, answers, usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } });
  assert.equal(calls, 1);
});

test("rejects missing credentials, invalid input and oversized input before network access", async () => {
  assert.throws(() => createJevClient(), /AI_GATEWAY_API_KEY/);
  let calls = 0;
  const client = createJevClient({ apiKey: "test", fetch: async () => { calls++; throw new Error("unexpected"); } });
  await assert.rejects(client.evaluate({ ...input, model: "another" }));
  await assert.rejects(client.evaluate({ state: "test", questions: {} }));
  await assert.rejects(client.evaluate({ state: "你".repeat(30_000), questions: input.questions }), /65536/);
  assert.equal(calls, 0);
});

test("rejects answers outside the declared choices", async () => {
  const client = createJevClient({ apiKey: "test", fetch: async () => Response.json({
    answers: { ...answers, next: { type: "choice", choice: "undeclared" } },
  }) });
  await assert.rejects(client.evaluate(input), /jev_evaluation_failed/);
});

test("default calls do not require the paid-plan zero data retention feature", async () => {
  const client = createJevClient({ apiKey: "test", fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).providerOptions, {});
    return Response.json({ answers });
  } });
  assert.deepEqual((await client.evaluate(input)).answers, answers);
});

test("does not retry provider failures or expose provider error text", async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: "test", fetch: async () => {
    calls++;
    return Response.json({ error: { message: "private request and secret", type: "rate_limit_error" } }, { status: 429 });
  } });
  await assert.rejects(client.evaluate(input), (error) => {
    assert.equal(error.code, "jev_rate_limited");
    assert.doesNotMatch(error.stack, /private request/);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(calls, 1);
});

test("timeout aborts the in-flight request", async () => {
  const client = createJevClient({ apiKey: "test", timeoutMs: 20, fetch: async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      if (init.signal.aborted) reject(init.signal.reason);
    });
  } });
  await assert.rejects(client.evaluate(input), /jev_aborted/);
});

test("distinguishes account verification from an invalid key", async () => {
  const client = createJevClient({ apiKey: "test", fetch: async () => Response.json({
    error: { type: "customer_verification_required", message: "Add a credit card" },
  }, { status: 403 }) });
  await assert.rejects(client.evaluate(input), /jev_customer_verification_required/);
});

test("caller cancellation prevents any request", async () => {
  let calls = 0;
  const client = createJevClient({ apiKey: "test", fetch: async () => { calls++; } });
  await assert.rejects(client.evaluate(input, { signal: AbortSignal.abort() }), /jev_aborted/);
  assert.equal(calls, 0);
});

test("CLI help needs no key; missing configuration exits unsuccessfully without echoing input", () => {
  const cli = fileURLToPath(new URL("../packages/decision-model/src/cli.mjs", import.meta.url));
  const env = { ...process.env, AI_GATEWAY_API_KEY: "" };
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /state, questions/);
  const missing = spawnSync(process.execPath, [cli], { input: "private-input", encoding: "utf8", env });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.deepEqual(JSON.parse(missing.stderr), { error: "jev_invalid_input_or_configuration" });
});
