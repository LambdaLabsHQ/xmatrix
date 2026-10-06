import assert from "node:assert/strict";
import { test } from "node:test";
import { dingtalkCompanyApi, dingtalkAuthorizedAgent } from "../src/connectors/dingtalk-company-api.ts";

const suite = {
  suiteKey: "suitePublicFixture",
  suiteSecret: "private_fixture_secret",
  ticket: "private_fixture_ticket",
};
const grant = {
  corpId: "dingFixtureCompany",
  appId: 2457,
  agentId: 9087,
  nativeAdminId: "NativeAdminFixture",
  members: ["MemberCase"],
};
function fixture(overrides = {}, readSuite = async () => suite, onRequest = async () => {}) {
  const calls = [];
  const native = {
    suiteAccessToken: { accessToken: "private_suite_token", expireIn: 7200 },
    corpAccessToken: { accessToken: "private_corp_token", expireIn: 7200 },
    authInfo: {
      authAppInfo: {
        agentList: [
          {
            appId: grant.appId,
            agentId: grant.agentId,
            adminList: ["NotAVisibleMember"],
          },
        ],
      },
      authCorpInfo: { corpName: "Company" },
    },
    personal: { accessToken: "private_personal_token", expireIn: 7200, corpId: grant.corpId, refreshToken: "must_not_persist" },
    own: { unionId: "OwnUnionFixture", mobile: "must_not_leak" },
    mapped: { errcode: 0, result: { userid: grant.nativeAdminId, contact_type: 0 } },
    admins: { errcode: 0, result: [{ userid: grant.nativeAdminId, sys_level: 1 }] },
    adminAccess: { result: true },
    scopes: {
      errcode: 0,
      auth_org_scopes: { authed_user: grant.members, authed_dept: [] },
      auth_user_field: ["userid", "name"],
    },
    user: {
      errcode: 0,
      result: {
        userid: "MemberCase",
        active: true,
        name: "Selected member",
        mobile: "must_not_leak",
      },
    },
    send: { errcode: 0, task_id: 3978 },
    ...overrides,
  };
  const api = dingtalkCompanyApi(
    readSuite,
    async (url, options) => {
      const parsed = new URL(url),
        key = parsed.pathname.endsWith("suiteAccessToken") ? "suiteAccessToken"
          : parsed.pathname.endsWith("corpAccessToken") ? "corpAccessToken"
          : parsed.pathname.endsWith("userAccessToken") ? "personal"
          : parsed.pathname.endsWith("users/me") ? "own"
          : parsed.pathname.endsWith("getbyunionid") ? "mapped"
          : parsed.pathname.endsWith("listadmin") ? "admins"
          : parsed.pathname.endsWith("adminAccess") ? "adminAccess"
          : parsed.pathname.endsWith("authInfo") ? "authInfo"
          : parsed.pathname.endsWith("scopes") ? "scopes"
          : parsed.pathname.endsWith("user/get") ? "user" : "send";
      calls.push({ url: parsed, options, key });
      await onRequest(key, options);
      if (native[key] instanceof Error) throw native[key];
      return native[key];
    },
  );
  return { api, calls };
}
test("DingTalk company adapter uses exact SDK suite-ticket requests and suite-token authInfo without a fictitious corpid", async () => {
  const { api, calls } = fixture();
  assert.deepEqual(await api.establish(grant.corpId, grant.appId, grant.members, async () => {}, grant.agentId, "one_use_code_fixture"), grant);
  assert.deepEqual(calls[0].options.json, {
    suiteKey: suite.suiteKey,
    suiteSecret: suite.suiteSecret,
    suiteTicket: suite.ticket,
  });
  assert.deepEqual(calls[1].options.json, {
    ...calls[0].options.json,
    authCorpId: grant.corpId,
  });
  assert.equal(calls[2].options.headers["x-acs-dingtalk-access-token"], "private_suite_token");
  assert.equal(calls[2].url.searchParams.get("authCorpId"), grant.corpId);
  assert.equal(calls.find(call => call.key === "scopes").url.searchParams.get("access_token"), "private_corp_token");
  assert.ok(
    calls.every(
      (call) => !["client_credentials", "permanent_code"].some((field) => JSON.stringify(call.options).includes(field)),
    ),
  );
});

for (const stage of ["authority", "credentials"]) {
  test(`DingTalk bounds stalled ${stage} reads and late resolution cannot start provider requests`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let release;
    const stalled = new Promise((resolve) => { release = resolve; });
    const { api, calls } = fixture({}, stage === "credentials" ? () => stalled : async () => suite);
    const result = api.check(grant, stage === "authority" ? () => stalled : async () => {});
    const rejected = assert.rejects(result, { status: 502, message: "DingTalk company operation did not complete" });
    await new Promise(setImmediate);
    t.mock.timers.tick(45_000);
    await rejected;
    release(stage === "credentials" ? suite : undefined);
    await new Promise(setImmediate);
    assert.equal(calls.length, 0);
  });
}

