import assert from "node:assert/strict";
import { test } from "node:test";
import { sha256Hex } from "@xmatrix/protocol";
import { feishuNativeApp } from "../src/connectors/feishu-native.ts";
import { verifyFeishuAppRequest, feishuAppInteraction } from "../src/connectors/feishu-app-events.ts";
import { handleFeishuAppDelivery, FEISHU_INGRESS_DEPENDENCIES } from "../src/connectors/feishu-ingress.ts";
const native = await feishuNativeApp({ CONNECTOR_FEISHU_APP_ID: "cli_fixture1234", CONNECTOR_FEISHU_APP_SECRET: "fixture-app-secret",
  CONNECTOR_FEISHU_VERIFICATION_TOKEN: "fixture-verification", CONNECTOR_FEISHU_ENCRYPT_KEY: "fixture-encryption" });
const now = Date.now();
function lifecycle(type = "app_ticket", extra = {}) { return { type: "event_callback", ts: String(Math.floor(Date.now()/1000)), uuid: "fixture-event-id",
  token: native.verificationToken, event: { type, app_id: native.app.appId, app_ticket: "fixture-ticket", tenant_key: "tenantA", ...extra } }; }
function message(extra = {}, header = {}) { return { schema: "2.0", header: { app_id: native.app.appId, tenant_key: "tenantA", token: native.verificationToken,
  event_type: "im.message.receive_v1", event_id: "fixture-event-id", create_time: String(Date.now()), ...header }, event: {
  sender: { sender_type: "user", sender_id: { open_id: "ou_fixtureUser" } }, message: { chat_id: "oc_AbCd", chat_type: "group", message_type: "text",
    message_id: "om_fixtureMessage", content: JSON.stringify({ text: "fixture message" }), ...extra } } }; }
