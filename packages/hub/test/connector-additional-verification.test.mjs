import { stubFetchResponses as stubFetch } from "./support/fetch-responses.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { connectorProvider } from "../src/connectors/registry.ts";
import { feishuTenantToken, feishuApiUrl } from "../src/connectors/feishu-api.ts";


test("Discord Check confirms a real bot using its authenticated current-user endpoint", async () => {
  const fetch = stubFetch([{ body: { id: "123456789012345678", bot: true } }]);
  try {
    await connectorProvider("discord").verify({ botToken: "fixture-token" });
    assert.equal(fetch.calls[0].url, "https://discord.com/api/v10/users/@me");
    assert.equal(fetch.calls[0].method, "GET");
    assert.equal(fetch.calls[0].headers.get("authorization"), "Bot fixture-token");
  } finally { fetch.restore(); }
  for (const response of [{ body: {} }, { body: { id: "123456789012345678", bot: false } }, { status: 401, body: { message: "unauthorized" } }]) {
    const fetch = stubFetch([response]);
    try { await assert.rejects(connectorProvider("discord").verify({ botToken: "fixture-token" })); }
    finally { fetch.restore(); }
  }
});

test("PagerDuty Check validates both account and personal keys without requesting an account profile", async () => {
  const fetch = stubFetch([{ body: { abilities: ["teams"] } }, { body: { abilities: [] } }]);
  try {
    await connectorProvider("pagerduty").verify({ apiKey: "fixture-account-key" });
    await connectorProvider("pagerduty").verify({ apiKey: "fixture-personal-key" });
    for (const call of fetch.calls) {
      assert.equal(call.url, "https://api.pagerduty.com/abilities");
      assert.equal(call.headers.get("accept"), "application/vnd.pagerduty+json;version=2");
      assert.equal(call.headers.has("from"), false);
      assert.equal(call.method, "GET");
    }
    assert.equal(fetch.calls[0].headers.get("authorization"), "Token token=fixture-account-key");
    await connectorProvider("pagerduty").verify({ webhookSecret: "fixture-hook" });
    assert.equal(fetch.calls.length, 2);
  } finally { fetch.restore(); }
  for (const response of [{ body: {} }, { body: { abilities: [123] } }, { status: 401, body: { error: "unauthorized" } }]) {
    const fetch = stubFetch([response]);
    try { await assert.rejects(connectorProvider("pagerduty").verify({ apiKey: "fixture-key" })); }
    finally { fetch.restore(); }
  }
});

test("Feishu Check validates an app pair without sending a message and preserves event-only setups", async () => {
  const fetch = stubFetch([{ body: { code: 0, tenant_access_token: "fixture-tenant-token" } }]);
  try {
    await connectorProvider("feishu").verify({ appId: "cli_fixture", appSecret: "fixture-secret" });
    assert.equal(fetch.calls[0].url, "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal");
    assert.equal(fetch.calls[0].method, "POST");
    assert.deepEqual(JSON.parse(fetch.calls[0].body), { app_id: "cli_fixture", app_secret: "fixture-secret" });
    await connectorProvider("feishu").verify({ verificationToken: "fixture-events" });
    await assert.rejects(connectorProvider("feishu").verify({ appId: "cli_fixture" }));
    assert.equal(fetch.calls.length, 1);
  } finally { fetch.restore(); }
  for (const body of [{ code: 99991663, msg: "invalid" }, { code: 0, tenant_access_token: "" }, { code: 0 }]) {
    const fetch = stubFetch([{ body }]);
    try { await assert.rejects(feishuTenantToken({ appId: "cli_fixture", appSecret: "fixture-secret" })); }
    finally { fetch.restore(); }
  }
});

test("Feishu and Lark never send the app secret to a caller-supplied foreign origin", async () => {
  const credentials = { appId: "cli_fixture", appSecret: "fixture-secret" };
  const fetch = stubFetch([]);
  try {
    for (const apiBase of ["https://attacker.test", "http://open.feishu.cn", "https://open.feishu.cn.attacker.test", "https://secret@open.feishu.cn", "https://open.feishu.cn/path", "https://open.feishu.cn?query=x", "https://open.feishu.cn#fragment"]) {
      await assert.rejects(feishuTenantToken({ ...credentials, apiBase }));
      const send = connectorProvider("feishu").actions.send;
      await assert.rejects(send.execute({ credentials: { ...credentials, apiBase } }, { chat: "oc_fixture", text: "test" }));
    }
    assert.equal(fetch.calls.length, 0);
    assert.equal(feishuApiUrl({ apiBase: "https://open.larksuite.com/" }, "auth/v3/tenant_access_token/internal").origin, "https://open.larksuite.com");
  } finally { fetch.restore(); }
});

test("Lark sends with the same validated official origin and authenticated tenant token", async () => {
  const fetch = stubFetch([{ body: { code: 0, tenant_access_token: "fixture-tenant-token" } }, { body: { code: 0 } }]);
  try {
    await connectorProvider("feishu").actions.send.execute({ credentials: { apiBase: "https://open.larksuite.com", appId: "cli_fixture", appSecret: "fixture-secret" } }, { chat: "oc_fixture", text: "hello" });
    for (const call of fetch.calls) assert.equal(new URL(call.url).origin, "https://open.larksuite.com");
    assert.equal(fetch.calls[1].headers.get("authorization"), "Bearer fixture-tenant-token");
    assert.equal(new URL(fetch.calls[1].url).searchParams.get("receive_id_type"), "chat_id");
  } finally { fetch.restore(); }
});
