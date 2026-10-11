import assert from "node:assert/strict";
import { createECDH, generateKeyPairSync } from "node:crypto";
import { setImmediate, setTimeout } from "node:timers/promises";
import test from "node:test";
import { sendFcm } from "../src/push/fcm.ts";
import { pushToPeople } from "../src/push/notify.ts";

const notification = { channelId: "conversation", messageId: "message", title: "Agent", body: "Ready" };
const account = { projectId: "project", clientEmail: "budget@example.test",
  privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) };
const apns = { keyP8: generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }),
  keyId: "ABCDE12345", teamId: "TEAM123456", topic: "sh.example.app" };
const curve = () => { const key = createECDH("prime256v1"); key.generateKeys(); return key; };
const browser = curve(), vapidKey = curve();
const b64 = bytes => bytes.toString("base64url");
const vapid = { publicKey: b64(vapidKey.getPublicKey()), privateKey: b64(vapidKey.getPrivateKey()), subject: "mailto:push@example.test" };
const devices = (platform, count = 1) => Array.from({ length: count }, (_, index) => ({
  deviceId: `device-${index}`, userId: "person", platform,
  token: platform === "webpush" ? "https://push.example.test/send" : "device-token",
  ...(platform === "webpush" ? { keys: { p256dh: b64(browser.getPublicKey()), auth: b64(Buffer.alloc(16, 7)) } } : {}),
}));

function deliver(list, options = {}) {
  const forgotten = [];
  return { forgotten, result: pushToPeople({ config: { vapid, apns, fcm: account }, userIds: ["person"], notification,
    devices: { async listForUsers() { return list; }, async forget(input) { forgotten.push(...input.deviceIds); } }, ...options }) };
}

test("a notification has at most eight simultaneous device deliveries and visits every device once", async () => {
  const gate = Promise.withResolvers(), ready = Promise.withResolvers();
  const started = [];
  const batch = deliver(devices("webpush", 25), { send: async device => {
    started.push(device.deviceId); if (started.length === 8) ready.resolve();
    await gate.promise; return "sent";
  } });
  await ready.promise;
  const firstWave = started.length;
  gate.resolve();
  assert.deepEqual(await batch.result, { sent: 25, gone: 0, failed: 0 });
  assert.equal(firstWave, 8);
  assert.equal(new Set(started).size, 25);
});

test("concurrent FCM sends share one refresh; rejected grants retry and a rotated key gets a new grant", async (t) => {
  // Cryptography has independent signature tests. Here every caller reaches
  // the asynchronous token request together, without CPU timing assumptions.
  t.mock.method(crypto.subtle, "importKey", async () => ({}));
  t.mock.method(crypto.subtle, "sign", async () => new ArrayBuffer(256));
  let grants = 0, refused = false;
  const authorizations = [];
  const request = async (url, init) => {
    if (url.includes("oauth2")) {
      const number = ++grants;
      await setTimeout(0);
      return refused ? new Response(null, { status: 503 }) : Response.json({ access_token: `grant-${number}`, expires_in: 3600 });
    }
    authorizations.push(init.headers.authorization);
    return new Response(null, { status: 200 });
  };
  const config = { ...account, clientEmail: "coalesced@example.test" };
  const send = identity => sendFcm({ config: identity, deviceToken: "token", title: "t", body: "b", data: {}, collapseKey: "c", fetch: request });
  await Promise.all(Array.from({ length: 12 }, () => send(config)));
  assert.equal(grants, 1);
  assert.deepEqual(new Set(authorizations), new Set(["Bearer grant-1"]));
  await send({ ...config, privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) });
  assert.equal(grants, 2);
  assert.equal(authorizations.at(-1), "Bearer grant-2");
  refused = true;
  const retry = { ...config, clientEmail: "retry@example.test" };
  await assert.rejects(send(retry), /FCM token request failed/);
  refused = false;
  await send(retry);
  assert.equal(grants, 4);
});

test("stalled headers or provider bodies expire, cancel work, and preserve device registrations", async (t) => {
  for (const [platform, stage] of [["webpush", "headers"], ["apns", "headers"], ["fcm", "headers"],
    ["apns", "body"], ["fcm", "body"], ["fcm", "oauth-body"]]) {
    await t.test(`${platform} ${stage}`, { timeout: 2000 }, async (child) => {
      child.mock.timers.enable({ apis: ["setTimeout"] });
      const seen = Promise.withResolvers();
      let cancelled = 0;
      const identity = { ...account, clientEmail: `${platform}-${stage}@example.test` };
      child.mock.method(globalThis, "fetch", async (url, init) => {
        if (url.includes("oauth2") && stage !== "oauth-body" && stage !== "headers") {
          return Response.json({ access_token: "fixture-grant", expires_in: 3600 });
        }
        if (stage === "headers") {
          seen.resolve(init.signal);
          return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
        }
        return new Response(new ReadableStream({
          pull() { seen.resolve(init.signal); }, cancel() { cancelled++; },
        }, { highWaterMark: 0 }), { status: stage === "oauth-body" ? 200 : platform === "apns" ? 410 : 404 });
      });
      const batch = deliver(devices(platform), { config: { vapid, apns, fcm: identity } });
      const signal = await seen.promise;
      assert.ok(signal instanceof AbortSignal, "provider I/O must belong to a cancellable delivery");
      child.mock.timers.tick(10_000);
      assert.deepEqual(await batch.result, { sent: 0, gone: 0, failed: 1 });
      assert.equal(signal.aborted, true);
      assert.deepEqual(batch.forgotten, []);
      if (stage !== "headers") assert.equal(cancelled, 1, "release the stalled reader");
    });
  }
});