async function signed(payload) {
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(native.encryptKey));
  const key = await crypto.subtle.importKey("raw", digest, { name: "AES-CBC" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, new TextEncoder().encode(JSON.stringify(payload))));
  const bytes = new Uint8Array(16 + ciphertext.length); bytes.set(iv); bytes.set(ciphertext, 16);
  const raw = JSON.stringify({ encrypt: btoa(String.fromCharCode(...bytes)) });
  const ts = String(Math.floor(Date.now()/1000)), nonce = "fixture-nonce";
  const headers = new Headers({ "x-lark-request-timestamp": ts, "x-lark-request-nonce": nonce,
    "x-lark-signature": await sha256Hex(ts + nonce + native.encryptKey + raw) });
  return { raw, headers, request: () => new Request("https://hub.fixture/api/connectors/feishu/events", { method: "POST", body: raw, headers }) };
}
test("encrypted schema 1 tickets and schema 2 messages verify exact company app identity", async () => {
  for (const payload of [lifecycle(), message()]) {
    const f = await signed(payload); assert.deepEqual(await verifyFeishuAppRequest(native, f.raw, f.headers), payload);
    assert.ok(await feishuAppInteraction(payload));
  }
});
test("missing, duplicate, tampered and stale authentication fails without trusting plaintext lifecycle", async () => {
  const f = await signed(message());
  for (const name of ["x-lark-request-timestamp", "x-lark-request-nonce", "x-lark-signature"]) {
    const missing = new Headers(f.headers); missing.delete(name); await assert.rejects(verifyFeishuAppRequest(native, f.raw, missing), error => error.status === 401);
    const duplicate = new Headers(f.headers); duplicate.append(name, duplicate.get(name)); await assert.rejects(verifyFeishuAppRequest(native, f.raw, duplicate), error => error.status === 401);
  }
  await assert.rejects(verifyFeishuAppRequest(native, JSON.stringify(lifecycle()), f.headers), error => error.status === 401);
  await assert.rejects(verifyFeishuAppRequest(native, f.raw + " ", f.headers), error => error.status === 401);
  await assert.rejects(verifyFeishuAppRequest(native, f.raw, f.headers, now + 600000), error => error.status === 401);
  for (const payload of [message({}, { app_id: "cli_otherFixture" }), message({}, { token: "other-token" })]) {
    const bad = await signed(payload); await assert.rejects(verifyFeishuAppRequest(native, bad.raw, bad.headers), error => error.status === 401);
  }
});
test("URL challenge is token-bound and does not create any ticket, tenant or room authority", async () => {
  const payload = { type: "url_verification", token: native.verificationToken, challenge: "fixture-challenge" };
  const calls = [];
  const result = await handleFeishuAppDelivery({}, new Request("https://hub.fixture/events", { method: "POST", body: JSON.stringify(payload) }),
    { ...FEISHU_INGRESS_DEPENDENCIES, native: async () => native, authority: () => { calls.push("authority"); throw new Error(); } });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), { challenge: "fixture-challenge" }); assert.deepEqual(calls, []);
  const bad = await signed({ ...payload, token: "bad" }); await assert.rejects(verifyFeishuAppRequest(native, bad.raw, bad.headers), error => error.status === 401);
});
test("tenant enable, stop and uninstall retain authenticated tenant identity; unknown status is rejected", async () => {
  for (const [type, status, active] of [["app_open", undefined, true], ["app_status_change", "start_by_tenant", true],
    ["app_status_change", "stop_by_tenant", false], ["app_status_change", "stop_by_platform", false], ["app_uninstalled", undefined, false]]) {
    const event = await feishuAppInteraction(lifecycle(type, { status })); assert.equal(event.active, active); assert.equal(event.tenantKey, "tenantA");
  }
  await assert.rejects(feishuAppInteraction(lifecycle("app_status_change", { status: "invented" })));
  await assert.rejects(feishuAppInteraction(message({}, { tenant_key: "../other" })));
});
test("bots and direct messages are ignored; private link capabilities never become message events", async () => {
  assert.equal(await feishuAppInteraction(message({ chat_type: "p2p" })), null);
  const bot = message(); bot.event.sender.sender_type = "app"; assert.equal(await feishuAppInteraction(bot), null);
  for (const text of ["@xMatrix link " + "N".repeat(32), "@_user_1 link " + "N".repeat(32), "copied link " + "N".repeat(32), "@xMatrix link invalid"]) {
    const event = await feishuAppInteraction(message({ content: JSON.stringify({ text }) }));
    assert.ok(["link", "invalid-link"].includes(event.kind)); assert.ok(!("event" in event));
  }
});
test("source and event identities preserve opaque case and tenant; bot removal identifies only its exact group", async () => {
  const first = await feishuAppInteraction(message()), other = await feishuAppInteraction(message({}, { tenant_key: "tenantB" }));
  assert.notEqual(first.event.eventId, other.event.eventId); assert.notEqual(first.event.sourceRef, other.event.sourceRef);
  const deleted = message({}, { event_type: "im.chat.member.bot.deleted_v1" }); deleted.event = { chat_id: "oc_AbCd" };
  assert.equal((await feishuAppInteraction(deleted)).chatSpace, "tenantA/oc_AbCd");
});
test("signed callbacks persist lifecycle only, nonce confirmation checks membership and does not deliver private content", async () => {
  const calls = [], deps = { ...FEISHU_INGRESS_DEPENDENCIES, native: async () => native,
    authority: () => ({ acceptTicket: async value => calls.push(["ticket", value]), applyTenant: async value => calls.push(["tenant", value]) }),
    rooms: () => ({ confirm: async value => calls.push(["confirm", value]), remove: async value => calls.push(["remove", value]) }),
    client: () => ({ getChat: async value => calls.push(["membership", value]) }), deliver: async () => calls.push(["deliver"]) };
  for (const payload of [lifecycle(), lifecycle("app_open"), message({ content: JSON.stringify({ text: "@xMatrix link " + "N".repeat(32) }) })]) {
    const f = await signed(payload); assert.equal((await handleFeishuAppDelivery({}, f.request(), deps)).status, 200);
  }
  assert.deepEqual(calls.map(call => call[0]), ["ticket", "tenant", "membership", "confirm"]);
});
test("grant revocation before append prevents delivery and acknowledgement; failed authority remains retryable", async () => {
  let live = true, appended = 0, automated = 0;
  const deps = { ...FEISHU_INGRESS_DEPENDENCIES, native: async () => native, authority: () => ({}), apps: () => ({}),
    rooms: () => ({ route: async () => ({ connectionId: "s:feishu", spaceId: "s", chatSpace: "tenantA/oc_AbCd", grantGeneration: "fixture" }), current: async () => live }),
    deliver: async (_env, _apps, append) => { live = false; const response = await append(); if (!response.ok) throw new Error("commit refused"); },
    append: async () => { appended++; return new Response(); }, automate: async () => { automated++; } };
  const f = await signed(message()), result = await handleFeishuAppDelivery({}, f.request(), deps);
  assert.equal(result.status, 503); assert.equal(appended, 0); assert.equal(automated, 0);
  const ticket = await signed(lifecycle());
  const fail = await handleFeishuAppDelivery({}, ticket.request(), { ...deps, authority: () => ({ acceptTicket: async () => { throw new Error("private-ticket"); } }) });
  assert.equal(fail.status, 503); assert.doesNotMatch(await fail.text(), /private-ticket/);
});
