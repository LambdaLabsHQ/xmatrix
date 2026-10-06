import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyTelegram, TELEGRAM_ACTIONS } from "../src/connectors/actions/chat-webhooks.ts";
import { connectorProvider } from "../src/connectors/registry.ts";
const token = "123456789:fixture_bot_token_123456789";

async function withProvider(response, callback) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200 });
  };
  try { await callback(calls); } finally { globalThis.fetch = original; }
}

test("Telegram Check verifies the bot on the official read-only API", async () => {
  assert.equal(connectorProvider("telegram").verify, verifyTelegram);
  await withProvider({ body: { ok: true, result: { id: 123456789, is_bot: true } } }, async calls => {
    await verifyTelegram({ botToken: token });
    assert.deepEqual(calls, [{ url: `https://api.telegram.org/bot${token}/getMe`, method: "GET", body: undefined }]);
  });
});

test("rejected tokens, user identities, malformed success payloads and malformed token paths fail", async () => {
  for (const response of [
    { status: 401, body: { ok: false } }, { body: { ok: false } }, { body: { ok: true } },
    ...[{ id: 1, is_bot: false }, { id: "123", is_bot: true }, { id: 0, is_bot: true }, { id: 1.5, is_bot: true }]
      .map(result => ({ body: { ok: true, result } })),
  ]) await withProvider(response, async calls => {
    await assert.rejects(verifyTelegram({ botToken: token }));
    assert.equal(calls.length, 1);
  });
  for (const invalid of ["", "1:abc", `${token}/getUpdates`, `${token}?method=sendMessage`, "https://foreign.test"]) {
    await withProvider({}, async calls => {
      await assert.rejects(verifyTelegram({ botToken: invalid }), /malformed/);
      assert.equal(calls.length, 0);
      await assert.rejects(TELEGRAM_ACTIONS.send.execute({ credentials: { botToken: invalid } }, { chat: "1", text: "test" }), /malformed/);
      assert.equal(calls.length, 0);
    });
  }
});