test("DingTalk read and send share the whole Check deadline rather than resetting it after token or member reads", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const action of ["read", "send"]) {
    const { api, calls } = fixture({}, async () => suite, async (key) => {
      if (key === "authInfo" || key === "scopes") t.mock.timers.tick(20_000);
      if (key === "user") t.mock.timers.tick(5_000);
    });
    const result = action === "read"
      ? api.readMember(grant, "MemberCase", async () => {})
      : api.sendTemplate(grant, "MemberCase", "text", { id: "approved_template", textField: "content" }, async () => {});
    await assert.rejects(result, { status: 502 });
    assert.equal(calls.filter((call) => call.key === "send").length, 0);
    assert.ok(calls.at(-1).options.signal.aborted);
  }
});

test("DingTalk aborts a timed-out ambiguous send once and does not retry or report late acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const stalled = new Promise((resolve) => { release = resolve; });
  const { api, calls } = fixture({}, async () => suite, async (key) => {
    if (key === "send") await stalled;
  });
  const sent = api.sendTemplate(grant, "MemberCase", "text", { id: "approved_template", textField: "content" }, async () => {});
  const rejected = assert.rejects(sent, { status: 502, message: "DingTalk company operation did not complete" });
  await new Promise(setImmediate);
  assert.equal(calls.at(-1).key, "send");
  t.mock.timers.tick(45_000);
  await rejected;
  assert.ok(calls.at(-1).options.signal.aborted);
  release();
  await new Promise(setImmediate);
  assert.equal(calls.filter((call) => call.key === "send").length, 1);
});
test("DingTalk rejects WeCom shapes, modern token fallback, duplicate agents and administrator-list membership", async () => {
  for (const payload of [
    { auth_info: { agent: [{ agentid: 9087, appid: 2457 }] } },
    {
      authAppInfo: {
        agentList: [
          { appId: 2457, agentId: 9087 },
          { appId: 2457, agentId: 9087 },
        ],
      },
    },
    { authAppInfo: { agentList: [{ appId: 2457, agentId: "9087" }] } },
  ])
    assert.throws(() => dingtalkAuthorizedAgent(payload, 2457), {
      status: 502,
    });
  await assert.rejects(
    fixture({
      corpAccessToken: { access_token: "alternate_token", expires_in: 7200 },
    }).api.check(grant, async () => {}),
    { status: 502 },
  );
  await assert.rejects(
    fixture({
      scopes: {
        errcode: 0,
        auth_org_scopes: {
          authed_user: ["NotAVisibleMember"],
          authed_dept: [1],
        },
        auth_user_field: ["userid", "name"],
      },
    }).api.check(grant, async () => {}),
    { status: 403 },
  );
  await assert.rejects(
    fixture({
      scopes: {
        errcode: 0,
        auth_org_scopes: { authed_user: grant.members },
        auth_user_field: ["userid"],
      },
    }).api.check(grant, async () => {}),
    { status: 403 },
  );
});
test("DingTalk read bounds private fields and resolves current authority after live native reads", async () => {
  const { api } = fixture();
  let current = 0;
  assert.deepEqual(
    await api.readMember(grant, "MemberCase", async () => {
      current++;
    }),
    { memberId: "MemberCase", name: "Selected member", active: true },
  );
  assert.ok(current >= 2);
  for (const user of [
    {
      errcode: 0,
      result: { userid: "membercase", active: true, name: "Wrong case" },
    },
    {
      errcode: 0,
      result: { userid: "MemberCase", active: false, name: "Inactive" },
    },
  ])
    await assert.rejects(
      fixture({ user }).api.check(grant, async () => {}),
      { status: 403 },
    );
});
test("DingTalk sends one approved template to one selected member, fences changed policy and never retries writes", async () => {
  const { api, calls } = fixture();
  let guard = 0;
  const sent = await api.sendTemplate(
    grant,
    "MemberCase",
    "status update",
    { id: "approved_template", textField: "content" },
    async () => {
      guard++;
    },
  );
  assert.ok(guard >= 2);
  assert.equal(sent.taskId, 3978);
  assert.match(sent.summary, /delivery is not confirmed/);
  assert.deepEqual(Object.fromEntries(calls.at(-1).options.body), {
    agent_id: String(grant.agentId),
    template_id: "approved_template",
    userid_list: "MemberCase",
    data: '{"content":"status update"}',
  });
  const fenced = fixture();
  await assert.rejects(
    fenced.api.sendTemplate(
      grant,
      "MemberCase",
      "text",
      { id: "approved_template", textField: "content" },
      async () => {
        throw Error("current grant changed");
      },
    ),
  );
  assert.equal(fenced.calls.length, 0);
  const failed = fixture({ send: Error("secret token and provider body") });
  await assert.rejects(
    failed.api.sendTemplate(
      grant,
      "MemberCase",
      "text",
      { id: "approved_template", textField: "content" },
      async () => {},
    ),
    (error) => error.status === 502 && !error.message.includes("secret"),
  );
  assert.equal(failed.calls.filter((call) => call.key === "send").length, 1);
  await assert.rejects(
    api.sendTemplate(grant, "@ALL", "text", { id: "approved_template", textField: "content" }, async () => {}),
    { status: 400 },
  );
});

