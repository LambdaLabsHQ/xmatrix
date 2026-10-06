import assert from "node:assert/strict";
import { test } from "node:test";
import { feishuNativeApp, feishuStoreClient, feishuActionCapability, verifyFeishuNativeConnection, feishuSource,
  FEISHU_NATIVE_DEPENDENCIES } from "../src/connectors/feishu-native.ts";

const config = { CONNECTOR_FEISHU_APP_ID: "cli_fixture1234", CONNECTOR_FEISHU_APP_SECRET: "fixture-app-secret",
  CONNECTOR_FEISHU_VERIFICATION_TOKEN: "fixture-verification", CONNECTOR_FEISHU_ENCRYPT_KEY: "fixture-encryption" };
const native = await feishuNativeApp(config);
const binding = { connectionId: "s:feishu", spaceId: "s", chatSpace: "tenantA/oc_AbCd", grantGeneration: "fixture-grant" };
function fixture() {
  const calls = [], state = { active: true, current: true, membership: true, policy: true, manual: false, missingTicket: false, badToken: false, badReceipt: false };
  const authority = { assertTenant: async input => { calls.push(["tenant", input.tenantKey]); if (!state.active) throw Object.assign(new Error("retired"), { status: 409 }); },
    ticket: async () => { if (state.missingTicket) throw Object.assign(new Error("ticket"), { code: "feishu_ticket_missing" }); return "fixture-ticket"; } };
  const rooms = { list: async () => [binding], current: async () => state.current, resolve: async () => binding };
  const request = async (url, init) => {
    calls.push(["request", url, init]);
    if (url.endsWith("app_ticket/resend")) return { code: 0 };
    if (url.endsWith("app_access_token")) return { code: 0, app_access_token: "fixture-app-token", expire: state.badToken ? 0 : 7200 };
    if (url.endsWith("tenant_access_token")) return { code: 0, tenant_access_token: "fixture-tenant-token", expire: 7200 };
    if (url.endsWith("is_in_chat")) return { code: 0, data: { is_in_chat: state.membership } };
    return { code: 0, data: { message_id: "om_fixtureMessage", chat_id: state.badReceipt ? "oc_other" : "oc_AbCd" } };
  };
  const deps = { ...FEISHU_NATIVE_DEPENDENCIES, app: async () => native, apps: () => authority, rooms: () => rooms,
    credentials: () => ({ resolve: async () => state.manual ? { values: { appId: "manual" } } : null }), request };
  const authorize = async () => { calls.push(["policy"]); if (!state.policy) throw Object.assign(new Error("policy"), { status: 403 }); };
  return { calls, state, deps, authorize, client: feishuStoreClient({}, native, deps) };
}
const writes = f => f.calls.filter(call => call[0] === "request" && call[1].includes("im/v1/messages"));
test("company credentials are atomic, app-bound, bounded and absent is explicit", async () => {
  assert.equal(await feishuNativeApp({}), undefined);
  for (const [key] of Object.entries(config)) {
    const partial = { ...config }; delete partial[key]; await assert.rejects(feishuNativeApp(partial), error => error.status === 503);
    await assert.rejects(feishuNativeApp({ ...config, [key]: "bad\nvalue" }), error => error.status === 503);
  }
  const rotated = await feishuNativeApp({ ...config, CONNECTOR_FEISHU_APP_SECRET: "rotated-fixture-secret" });
  assert.notEqual(native.app.eventKeyDigest, rotated.app.eventKeyDigest);
  assert.notEqual(await feishuSource("tenantA/oc_AbCd"), await feishuSource("tenantA/oc_abcd"));
  assert.notEqual(await feishuSource("tenantA/oc_AbCd"), await feishuSource("tenantB/oc_AbCd"));
});
test("ISV authentication uses only primary ticket and tenant identity then checks bot membership", async () => {
  const f = fixture(); await f.client.getChat(binding.chatSpace);
  const requests = f.calls.filter(call => call[0] === "request");
  assert.deepEqual(requests.map(call => new URL(call[1]).pathname), ["/open-apis/auth/v3/app_access_token", "/open-apis/auth/v3/tenant_access_token", "/open-apis/im/v1/chats/oc_AbCd/members/is_in_chat"]);
  assert.equal(requests[0][2].json.app_ticket, "fixture-ticket"); assert.equal(requests[1][2].json.tenant_key, "tenantA");
  assert.ok(requests.every(call => call[2].signal instanceof AbortSignal));
  assert.ok(!requests.some(call => call[1].includes("internal")));
});
test("missing signed ticket resends once and fails without requesting any API token", async () => {
  const f = fixture(); f.state.missingTicket = true;
  await assert.rejects(f.client.getChat(binding.chatSpace), error => error.status === 503);
  assert.equal(f.calls.filter(call => call[0] === "request").length, 1);
  assert.match(f.calls.find(call => call[0] === "request")[1], /app_ticket\/resend$/);
});
test("inactive tenant, negative membership or malformed token cannot send", async () => {
  for (const [key, value] of [["active", false], ["membership", false], ["badToken", true]]) {
    const f = fixture(); f.state[key] = value;
    await assert.rejects(f.client.sendMessage(binding.chatSpace, "fixture message", f.authorize)); assert.equal(writes(f).length, 0);
  }
});
test("native send is one exact bound group capability, never a raw bot or cross-group/tenant writer", async () => {
  const f = fixture(), cap = await feishuActionCapability({}, "s", f.authorize, f.deps);
  assert.deepEqual(Object.keys(cap), ["sendMessage"]);
  await assert.rejects(cap.sendMessage("oc_other", "no"), error => error.status === 403);
  assert.equal(f.calls.length, 0);
  await cap.sendMessage("oc_AbCd", "fixture message"); assert.equal(writes(f).length, 1);
  assert.equal(writes(f)[0][2].json.receive_id, "oc_AbCd");
  assert.equal(f.calls.filter(call => call[0] === "policy").length, 2);
});
test("grant and policy changes immediately before write are checked again", async () => {
  for (const failure of ["current", "policy", "active"]) {
    const f = fixture(), original = f.deps.request;
    f.deps.request = async (...args) => { const result = await original(...args); if (args[0].endsWith("is_in_chat")) f.state[failure] = false; return result; };
    const cap = await feishuActionCapability({}, "s", f.authorize, f.deps);
    await assert.rejects(cap.sendMessage("oc_AbCd", "fixture message")); assert.equal(writes(f).length, 0);
  }
});
test("ambiguous write receipt is not retried; mentions and control characters are rejected before provider access", async () => {
  const f = fixture(); f.state.badReceipt = true;
  await assert.rejects(f.client.sendMessage(binding.chatSpace, "fixture message", f.authorize), /check the group before retrying/);
  assert.equal(writes(f).length, 1);
  for (const message of ['<at user_id="all">everyone</at>', ...[0, 8, 11, 12, 14, 31, 127].map(code => "text" + String.fromCharCode(code))]) {
    const blocked = fixture(); await assert.rejects(blocked.client.sendMessage(binding.chatSpace, message, blocked.authorize));
    assert.equal(blocked.calls.length, 0);
  }
  const formatted = fixture(); await formatted.client.sendMessage(binding.chatSpace, "first\tcolumn\r\nsecond line", formatted.authorize);
  assert.equal(writes(formatted).length, 1);
});
test("manual configuration is an explicit path; empty native room set never falls back", async () => {
  const f = fixture(); f.state.manual = true;
  assert.equal(await feishuActionCapability({}, "s", f.authorize, f.deps), undefined);
  assert.equal(await verifyFeishuNativeConnection({}, "s", f.deps), false);
  f.state.manual = false; f.deps.rooms = () => ({ list: async () => [] });
  await assert.rejects(feishuActionCapability({}, "s", f.authorize, f.deps), error => error.status === 409);
  await assert.rejects(verifyFeishuNativeConnection({}, "s", f.deps), error => error.status === 409);
});
test("Check confirms every bound group and rejects an unavailable or replaced grant", async () => {
  const f = fixture(); assert.equal(await verifyFeishuNativeConnection({}, "s", f.deps), true);
  f.state.membership = false; await assert.rejects(verifyFeishuNativeConnection({}, "s", f.deps));
  f.state.membership = true; f.deps.rooms = () => ({ list: async () => [binding], resolve: async () => ({ ...binding, grantGeneration: "changed" }) });
  await assert.rejects(verifyFeishuNativeConnection({}, "s", f.deps), /changed during Check/);
});
