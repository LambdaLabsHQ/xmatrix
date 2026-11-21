import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";

import { ALLOWANCE_RULES, TokenBucket, takeAllowance } from "../src/request-allowance.ts";
import { registerRequestRateLimit } from "../src/request-rate-limit.ts";
import { PostgresHumanPort } from "../src/runtime-transport/postgres-human-port.ts";

/** Allowance objects that admit `allowance` requests per key, then name a 7 s wait, recording every key asked. */
function allowances(allowance) {
  const counts = new Map();
  const keys = [];
  return { keys, idFromName: (name) => name, get: (name) => ({ async take() {
    keys.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
    return counts.get(name) <= allowance ? 0 : 7;
  } }) };
}

function hub(env) {
  const app = new Hono();
  registerRequestRateLimit(app);
  app.get("*", (c) => c.json({ ok: true }));
  return (path, headers = {}) => app.request(`https://xmatrix-hub.xmatrix.sh${path}`, { headers }, env);
}

test("a credential over its allowance is refused with 429 and Retry-After once enforced", async () => {
  const env = { RELAY_REQUEST_ALLOWANCE: allowances(2), RATE_LIMIT_ENFORCED: "true" };
  const call = hub(env);
  const auth = { Authorization: "Bearer token-a" };
  assert.equal((await call("/api/channels", auth)).status, 200);
  assert.equal((await call("/api/channels", auth)).status, 200);
  const refused = await call("/api/channels", auth);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "7", "the wait the allowance named");
  assert.deepEqual(await refused.json(),
    { error: "Too many requests. Try again shortly.", code: "rate_limited", retryable: true });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-b" })).status, 200,
    "each credential has its own allowance");
  assert.ok(env.RELAY_REQUEST_ALLOWANCE.keys.every((key) => !key.includes("token-")),
    "the limiter never holds a usable credential");
});

test("over the limit is only measured while enforcement is off", async () => {
  const call = hub({ RELAY_REQUEST_ALLOWANCE: allowances(0) });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-a" })).status, 200);
});

test("requests without a credential are counted per client IP, except our own Workers' subrequests", async () => {
  const env = { RELAY_REQUEST_ALLOWANCE: allowances(1), RATE_LIMIT_ENFORCED: "true" };
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

test("without the allowance binding every request is admitted", async () => {
  const call = hub({ RATE_LIMIT_ENFORCED: "true" });
  assert.equal((await call("/api/channels", { Authorization: "Bearer token-a" })).status, 200);
  assert.equal((await call("/api/channels", { "CF-Connecting-IP": "203.0.113.7" })).status, 200);
});

test("a sign-in endpoint asks the attempt counter without the client IP and refuses when it is spent", async () => {
  const asked = [];
  let admitted = true;
  const env = { DEVICE_AUTH: { idFromName: (name) => name, get: () => ({ async fetch(url, init) {
    asked.push({ url, ...JSON.parse(init.body) });
    return Response.json({ admitted });
  } }) } };
  const app = new Hono();
  registerRequestRateLimit(app);
  app.all("*", (c) => c.json({ ok: true }));
  const register = () => app.request("https://xmatrix-hub.xmatrix.sh/api/auth/oauth2/register",
    { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.7" } }, env);
  assert.equal((await register()).status, 200);
  admitted = false;
  const refused = await register();
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "60");
  assert.equal(asked[0].limits[0].max, 10);
  assert.ok(asked.every(({ limits }) => !limits[0].key.includes("203.0.113.7")), "the counter never holds the IP");
  assert.equal((await app.request("https://xmatrix-hub.xmatrix.sh/api/auth/get-session",
    { headers: { "CF-Connecting-IP": "203.0.113.7" } }, env)).status, 200, "other auth routes are not counted");
  assert.equal(asked.length, 2);
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

/** Real buckets behind the namespace shape: one per name, as one Durable Object per key keeps. */
function bucketNamespace(clock) {
  const buckets = new Map();
  return { idFromName: (name) => name, get: (name) => ({ async take(rateClass) {
    if (!buckets.has(name)) buckets.set(name, new TokenBucket(ALLOWANCE_RULES[rateClass], clock.now));
    return buckets.get(name).take(clock.now);
  } }) };
}

test("one credential's flood is cut at its burst while every other credential is served", async () => {
  // 2026-11-19: one Agent Run sent ~17,000 reads in three minutes on one credential and none was refused.
  const clock = { now: 1_000_000 };
  const call = hub({ RELAY_REQUEST_ALLOWANCE: bucketNamespace(clock), RATE_LIMIT_ENFORCED: "true" });
  const flood = { Authorization: "Bearer flooding-run" };
  const statuses = [];
  for (let i = 0; i < 2_000; i += 1) statuses.push((await call("/api/channels/c/history", flood)).status);
  assert.equal(statuses.filter((status) => status === 200).length, ALLOWANCE_RULES.credential.burst);
  assert.ok(statuses.slice(ALLOWANCE_RULES.credential.burst).every((status) => status === 429));
  const refused = await call("/api/channels/c/history", flood);
  assert.equal(refused.headers.get("Retry-After"), "1", "the next request fits within a second at 20 a second");
  assert.equal((await call("/api/channels", { Authorization: "Bearer someone-else" })).status, 200);
  clock.now += 10_000;
  const later = [];
  for (let i = 0; i < 400; i += 1) later.push((await call("/api/channels/c/history", flood)).status);
  assert.equal(later.filter((status) => status === 200).length, 200, "ten seconds refill twenty requests a second");
});

test("a refused request takes nothing, and a bucket never holds more than its burst", () => {
  const bucket = new TokenBucket({ perMinute: 60, burst: 2 }, 0);
  assert.deepEqual([bucket.take(0), bucket.take(0), bucket.take(0), bucket.take(0)], [0, 0, 1, 1]);
  assert.equal(bucket.take(1_000), 0, "one second buys one request however often it was refused");
  assert.deepEqual([bucket.take(3_600_000), bucket.take(3_600_000), bucket.take(3_600_000)], [0, 0, 1]);
});

test("an unreachable allowance admits the request; an overloaded one refuses its own flooding key", async (t) => {
  const warned = t.mock.method(console, "warn", () => {});
  const failing = (error) => ({ idFromName: (name) => name, get: () => ({ take: () => Promise.reject(error) }) });
  assert.equal(await takeAllowance(failing(new Error("Durable Object is briefly unavailable")), "credential", "k"), 0);
  assert.equal(warned.mock.callCount(), 1);
  assert.ok(await takeAllowance(failing(Object.assign(new Error("overloaded"), { overloaded: true })), "credential", "k") > 0);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = takeAllowance({ idFromName: (name) => name, get: () => ({ take: () => new Promise(() => {}) }) },
    "credential", "k");
  t.mock.timers.tick(1_000);
  assert.equal(await pending, 0, "an allowance that does not answer within a second admits");
});