test("DingTalk current authority fences before outbound reads and a mid-read revocation cannot issue a send", async () => {
  const denied = fixture();
  await assert.rejects(
    denied.api.readMember(grant, "MemberCase", async () => {
      throw Error("revoked");
    }),
  );
  assert.equal(denied.calls.length, 0);
  const mid = fixture();
  await assert.rejects(
    mid.api.sendTemplate(grant, "MemberCase", "text", { id: "approved_template", textField: "content" }, async () => {
      if (mid.calls.some((call) => call.key === "user")) throw Error("revoked");
    }),
  );
  assert.equal(mid.calls.filter((call) => call.key === "user").length, 1);
  assert.equal(mid.calls.filter((call) => call.key === "send").length, 0);
});

test("DingTalk resolves current suite credentials for each operation rather than retaining a ticket snapshot", async () => {
  let latest = { ...suite };
  const { api, calls } = fixture({}, async () => ({ ...latest }));
  await api.check(grant, async () => {});
  latest = { ...suite, ticket: "rotated_private_ticket" };
  await api.check(grant, async () => {});
  assert.deepEqual(
    calls.filter((call) => call.key === "corpAccessToken").map((call) => call.options.json.suiteTicket),
    [suite.ticket, latest.ticket],
  );
});


test("DingTalk native user proof binds selected company, internal own userid, current company and app administration before selected contact reads", async () => {
  const good = fixture();
  const result = await good.api.establish(grant.corpId, grant.appId, grant.members, async () => {}, grant.agentId, "one_use_code_fixture");
  assert.deepEqual(result, grant);
  const personal = good.calls.find(call => call.key === "personal");
  assert.deepEqual(personal.options.json, {clientId: suite.suiteKey, clientSecret: suite.suiteSecret, code: "one_use_code_fixture", grantType: "authorization_code"});
  assert.equal(good.calls.find(call => call.key === "own").options.headers["x-acs-dingtalk-access-token"], "private_personal_token");
  assert.equal(good.calls.find(call => call.key === "mapped").url.searchParams.get("access_token"), "private_corp_token");
  assert.equal(good.calls.find(call => call.key === "adminAccess").url.pathname, `/v1.0/microApp/apps/${grant.agentId}/users/${grant.nativeAdminId}/adminAccess`);
  assert.ok(!JSON.stringify(result).includes("Union") && !JSON.stringify(result).includes("token"));
  for (const rejected of [
    {personal: {accessToken:"private_personal_token",expireIn:7200,corpId:"dingOtherCompany"}},
    {personal: {accessToken:"private_personal_token",expireIn:7200}},
    {own: {openId:"not_a_unionid"}},
    {mapped: {errcode:0,result:{userid:grant.nativeAdminId,contact_type:1}}},
    {admins: {errcode:0,result:[{userid:"OtherAdmin",sys_level:1}]}},
    {admins: {errcode:0,result:[{userid:grant.nativeAdminId,sys_level:"1"}]}},
    {admins: {errcode:0,result:[{userid:grant.nativeAdminId,sys_level:1},{userid:grant.nativeAdminId,sys_level:2}]}},
    {adminAccess: {result:false}}, {adminAccess: {canAccess:"true"}},
  ]) {
    const f=fixture(rejected);
    await assert.rejects(f.api.establish(grant.corpId,grant.appId,grant.members,async()=>{},grant.agentId,"code_fixture"), {status:403});
    assert.equal(f.calls.filter(call=>["scopes","user","send"].includes(call.key)).length,0);
  }
});
test("DingTalk persisted native administrator demotion prevents Check, reads and sends independently of unchanged app authInfo", async () => {
  for(const method of ["check","readMember","sendTemplate"]) {
    const f=fixture({admins:{errcode:0,result:[]}}),current=async()=>{};
    await assert.rejects(method==="check"?f.api.check(grant,current):method==="readMember"?f.api.readMember(grant,"MemberCase",current):
      f.api.sendTemplate(grant,"MemberCase","text",{id:"approved",textField:"content"},current),{status:403});
    assert.equal(f.calls.filter(call=>["scopes","user","send"].includes(call.key)).length,0);
  }
});
