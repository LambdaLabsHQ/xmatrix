import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import test from "node:test";

import { messagePushNotification, pushConfig, pushToPeople } from "../src/push/notify.ts";
import { encryptWebPush, sendWebPush, vapidAuthorization } from "../src/push/web-push.ts";

const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

/** A browser's subscription, and its own way of opening what was sent to it (RFC 8291). */
function browser() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const keys = { p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) };
  const open = (body) => {
    const salt = body.subarray(0, 16);
    const keyLength = body[20];
    const serverPublic = body.subarray(21, 21 + keyLength);
    const sealed = body.subarray(21 + keyLength);
    const shared = ecdh.computeSecret(serverPublic);
    const ikm = Buffer.from(hkdfSync("sha256", shared, auth,
      Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), serverPublic]), 32));
    const key = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const decipher = createDecipheriv("aes-128-gcm", key, nonce);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    assert.equal(plain.at(-1), 2, "the single record ends with the last-record delimiter");
    return { text: plain.subarray(0, -1).toString("utf8"), recordSize: body.readUInt32BE(16) };
  };
  return { keys, open };
}

function vapidKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()), subject: "mailto:push@example.test",
    raw: ecdh.getPublicKey() };
}

test("only the subscribed browser can read a push", async () => {
  const client = browser();
  const sealed = Buffer.from(await encryptWebPush({ endpoint: "https://push.example.test/x", keys: client.keys },
    new TextEncoder().encode("claude:1: 等你确认 ✓")));
  assert.deepEqual(client.open(sealed), { text: "claude:1: 等你确认 ✓", recordSize: 4096 });
  await assert.rejects(encryptWebPush({ endpoint: "https://push.example.test/x", keys: { p256dh: "AAAA", auth: client.keys.auth } },
    new Uint8Array(1)), /invalid subscription keys/u);
  await assert.rejects(encryptWebPush({ endpoint: "https://push.example.test/x", keys: client.keys }, new Uint8Array(5000)),
    /too large/u);
});

test("a push names its service and is signed with the Hub's key", async () => {
  const vapid = vapidKeys();
  const header = await vapidAuthorization(vapid, "https://push.example.test/send/abc", 1_800_000_000);
  const [, token, key] = /^vapid t=([^,]+), k=(.+)$/u.exec(header);
  assert.equal(key, vapid.publicKey);
  const [head, claims, signature] = token.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(head, "base64url")), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")),
    { aud: "https://push.example.test", exp: 1_800_000_000 + 43_200, sub: "mailto:push@example.test" });
  const publicKey = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256",
    x: b64(vapid.raw.subarray(1, 33)), y: b64(vapid.raw.subarray(33, 65)) } });
  assert.equal(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url")), true);
});

test("sending reports a subscription the push service no longer knows", async () => {
  const vapid = vapidKeys();
  const client = browser();
  const requests = [];
  const respond = (status) => async (url, init) => { requests.push({ url, init }); return new Response(null, { status }); };
  const input = { vapid, subscription: { endpoint: "https://push.example.test/send/abc", keys: client.keys },
    payload: "{\"title\":\"x\"}", topic: "abc", nowSeconds: 1_800_000_000 };
  assert.equal(await sendWebPush({ ...input, fetch: respond(201) }), "sent");
  assert.equal(await sendWebPush({ ...input, fetch: respond(410) }), "gone");
  assert.equal(await sendWebPush({ ...input, fetch: respond(404) }), "gone");
  assert.equal(await sendWebPush({ ...input, fetch: respond(500) }), "failed");
  const { url, init } = requests[0];
  assert.equal(url, "https://push.example.test/send/abc");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-encoding"], "aes128gcm");
  assert.equal(init.headers.topic, "abc");
  assert.equal(init.headers.urgency, "high");
  assert.equal(client.open(Buffer.from(init.body)).text, "{\"title\":\"x\"}");
});

