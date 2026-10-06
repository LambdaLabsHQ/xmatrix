import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { registerRequestRateLimit } from "../src/request-rate-limit.ts";
import { PostgresHumanPort } from "../src/runtime-transport/postgres-human-port.ts";

/** A limiter that admits `allowance` requests per key and records every key it saw. */
function limiter(allowance) {
  const counts = new Map();
  return {
    keys: [],
    async limit({ key }) {
      this.keys.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return { success: counts.get(key) <= allowance };
    },
  };
}

function hub(env) {
  const app = new Hono();
  registerRequestRateLimit(app);
  app.get("*", (c) => c.json({ ok: true }));
  return (path, headers = {}) => app.request(`https://xmatrix-hub.xmatrix.sh${path}`, { headers }, env);
}

test("a credential over its allowance is refused with 429 and Retry-After once enforced", async () => {
  const env = { RATE_LIMIT_CREDENTIAL: limiter(2), RATE_LIMIT_ENFORCED: "true" };
  const call = hub(env);
  const auth = { Authorization: "Bearer token-a" };
  assert.equal((await call("/api/channels", auth)).status, 200);
  assert.equal((await call("/api/channels", auth)).status, 200);
  const refused = await call("/api/channels", auth);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "60");
  assert.deepEqual(await refused.json(),
    { error: "Too many requests. Try again shortly.", code: "rate_limited", retryable: true });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-b" })).status, 200,
    "each credential has its own allowance");
  assert.ok(env.RATE_LIMIT_CREDENTIAL.keys.every((key) => !key.includes("token-")),
    "the limiter never holds a usable credential");
});

test("over the limit is only measured while enforcement is off", async () => {
  const call = hub({ RATE_LIMIT_CREDENTIAL: limiter(0) });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-a" })).status, 200);
});

test("requests without a credential are counted per client IP, except our own Workers' subrequests", async () => {
  const env = { RATE_LIMIT_ANONYMOUS: limiter(1), RATE_LIMIT_ENFORCED: "true" };
  const call = hub(env);
  assert.equal((await call("/ws/humans", { "CF-Connecting-IP": "203.0.113.7" })).status, 200);
  assert.equal((await call("/ws/humans", { "CF-Connecting-IP": "203.0.113.7" })).status, 429);
  assert.equal((await call("/ws/humans", { "CF-Connecting-IP": "203.0.113.8" })).status, 200);
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await call("/api/channels/page",
      { "CF-Connecting-IP": "2a06:98c0::1", "CF-Worker": "xmatrix.sh" })).status, 200);
  }
  assert.equal((await call("/api/channels/page",
    { "CF-Connecting-IP": "198.51.100.1", "CF-Worker": "elsewhere.example" })).status, 200);
  assert.equal((await call("/api/channels/page",
    { "CF-Connecting-IP": "198.51.100.1", "CF-Worker": "elsewhere.example" })).status, 429,
  "another zone's Worker is counted like any other caller");
});

test("without limiter bindings every request is admitted", async () => {
  const call = hub({ RATE_LIMIT_ENFORCED: "true" });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-a" })).status, 200);
  assert.equal((await call("/api/channels", { "CF-Connecting-IP": "203.0.113.7" })).status, 200);
});

test("a Human socket over its sign-in allowance is refused after the token check", async () => {
  const admitted = [];
  const port = new PostgresHumanPort({
    authenticate: async () => ({ id: "user-1", email: "a@example.test" }),
    admitConnect: async (userId) => { admitted.push(userId); return admitted.length <= 1; },
    readHistory: async () => { throw new Error("unexpected history read"); },
  });
  assert.equal((await port.authenticate({ token: "t" })).user.id, "user-1");
  await assert.rejects(port.authenticate({ token: "t" }),
    (error) => error.failure?.code === "human_rate_limited");
  assert.deepEqual(admitted, ["user-1", "user-1"], "counted per verified user");
});
