import assert from "node:assert/strict";
import { test } from "node:test";
import { createCipheriv, createHash } from "node:crypto";
import {
  parseDingTalkSyncHTTP,
  dingtalkStructuredJson,
  verifyDingTalkSyncHTTP,
} from "../src/connectors/dingtalk-synchttp.ts";

const now = Date.now(),
  binding = { suiteId: "1234567", developerCorpId: "dingDeveloperFixture" };
const visible = {
  eventId: "scope-event",
  agentId: 458934,
  syncAction: "org_micro_app_scope_update",
  userVisibleScopes: '["MemberCase"]',
  deptVisibleScopes: '["1"]',
  syncSeq: "opaque-sequence",
};
const row = (extra = {}) => ({
  id: 7845,
  subscribe_id: "1234567_0",
  corp_id: "dingCompanyFixture",
  biz_id: "38576",
  biz_type: 7,
  biz_data: JSON.stringify(visible),
  gmt_modified: now,
  ...extra,
});
const source = (rows = [row()], extra = {}) =>
  JSON.stringify({ EventType: "SYNC_HTTP_PUSH_HIGH", bizData: rows, ...extra });
test("DingTalk SyncHTTP preserves complete explicit visible members, numeric app mapping, opaque sequence and exact subscription", () => {
  const events = parseDingTalkSyncHTTP(source(), binding, now);
  assert.deepEqual(events, [
    {
      kind: "visibility",
      eventTime: new Date(now).toISOString(),
      providerId: `1234567_0:7845:${now}`,
      scope: {
        corpId: "dingCompanyFixture",
        appId: 38576,
        agentId: 458934,
        users: ["MemberCase"],
        departments: ["1"],
      },
    },
  ]);
  assert.throws(() => parseDingTalkSyncHTTP(source(), { ...binding, suiteId: "suiteKeyIsNotNumeric" }, now), {
    status: 503,
  });
});
test("DingTalk signed SyncHTTP wrapper is authenticated as ciphertext with the configured suite receiver", () => {
  const key = Buffer.alloc(32, 5),
    suiteKey = "suitePublicFixture",
    token = "PublicToken",
    plaintext = Buffer.from(source());
  const length = Buffer.alloc(4);
  length.writeUInt32BE(plaintext.length);
  const raw = Buffer.concat([Buffer.alloc(16, 4), length, plaintext, Buffer.from(suiteKey)]),
    padding = 32 - (raw.length % 32);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypt = Buffer.concat([
    cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])),
    cipher.final(),
  ]).toString("base64");
  const timestamp = String(now),
    nonce = "public_nonce",
    signature = createHash("sha1").update([token, timestamp, nonce, encrypt].sort().join("")).digest("hex");
  const url = `https://hub.invalid?${new URLSearchParams({ timestamp, nonce, signature })}`;
  const native = {
    app: { suiteKey },
    token,
    aesKey: key.toString("base64").slice(0, -1),
  };
  assert.equal(verifyDingTalkSyncHTTP(native, url, encrypt, binding, now)[0].scope.users[0], "MemberCase");
  assert.throws(
    () => verifyDingTalkSyncHTTP({ ...native, app: { suiteKey: "otherSuite" } }, url, encrypt, binding, now),
    { status: 401 },
  );
  assert.throws(() => verifyDingTalkSyncHTTP(native, url, encrypt.slice(0, -4) + "AAAA", binding, now), {
    status: 401,
  });
});
test("DingTalk incomplete visibility, wrong priority, subscription, scope aliases and lossy ids fail closed", () => {
  for (const body of [
    { ...visible, userVisibleScopes: undefined },
    { ...visible, userVisibleScopes: ["MemberCase"] },
    { ...visible, deptVisibleScopes: "[1]" },
    { ...visible, userVisibleScopes: '["@ALL"]' },
    { ...visible, userVisibleScopes: '["MemberCase","MemberCase"]' },
  ])
    assert.throws(() => parseDingTalkSyncHTTP(source([row({ biz_data: JSON.stringify(body) })]), binding, now));
  for (const extra of [
    { subscribe_id: "suitePublicFixture_0" },
    { gmt_modified: now - 601000 },
    { biz_id: "9007199254740993" },
    { id: 1.5 },
    { corp_id: "" },
  ])
    assert.throws(() => parseDingTalkSyncHTTP(source([row(extra)]), binding, now));
  assert.throws(() => parseDingTalkSyncHTTP(source([row()], { EventType: "SYNC_HTTP_PUSH_MEDIUM" }), binding, now), {
    status: 503,
  });
  assert.throws(() => parseDingTalkSyncHTTP(source([row(), row()]), binding, now), { status: 401 });
  assert.throws(
    () =>
      parseDingTalkSyncHTTP(
        JSON.stringify({
          specversion: "1.0",
          type: "org_micro_app_scope_update",
          data: { agentId: 458934 },
        }),
        binding,
        now,
      ),
    { status: 401 },
  );
});
test("DingTalk nested duplicates, escaped aliases, unsafe integers, raw controls and malformed structures never become events", () => {
  for (const payload of [
    '{"EventType":"x","EventType":"y"}',
    '{"data":{"agentId":1,"agent\\u0049d":2}}',
    '{"n":9007199254740993}',
    '{"a":[1,]}',
    '{"a":1.1}',
    '{"a":"\\ud800"}',
    '{"a":"\u0000"}',
    '{"a":true} trailing',
    "\ufeff{}",
  ])
    assert.throws(() => dingtalkStructuredJson(payload));
  const prototype = dingtalkStructuredJson('{"__proto__":{"grant":true}}');
  assert.equal(Object.getPrototypeOf(prototype), null);
});
test("DingTalk native lifecycle binds exact suite/company and creates retirement only, without permanent-code proof", () => {
  for (const syncAction of ["org_suite_auth", "org_suite_change", "org_suite_relieve"]) {
    const event = row({
      biz_id: binding.suiteId,
      biz_type: 4,
      biz_data: JSON.stringify({
        syncAction,
        auth_corp_info: { corpid: "dingCompanyFixture" },
        permanent_code: "deprecated-not-authority",
      }),
    });
    assert.equal(parseDingTalkSyncHTTP(source([event]), binding, now)[0].kind, "retirement");
    assert.throws(() => parseDingTalkSyncHTTP(source([{ ...event, biz_id: "otherSuiteId" }]), binding, now), {
      status: 401,
    });
    event.biz_data = JSON.stringify({
      syncAction,
      auth_corp_info: { corpid: "dingOtherCompany" },
    });
    assert.throws(() => parseDingTalkSyncHTTP(source([event]), binding, now), {
      status: 401,
    });
  }
});
