import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import test from "node:test";

import { apnsAuthorization, sendApns } from "../src/push/apns.ts";
import { sendFcm } from "../src/push/fcm.ts";
import { pushToPeople } from "../src/push/notify.ts";

const json = (text) => JSON.parse(Buffer.from(text, "base64url"));
const pem = (key) => key.export({ type: "pkcs8", format: "pem" });

function appleIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return { config: { keyP8: pem(privateKey), keyId: "ABCDE12345", teamId: "TEAM123456", topic: "sh.example.app" }, publicKey };
}

function firebaseIdentity(clientEmail) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { config: { projectId: "example-project", clientEmail, privateKey: pem(privateKey) }, publicKey };
}

test("an iPhone push is signed as the team's key and names the app", async () => {
  const { config, publicKey } = appleIdentity();
  const header = await apnsAuthorization(config, 1_800_000_000);
  const [head, claims, signature] = header.replace(/^bearer /u, "").split(".");
  assert.deepEqual(json(head), { alg: "ES256", kid: "ABCDE12345" });
  assert.deepEqual(json(claims), { iss: "TEAM123456", iat: 1_800_000_000 });
  assert.equal(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")), true);

  const requests = [];
  const respond = (status, body) => async (url, init) => {
    requests.push({ url, init });
    return new Response(body ? JSON.stringify(body) : null, { status });
  };
  const input = { config, deviceToken: "ab".repeat(32), title: "claude:1", body: "等你确认", collapseId: "c".repeat(32),
    data: { channelId: "channel-1", messageId: "m-1" }, nowSeconds: 1_800_000_000 };
  assert.equal(await sendApns({ ...input, fetch: respond(200) }), "sent");
  assert.equal(await sendApns({ ...input, fetch: respond(410, { reason: "Unregistered" }) }), "gone");
  assert.equal(await sendApns({ ...input, fetch: respond(400, { reason: "BadDeviceToken" }) }), "failed");
  assert.equal(await sendApns({ ...input, fetch: respond(400, { reason: "DeviceTokenNotForTopic" }) }), "failed");
  assert.equal(await sendApns({ ...input, fetch: respond(400, { reason: "PayloadTooLarge" }) }), "failed");
  assert.equal(await sendApns({ ...input, fetch: respond(403, { reason: "InvalidProviderToken" }) }), "failed");
  const { url, init } = requests[0];
  assert.equal(url, `https://api.push.apple.com/3/device/${"ab".repeat(32)}`);
  assert.equal(init.headers["apns-topic"], "sh.example.app");
  assert.equal(init.headers["apns-push-type"], "alert");
  assert.equal(init.headers["apns-collapse-id"], "c".repeat(32));
  assert.deepEqual(JSON.parse(init.body), {
    aps: { alert: { title: "claude:1", body: "等你确认" }, sound: "default", "thread-id": "c".repeat(32) },
    channelId: "channel-1", messageId: "m-1",
  });
});

test("an Android push is sent as the service account, whose access token is reused", async () => {
  const { config, publicKey } = firebaseIdentity("push-a@example-project.iam.gserviceaccount.com");
  const requests = [];
  const respond = (status) => async (url, init) => {
    requests.push({ url, init });
    return url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "granted-token", expires_in: 3600 })
      : new Response("{}", { status });
  };
  const input = { config, deviceToken: "device-token", title: "claude:1", body: "等你确认", collapseKey: "c".repeat(32),
    data: { channelId: "channel-1", messageId: "m-1" }, nowSeconds: 1_800_000_000 };
  assert.equal(await sendFcm({ ...input, fetch: respond(200) }), "sent");
  assert.equal(await sendFcm({ ...input, fetch: respond(404) }), "failed");
  assert.equal(await sendFcm({ ...input, fetch: respond(400) }), "failed");
  assert.equal(await sendFcm({ ...input, fetch: respond(503) }), "failed");
  assert.deepEqual(requests.map((request) => new URL(request.url).hostname),
    ["oauth2.googleapis.com", "fcm.googleapis.com", "fcm.googleapis.com", "fcm.googleapis.com", "fcm.googleapis.com"]);

  const grant = new URLSearchParams(requests[0].init.body);
  assert.equal(grant.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const [head, claims, signature] = grant.get("assertion").split(".");
  assert.deepEqual(json(head), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(json(claims), { iss: config.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: 1_800_000_000, exp: 1_800_003_600 });
  assert.equal(verify("sha256", Buffer.from(`${head}.${claims}`), publicKey, Buffer.from(signature, "base64url")), true);

  const { url, init } = requests[1];
  assert.equal(url, "https://fcm.googleapis.com/v1/projects/example-project/messages:send");
  assert.equal(init.headers.authorization, "Bearer granted-token");
  assert.deepEqual(JSON.parse(init.body), { message: {
    token: "device-token",
    notification: { title: "claude:1", body: "等你确认" },
    data: { channelId: "channel-1", messageId: "m-1" },
    android: { collapse_key: "c".repeat(32), priority: "HIGH", notification: { tag: "c".repeat(32) } },
  } });

  // An expired token is asked for again.
  await sendFcm({ ...input, nowSeconds: 1_800_000_000 + 3600, fetch: respond(200) });
  assert.equal(requests.filter((request) => request.url === "https://oauth2.googleapis.com/token").length, 2);
});

test("a refused service account fails the push without forgetting the device", async () => {
  const { config } = firebaseIdentity("push-b@example-project.iam.gserviceaccount.com");
  const listed = [{ deviceId: "d".repeat(64), userId: "user-1", platform: "fcm", token: "device-token" }];
  const forgotten = [];
  const devices = { async listForUsers() { return listed; }, async forget(input) { forgotten.push(input.deviceIds); } };
  const notification = { channelId: "channel-1", messageId: "m-1", title: "claude:1", body: "等你确认" };
  await assert.rejects(sendFcm({ config, deviceToken: "device-token", title: "t", body: "b", collapseKey: "k", data: {},
    fetch: async () => new Response("{}", { status: 401 }) }), /FCM token request failed \(401\)/u);
  // With only an Android identity, a browser's and an iPhone's device are left alone.
  const mixed = [...listed,
    { deviceId: "e".repeat(64), userId: "user-1", platform: "apns", token: "ab".repeat(32) },
    { deviceId: "f".repeat(64), userId: "user-1", platform: "webpush", token: "https://push.example.test/a", keys: { p256dh: "p", auth: "a" } }];
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 401 });
  try {
    assert.deepEqual(await pushToPeople({ config: { fcm: config }, devices: { ...devices, async listForUsers() { return mixed; } },
      userIds: ["user-1"], notification }), { sent: 0, gone: 0, failed: 1 });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(forgotten, []);
});

