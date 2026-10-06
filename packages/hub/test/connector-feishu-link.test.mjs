import assert from "node:assert/strict";
import { test } from "node:test";
import { telegramChatId } from "@xmatrix/db";
import { ProviderRequestError } from "../src/connectors/http.ts";
import { Hono } from "hono";
import { feishuRoom, feishuSource } from "../src/connectors/feishu-native.ts";
import { HUB_ROUTES } from "@xmatrix/protocol";
import { compileCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
const groupModule = await compileCommonJsSourceModule(new URL("../src/index-routes-group-link.ts", import.meta.url));
const telegramModule = await compileCommonJsSourceModule(new URL("../src/index-routes-telegram.ts", import.meta.url));
const routeModule = await compileCommonJsSourceModule(new URL("../src/index-routes-feishu.ts", import.meta.url));
function fixture(provider = "feishu") {
  const calls = [], state = { agent: false, denied: false, membership: true };
  const imports = { "@xmatrix/protocol": { HUB_ROUTES }, "./index-shared": { requireAuth: async () => ({ agentRun: state.agent }),
    requireHumanAuth: () => ({ id: "owner" }), requestErrorStatus: error => error.status ?? 500,
    readBoundedRequestBody: async (request, max) => { const bytes = new Uint8Array(await request.arrayBuffer()); return bytes.length <= max ? bytes : undefined; } },
    "./connectors/credentials": { connectorCredentialRepository: () => ({ readGenerated: async () => { calls.push(["admin"]); if (state.denied) throw Object.assign(new Error("private"), { status: 404 }); } }),
      connectorFeishuRoomRepository: () => ({ begin: async input => { calls.push(["begin", input]); return { chatSpace: input.chatSpace, nonce: "N".repeat(32), expiresAt: new Date(Date.now()+180000).toISOString() }; },
        list: async () => [{ chatSpace: "tenantA/oc_AbCd", grantGeneration: "private" }], unlink: async input => calls.push(["unlink", input]) }) },
    "./connectors/feishu-native": { feishuRoom, feishuSource, feishuNativeApp: async () => ({ app: { appId: "fixture" } }),
      feishuStoreClient: () => ({ getChat: async room => { calls.push(["membership", room]); if (!state.membership) throw Object.assign(new Error("private-token"), { status: 403 }); } }) } };
  imports["./index-routes-group-link"] = groupModule(name => imports[name]);
  imports["./connectors/http"] = { ProviderRequestError };
  imports["@xmatrix/db"] = { telegramChatId };
  imports["./connectors/credentials"].connectorTelegramRoomRepository = imports["./connectors/credentials"].connectorFeishuRoomRepository;
  imports["./connectors/telegram-native"] = { telegramNativeApp: async () => ({ app: { botId: "123456" } }),
    telegramSource: room => `telegram:${room}`, telegramBotClient: () => ({ getChat: async room => { calls.push(["membership", room]); return { username: "xMatrixFixtureBot" }; } }) };
  const app = new Hono();
  if (provider === "telegram") telegramModule(name => imports[name]).registerTelegramRoutes(app);
  else routeModule(name => imports[name]).registerFeishuRoutes(app);
  const request = (method, body) => app.request((provider === "telegram" ? HUB_ROUTES.space_app_connection_telegram_link : HUB_ROUTES.space_app_connection_feishu_link)("chosen-space"), { method, ...(body && method !== "GET" ? { body: JSON.stringify(body) } : {}) }, {});
  return { calls, state, request };
}
test("native Feishu link read, initiation and unlink require current Human Space admin before shared app use", async () => {
  for (const mode of ["agent", "denied"]) for (const method of ["GET", "POST", "DELETE"]) {
    const f = fixture(); f.state[mode] = true; const response = await f.request(method, { tenantKey: "tenantA", chatId: "oc_AbCd" });
    assert.equal(response.status, mode === "agent" ? 403 : 404); assert.ok(f.calls.every(call => call[0] === "admin"));
  }
});
test("selector values choose the fixed tenant/group check only; arbitrary Space, nonce and unknown metadata are refused", async () => {
  const f = fixture(), response = await f.request("POST", { tenantKey: "tenantA", chatId: "oc_AbCd" });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(f.calls.map(call => call[0]), ["admin", "membership", "begin"]); assert.equal(f.calls[2][1].spaceId, "chosen-space");
  for (const body of [{ tenantKey: "tenantA", chatId: "oc_AbCd", spaceId: "other" }, { tenantKey: "../other", chatId: "oc_AbCd" },
    { tenantKey: "tenantA", chatId: "oc_AbCd", nonce: "caller" }]) {
    const bad = fixture(); assert.equal((await bad.request("POST", body)).status, 400); assert.deepEqual(bad.calls, [["admin"]]);
  }
});
test("private room inspection exposes bounded subscription projections, not tickets, grants or shared credentials", async () => {
  const f = fixture(), response = await f.request("GET"); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { bindings: [{ chatSpace: "tenantA/oc_AbCd", sourceRef: await feishuSource("tenantA/oc_AbCd") }] });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("unlink is a Human primary grant action without a provider write or an inferred bot removal", async () => {
  const f = fixture(); assert.equal((await f.request("DELETE", { tenantKey: "tenantA", chatId: "oc_AbCd" })).status, 200);
  assert.deepEqual(f.calls.map(call => call[0]), ["admin", "unlink"]); assert.equal(f.calls[1][1].spaceId, "chosen-space");
  const denied = fixture(); denied.state.membership = false; const result = await denied.request("POST", { tenantKey: "tenantA", chatId: "oc_AbCd" });
  assert.equal(result.status, 403); assert.doesNotMatch(await result.text(), /private-token|N{32}/);
});

test("Telegram native group links are Human-admin only, exact negative group IDs and private bot-addressed challenges", async () => {
  for (const flag of ["agent", "denied"]) {
    const rejected = fixture("telegram"); rejected.state[flag] = true;
    assert.equal((await rejected.request("POST", { chatId: "-100123" })).status, flag === "agent" ? 403 : 404);
    assert.ok(!rejected.calls.some(call => call[0] === "membership"));
  }
  const f = fixture("telegram"), result = await f.request("POST", { chatId: "-100123" });
  assert.equal(result.status, 200); assert.equal(result.headers.get("cache-control"), "private, no-store");
  assert.equal((await result.json()).botUsername, "xMatrixFixtureBot");
  for (const payload of [{ chatId: "100123" }, { chatId: "-100123", spaceId: "caller" }, { chatId: "-100123", botUsername: "caller" }]) {
    const invalid = fixture("telegram"); assert.equal((await invalid.request("POST", payload)).status, 400);
    assert.ok(!invalid.calls.some(call => call[0] === "membership"));
  }
});