test("PUSH_CONFIG is optional, and a malformed one is refused", () => {
  assert.deepEqual(pushConfig(undefined), {});
  assert.deepEqual(pushConfig("  "), {});
  assert.deepEqual(pushConfig("{}"), {});
  const { raw: _raw, ...vapid } = vapidKeys();
  assert.deepEqual(pushConfig(JSON.stringify({ vapid })), { vapid });
  assert.throws(() => pushConfig("{"), /not valid JSON/u);
  assert.throws(() => pushConfig(JSON.stringify({ vapid: { ...vapid, subject: "push@example.test" } })), /PUSH_CONFIG\.vapid/u);
  assert.throws(() => pushConfig(JSON.stringify({ vapid: { ...vapid, privateKey: "short" } })), /PUSH_CONFIG\.vapid/u);
  const apns = { keyP8: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----", keyId: "ABCDE12345",
    teamId: "TEAM123456", topic: "sh.example.app" };
  const account = { project_id: "example-project", client_email: "push@example-project.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n", type: "service_account" };
  assert.deepEqual(pushConfig(JSON.stringify({ vapid, apns, fcm: account })), { vapid, apns, fcm: {
    projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key.trim() } });
  assert.deepEqual(pushConfig(JSON.stringify({ apns })), { apns });
  assert.throws(() => pushConfig(JSON.stringify({ apns: { ...apns, keyId: "short" } })), /PUSH_CONFIG\.apns/u);
  assert.throws(() => pushConfig(JSON.stringify({ fcm: { ...account, private_key: "" } })), /PUSH_CONFIG\.fcm/u);
});

test("a message is pushed to the devices of the people it is addressed to, and gone devices are forgotten", async () => {
  const { raw: _raw, ...vapid } = vapidKeys();
  const listed = [
    { deviceId: "a".repeat(64), userId: "user-1", platform: "webpush", token: "https://push.example.test/a", keys: { p256dh: "p", auth: "a" } },
    { deviceId: "b".repeat(64), userId: "user-1", platform: "webpush", token: "https://push.example.test/b", keys: { p256dh: "p", auth: "a" } },
    { deviceId: "c".repeat(64), userId: "user-2", platform: "apns", token: "ab".repeat(32) },
  ];
  const calls = { list: [], forget: [], sent: [] };
  const devices = {
    async listForUsers(input) { calls.list.push(input.userIds); return listed; },
    async forget(input) { calls.forget.push(input.deviceIds); },
  };
  const notification = messagePushNotification("channel-1", { messageId: "m-1", from: { label: "claude:1" },
    body: "**等你确认**：合并还是等评审？" });
  assert.equal(notification.title, "claude:1");
  assert.equal(notification.channelId, "channel-1");
  assert.ok(notification.body.includes("等你确认"));
  const result = await pushToPeople({ config: { vapid }, devices, userIds: ["user-1", "user-2"], notification,
    send: async (device, payload, topic) => {
      calls.sent.push({ device: device.deviceId, payload: JSON.parse(payload), topic });
      return device.platform !== "webpush" ? "skipped" : device.deviceId.startsWith("b") ? "gone" : "sent";
    } });
  assert.deepEqual(result, { sent: 1, gone: 1, failed: 0 });
  assert.deepEqual(calls.list, [["user-1", "user-2"]]);
  assert.deepEqual(calls.forget, [["b".repeat(64)]]);
  assert.equal(calls.sent.length, 3);
  assert.deepEqual(calls.sent[0].payload, notification);
  assert.match(calls.sent[0].topic, /^[0-9a-f]{32}$/u);
  assert.equal(new Set(calls.sent.map((sent) => sent.topic)).size, 1, "one conversation, one collapsing topic");

  // Nobody addressed, or no browser identity configured: nothing is read or sent.
  assert.deepEqual(await pushToPeople({ config: { vapid }, devices, userIds: [], notification }), { sent: 0, gone: 0, failed: 0 });
  assert.deepEqual(await pushToPeople({ config: {}, devices, userIds: ["user-1"], notification }), { sent: 0, gone: 0, failed: 0 });
  assert.equal(calls.list.length, 1);
  assert.equal(messagePushNotification("channel-1", { messageId: "m-2", body: "" }), null);
});