test("the batch deadline stops queued sends and late retirement replies cannot delete devices", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const late = Promise.withResolvers();
  const firstWave = Promise.withResolvers(), secondWave = Promise.withResolvers();
  const started = [];
  const batch = deliver(devices("webpush", 25), { send: async device => {
    started.push(device.deviceId);
    if (started.length === 8) firstWave.resolve();
    if (started.length === 16) secondWave.resolve();
    return late.promise;
  } });
  await firstWave.promise;
  now = 10_000;
  t.mock.timers.tick(10_000);
  await secondWave.promise;
  now = 20_000;
  t.mock.timers.tick(10_000);
  assert.deepEqual(await batch.result, { sent: 0, gone: 0, failed: 25 });
  assert.equal(started.length, 16, "queued devices never start after the batch expires");
  late.resolve("gone");
  await setImmediate();
  assert.deepEqual(batch.forgotten, []);
});

test("a timed out OAuth refresh frees its slot, and a late grant cannot replace the successful retry", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = Promise.withResolvers(), seen = Promise.withResolvers();
  const authorizations = [];
  let grants = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("oauth2")) {
      if (++grants === 1) { seen.resolve(); return late.promise; }
      return Response.json({ access_token: "new-grant", expires_in: 3600 });
    }
    authorizations.push(init.headers.authorization);
    return new Response(null, { status: 200 });
  });
  const options = { config: { fcm: { ...account, clientEmail: "timeout-retry@example.test" } } };
  const first = deliver(devices("fcm"), options);
  await seen.promise;
  t.mock.timers.tick(10_000);
  assert.deepEqual(await first.result, { sent: 0, gone: 0, failed: 1 });
  await setImmediate();
  assert.deepEqual(await deliver(devices("fcm"), options).result, { sent: 1, gone: 0, failed: 0 });
  late.resolve(Response.json({ access_token: "stale-grant", expires_in: 3600 }));
  await setImmediate();
  assert.deepEqual(await deliver(devices("fcm"), options).result, { sent: 1, gone: 0, failed: 0 });
  assert.equal(grants, 2);
  assert.deepEqual(authorizations, ["Bearer new-grant", "Bearer new-grant"]);
  assert.deepEqual(first.forgotten, []);
});

test("OAuth response bytes share the provider decoder's bound and malformed grants preserve devices", async (t) => {
  for (const [name, reply] of [["oversize", JSON.stringify({ access_token: "token", padding: "x".repeat(16_384) })],
    ["malformed", "not json"], ["array", JSON.stringify([{ access_token: "token" }])]]) {
    let requests = 0;
    t.mock.method(globalThis, "fetch", async () => { requests++; return new Response(reply, { status: 200 }); });
    const batch = deliver(devices("fcm"), { config: { fcm: { ...account, clientEmail: `${name}-grant@example.test` } } });
    assert.deepEqual(await batch.result, { sent: 0, gone: 0, failed: 1 });
    assert.equal(requests, 1, "no message request after an invalid grant");
    assert.deepEqual(batch.forgotten, []);
  }
});

test("OAuth and message send consume the same deadline and successful responses release unused bodies", { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const grant = Promise.withResolvers(), tokenSeen = Promise.withResolvers(), sendSeen = Promise.withResolvers();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url.includes("oauth2")) { tokenSeen.resolve(init.signal); return grant.promise; }
    sendSeen.resolve(init.signal);
    return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const batch = deliver(devices("fcm"), { config: { fcm: { ...account, clientEmail: "shared-deadline@example.test" } } });
  const tokenSignal = await tokenSeen.promise;
  assert.ok(tokenSignal);
  t.mock.timers.tick(6000);
  grant.resolve(Response.json({ access_token: "deadline-grant", expires_in: 3600 }));
  assert.equal(await sendSeen.promise, tokenSignal);
  t.mock.timers.tick(4000);
  assert.deepEqual(await batch.result, { sent: 0, gone: 0, failed: 1 });
  let cancelled = 0;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 201 }));
  assert.deepEqual(await deliver(devices("webpush")).result, { sent: 1, gone: 0, failed: 0 });
  assert.equal(cancelled, 1);
});