test("only explicit phone-token expiry permits forgetting a registered device", async (t) => {
  const { config: apns } = appleIdentity();
  const { config: fcm } = firebaseIdentity("expiry@example-project.iam.gserviceaccount.com");
  const detail = (errorCode, type = "type.googleapis.com/google.firebase.fcm.v1.FcmError") =>
    ({ error: { code: 404, status: "NOT_FOUND", details: [{ "@type": type, errorCode }] } });
  const cases = [
    ["fcm", 404, detail("UNREGISTERED"), true],
    ["fcm", 404, { error: { status: "NOT_FOUND" } }, false],
    ["fcm", 404, detail("UNREGISTERED", "type.googleapis.com/google.rpc.BadRequest"), false],
    ["fcm", 404, detail("SENDER_ID_MISMATCH"), false],
    ["fcm", 404, { error: { details: [...detail("UNREGISTERED").error.details,
      ...detail("SENDER_ID_MISMATCH").error.details] } }, false],
    ["fcm", 404, { error: { details: null } }, false],
    ["fcm", 404, { error: { details: [null, "UNREGISTERED"] } }, false],
    ["fcm", 403, detail("UNREGISTERED"), false],
    ["apns", 410, { reason: "Unregistered" }, true],
    ["apns", 410, { reason: "ExpiredToken" }, true],
    ["apns", 400, { reason: "BadDeviceToken" }, false],
    ["apns", 400, { reason: "DeviceTokenNotForTopic" }, false],
    ["apns", 410, { reason: "Unknown" }, false],
    ...["fcm", "apns"].flatMap(platform => [null, "not json", "null", "x".repeat(16_385)].map(body =>
      [platform, platform === "fcm" ? 404 : 410, body, false])),
  ];
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const [platform, status, body, terminal] of cases) {
    const device = { deviceId: "d".repeat(64), userId: "user-1", platform,
      token: platform === "apns" ? "ab".repeat(32) : "device-token" };
    const forgotten = [];
    globalThis.fetch = async url => url === "https://oauth2.googleapis.com/token"
      ? Response.json({ access_token: "expiry-test-token", expires_in: 3600 })
      : new Response(typeof body === "object" && body !== null ? JSON.stringify(body) : body, { status });
    const result = await pushToPeople({ config: { apns, fcm }, userIds: ["user-1"],
      devices: { async listForUsers() { return [device]; }, async forget(input) { forgotten.push(...input.deviceIds); } },
      notification: { channelId: "channel-1", messageId: "m-1", title: "Agent", body: "Ready" } });
    const label = `${platform} ${status}: ${JSON.stringify(body).slice(0, 180)}`;
    assert.deepEqual(forgotten, terminal ? [device.deviceId] : [], label);
    assert.deepEqual(result, { sent: 0, gone: terminal ? 1 : 0, failed: terminal ? 0 : 1 }, label);
  }
});

test("the Mac app is pushed to under its own topic, and not at all without one", async () => {
  const { config } = appleIdentity();
  const listed = [
    { deviceId: "a".repeat(64), userId: "user-1", platform: "apns", token: "ab".repeat(32) },
    { deviceId: "b".repeat(64), userId: "user-1", platform: "apns", token: "cd".repeat(32), app: "mac" },
  ];
  const devices = { async listForUsers() { return listed; }, async forget() {} };
  const notification = { channelId: "channel-1", messageId: "m-1", title: "claude:1", body: "等你确认" };
  const topics = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { topics.push(`${String(url).slice(-4)} ${init.headers["apns-topic"]}`); return new Response(null, { status: 200 }); };
  try {
    assert.deepEqual(await pushToPeople({ config: { apns: config }, devices, userIds: ["user-1"], notification }),
      { sent: 1, gone: 0, failed: 0 });
    assert.deepEqual(await pushToPeople({ config: { apns: { ...config, macTopic: "net.example.mac" } }, devices,
      userIds: ["user-1"], notification }), { sent: 2, gone: 0, failed: 0 });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(topics.sort(), ["abab sh.example.app", "abab sh.example.app", "cdcd net.example.mac"]);
});
