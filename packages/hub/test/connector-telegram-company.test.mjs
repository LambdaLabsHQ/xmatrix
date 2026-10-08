import assert from "node:assert/strict";
import { test } from "node:test";
import { telegramNativeApp, telegramBotClient, telegramActionCapability, verifyTelegramNativeConnection, TELEGRAM_NATIVE_DEPENDENCIES } from "../src/connectors/telegram-native.ts";
import { telegramAppInteraction, verifyTelegramAppRequest } from "../src/connectors/telegram-app-events.ts";
import { handleTelegramAppDelivery, TELEGRAM_INGRESS_DEPENDENCIES } from "../src/connectors/telegram-ingress.ts";
const env = { HUB_URL: "https://hub.example.test", CONNECTOR_TELEGRAM_BOT_TOKEN: `123456:${"a".repeat(35)}`, CONNECTOR_TELEGRAM_WEBHOOK_SECRET: "fixture_header_".repeat(4) };
const native = await telegramNativeApp(env), chatSpace = "-100123456789", binding = { connectionId: "s:telegram", spaceId: "s", chatSpace, grantGeneration: "fixture" };
function fixture() {
  const calls = [], state = { member: true, admin: true, live: true, manual: false, identity: true, receipt: true, webhook: true };
  const request = async (url, { json }) => {
    const method = url.slice(url.lastIndexOf("/")+1); calls.push(method);
    const bot = { id: state.identity ? 123456 : 654321, is_bot: true, username: "xMatrixFixtureBot" }, chat = { id: Number(chatSpace), type: "supergroup" };
    const result = { getMe: bot, getChat: chat, getChatMember: { user: bot, status: state.member ? "member" : "left" },
      getChatAdministrators: [{ user: { id: 888, is_bot: false }, status: state.admin ? "administrator" : "member" }],
      getWebhookInfo: { url: state.webhook ? `${env.HUB_URL}/api/connectors/telegram/events` : "https://wrong.test", allowed_updates: ["my_chat_member", "message"] },
      sendMessage: { chat: { id: state.receipt ? chat.id : -222 }, message_id: 1, text: json.text } }[method];
    assert.ok(result, method); return { ok: true, result };
  };
  const rooms = { list: async () => [binding], current: async () => state.live, resolve: async () => state.live ? binding : null };
  const deps = { ...TELEGRAM_NATIVE_DEPENDENCIES, app: async () => native, request, rooms: () => rooms, credentials: () => ({ resolve: async () => state.manual ? {} : null }) };
  return { state, calls, deps, client: telegramBotClient(env, native, deps) };
}
test("Telegram atomic credentials fence rotation and reject unsafe bot identities", async () => {
  assert.equal(await telegramNativeApp({}), undefined);
  for (const field of ["CONNECTOR_TELEGRAM_BOT_TOKEN", "CONNECTOR_TELEGRAM_WEBHOOK_SECRET"]) for (const value of [undefined, "unsafe\nvalue"]) await assert.rejects(telegramNativeApp({ ...env, [field]: value }), { status: 503 });
  await assert.rejects(telegramNativeApp({ ...env, CONNECTOR_TELEGRAM_BOT_TOKEN: `9999999999999999:${"a".repeat(35)}` }), { status: 503 });
  assert.notEqual((await telegramNativeApp({ ...env, CONNECTOR_TELEGRAM_WEBHOOK_SECRET: "new_fixture_".repeat(4) })).app.eventKeyDigest, native.app.eventKeyDigest);
});
test("Telegram delivery authentication is bot/token-bound and independent of the stored app fingerprint", async () => {
  const replacement = await telegramNativeApp({ ...env, CONNECTOR_TELEGRAM_BOT_TOKEN: `654321:${"b".repeat(35)}` });
  assert.notEqual(native.secret, native.app.eventKeyDigest);
  assert.notEqual(native.secret, env.CONNECTOR_TELEGRAM_WEBHOOK_SECRET);
  const staleHeader = new Headers({ "x-telegram-bot-api-secret-token": native.secret });
  await assert.rejects(verifyTelegramAppRequest(replacement.secret, staleHeader), { status: 401 });
  await assert.rejects(verifyTelegramAppRequest(native.secret, new Headers({ "x-telegram-bot-api-secret-token": env.CONNECTOR_TELEGRAM_WEBHOOK_SECRET })), { status: 401 });
  await verifyTelegramAppRequest(replacement.secret, new Headers({ "x-telegram-bot-api-secret-token": replacement.secret }));
  const refreshedToken = await telegramNativeApp({ ...env, CONNECTOR_TELEGRAM_BOT_TOKEN: `123456:${"b".repeat(35)}` });
  assert.notEqual(refreshedToken.secret, native.secret);
});
test("Telegram private confirmation proves current bot membership and human group administrator", async () => {
  const good = fixture(); await good.client.confirmAdministrator(chatSpace, 888, "xmatrixfixturebot");
  assert.deepEqual(good.calls, ["getMe", "getChat", "getChatMember", "getChatAdministrators"]);
  for (const failure of ["member", "admin", "identity"]) {
    const f = fixture(); f.state[failure] = false; await assert.rejects(f.client.confirmAdministrator(chatSpace, 888, "xMatrixFixtureBot"));
    assert.ok(!f.calls.includes("sendMessage"));
  }
});
test("Telegram typed send rejects other groups and rechecks grants after membership API", async () => {
  const f = fixture(); let policies = 0;
  const cap = await telegramActionCapability(env, "s", async () => { policies++; }, f.deps);
  assert.deepEqual(Object.keys(cap), ["sendMessage"]);
  await assert.rejects(cap.sendMessage("-999", "no"), { status: 403 }); assert.equal(f.calls.length, 0);
  await cap.sendMessage(chatSpace, "plain fixture"); assert.equal(policies, 2); assert.equal(f.calls.filter(x => x === "sendMessage").length, 1);
  const revoked = fixture(), original = revoked.deps.request;
  revoked.deps.request = async (...args) => { const result = await original(...args); if (args[0].endsWith("getChatMember")) revoked.state.live = false; return result; };
  const restricted = await telegramActionCapability(env, "s", async () => {}, revoked.deps);
  await assert.rejects(restricted.sendMessage(chatSpace, "revoked"), { status: 409 }); assert.ok(!revoked.calls.includes("sendMessage"));
});
test("Telegram Check requires deployed webhook; manual credentials stay separate; ambiguous writes are not retried", async () => {
  const f = fixture(); assert.equal(await verifyTelegramNativeConnection(env, "s", f.deps), true);
  f.state.webhook = false; await assert.rejects(verifyTelegramNativeConnection(env, "s", f.deps), { status: 409 });
  f.state.manual = true; assert.equal(await verifyTelegramNativeConnection(env, "s", f.deps), false);
  assert.equal(await telegramActionCapability(env, "s", async () => {}, f.deps), undefined);
  const bad = fixture(); bad.state.receipt = false; await assert.rejects(bad.client.sendMessage(chatSpace, "once", async () => {}), { status: 502 });
  await assert.rejects(bad.client.sendMessage(chatSpace, "bad\u0000", async () => {}), { status: 400 }); assert.equal(bad.calls.filter(x => x === "sendMessage").length, 1);
});
const update = (changes = {}) => ({ update_id: 12, message: { chat: { id: Number(chatSpace), type: "supergroup" }, date: Math.floor(Date.now()/1000), message_id: 44, from: { id: 888, is_bot: false }, text: "hello", ...changes } });
const normalize = payload => telegramAppInteraction(JSON.stringify(payload), native.app.botId);
test("Telegram header authentication and private commands never expose a nonce in Channel content", async () => {
  await assert.rejects(verifyTelegramAppRequest(native.secret, new Headers()), { status: 401 });
  await verifyTelegramAppRequest(native.secret, new Headers({ "X-Telegram-Bot-Api-Secret-Token": native.secret }));
  const command = `/xmatrix_link@xMatrixFixtureBot ${"n".repeat(32)}`; assert.equal(normalize(update({ text: command })).kind, "link");
  for (const text of [`copied ${command}`, "/xmatrix_link invalid", `/xmatrix_link@other ${"n".repeat(31)}`]) assert.equal(normalize(update({ text })), undefined);
  for (const change of [{ from: { id: 888, is_bot: true } }, { sender_chat: { id: -222 } }, { date: 1 }, { chat: { id: 888, type: "private" } }, { chat: { id: Number(chatSpace), type: "channel" } }]) assert.equal(normalize(update(change)), undefined);
  assert.equal(normalize(update()).event.sourceRef, `telegram:${chatSpace}`);
  assert.equal(normalize({ update_id: 12, edited_message: update().message }), undefined);
  assert.equal(normalize(update({ migrate_to_chat_id: -1234 })).kind, "removed");
});
test("Telegram removal affects only the selected bot; joining never regrants", () => {
  const change = { update_id: 12, my_chat_member: { chat: update().message.chat, date: update().message.date, new_chat_member: { user: { id: 123456, is_bot: true }, status: "kicked" } } };
  assert.equal(normalize(change).kind, "removed"); change.my_chat_member.new_chat_member.status = "member"; assert.equal(normalize(change), undefined);
  change.my_chat_member.new_chat_member.status = "left"; change.my_chat_member.new_chat_member.user.id = 999999; assert.equal(normalize(change), undefined);
});
test("Telegram ingress rejects unauthenticated parsing and retries failed durable delivery without Automation", async () => {
  const effects = [], deps = { ...TELEGRAM_INGRESS_DEPENDENCIES, native: async () => native, rooms: () => ({ confirm: async () => effects.push("confirmed"), route: async () => binding, current: async () => true }),
    client: () => ({ confirmAdministrator: async () => effects.push("administrator") }), apps: () => ({}), deliver: async () => { effects.push("delivery"); throw Error("commit failed"); }, automate: async () => effects.push("automation") };
  const request = payload => new Request("https://hub.example.test", { method: "POST", headers: { "x-telegram-bot-api-secret-token": native.secret }, body: JSON.stringify(payload) });
  assert.equal((await handleTelegramAppDelivery(env, new Request("https://hub.example.test", { method: "POST", body: "bad JSON" }), deps)).status, 401); assert.deepEqual(effects, []);
  assert.equal((await handleTelegramAppDelivery(env, request(update({ text: `/xmatrix_link@xMatrixFixtureBot ${"n".repeat(32)}` })), deps)).status, 200);
  assert.equal((await handleTelegramAppDelivery(env, request(update()), deps)).status, 503); assert.deepEqual(effects, ["administrator", "confirmed", "delivery"]);
});
