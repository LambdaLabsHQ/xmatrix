import assert from "node:assert/strict";
import { connectorDatabase, integration } from "./postgres-database.fixture.mjs";
import {
  PostgresDingTalkInstallRepository,
  PostgresDingTalkCompanyRepository,
  PostgresDingTalkVisibilityRepository,
  dingtalkAppIdentity,
  dingtalkRecipientRef,
} from "../dist/index.js";

const changed = (error) => error.status === 409,
  corrupt = (error) => error.code === "secret_authority_corrupt";
async function fixture(run) {
  const { client, database, sql } = await connectorDatabase("dingtalk-company-boundary");
  const spaces = Array.from({ length: 2 }, () => "dt-company-" + crypto.randomUUID());
  const app = {
    suiteKey: "suite" + crypto.randomUUID().replaceAll("-", ""),
    eventKeyDigest: "a".repeat(64),
  };
  const identity = dingtalkAppIdentity(app),
    key = "private-encryption-test-key";
  const selection = {
    corpId: "dingPrivateTestCompany",
    appId: 43847,
    members: ["MemberCase", "membercase"],
  };
  const installs = new PostgresDingTalkInstallRepository(database, key),
    companies = new PostgresDingTalkCompanyRepository(database, key);
  const visibility = new PostgresDingTalkVisibilityRepository(database, key);
  const request = (extra) => ({
    requestId: crypto.randomUUID(),
    app,
    actorUserId: "owner",
    ...extra,
  });
  const time = async () => (await sql("SELECT clock_timestamp() AS at")).rows[0].at.toISOString();
  const visible = async (extra) =>
    visibility.accept(
      request({
        scope: {
          corpId: selection.corpId,
          appId: selection.appId,
          agentId: 989887,
          users: selection.members,
          departments: [],
        },
        eventTime: await time(),
        ...extra,
      }),
    );
  const begin = (n = 0, extra = {}) => installs.begin(request({ spaceId: spaces[n], selection, ...extra }));
  const prepare = async (n = 0) => {
    const attempt = await begin(n);
    await installs.take(request({ ...attempt, corpId: selection.corpId }));
    await installs.verify(request({ ...attempt, grant: { ...selection, agentId: 989887, nativeAdminId: "NativeAdminFixture" } }));
    return attempt;
  };
  const confirm = (attempt, n = 0, extra = {}) =>
    installs.confirm(request({ ...attempt, spaceId: spaces[n], confirmed: true, ...extra }));
  const resolve = (n = 0, extra = {}) => companies.resolve(request({ spaceId: spaces[n], ...extra }));
  try {
    for (const space of spaces) {
      await sql(
        `INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
        VALUES($1,'owner','owner',1,now(),now()),($1,'other','admin',1,now(),now())`,
        [space],
      );
      await sql(
        `INSERT INTO data.app_connector_connections(connection_id,space_id,provider_id,provider_name,status,
        auth_mode,scopes_json,secret_refs_json,capabilities_json,channel_ids_json,created_by,search_rank_sequence,version,created_at,updated_at)
        VALUES($1||':dingtalk',$1,'dingtalk','DingTalk','disconnected','api-token','[]','[]','[]','[]','owner',$1||':birth',1,now(),now())`,
        [space],
      );
    }
    await visible();
    await run({
      sql,
      database,
      spaces,
      app,
      identity,
      key,
      selection,
      installs,
      companies,
      visibility,
      visible,
      request,
      time,
      begin,
      prepare,
      confirm,
      resolve,
    });
  } finally {
    await sql("DELETE FROM data.app_dingtalk_company_fences WHERE app_identity=$1", [identity]);
    await sql("DELETE FROM data.app_dingtalk_company_visibility WHERE app_identity=$1", [identity]);
    for (const table of ["app_connector_connections", "space_members", "space_deletions"])
      await sql(`DELETE FROM data.${table} WHERE space_id=ANY($1::text[])`, [spaces]);
    await database.close?.();
    await client.end();
  }
}

integration(
  "DingTalk consent binds target company, app, original Human and connection; one competing take succeeds",
  async () =>
    fixture(async (f) => {
      const started = await f.begin();
      const row = (await f.sql("SELECT * FROM data.app_dingtalk_company_attempts WHERE space_id=$1", [f.spaces[0]]))
        .rows[0];
      assert.doesNotMatch(JSON.stringify(row), new RegExp(started.state + "|dingPrivateTestCompany|MemberCase"));
      assert.equal(row.expires_at - row.started_at, 600000);
      await assert.rejects(f.installs.take(f.request({ ...started, corpId: "dingOtherCorp" })), changed);
      await assert.rejects(
        f.installs.take(
          f.request({
            ...started,
            corpId: f.selection.corpId,
            actorUserId: "other",
          }),
        ),
        changed,
      );
      const result = await Promise.allSettled(
        [0, 1].map(() => f.installs.take(f.request({ ...started, corpId: f.selection.corpId }))),
      );
      assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
      assert.equal(result.filter((r) => r.status === "rejected").length, 1);
      await assert.rejects(
        f.installs.verify(
          f.request({
            ...started,
            grant: { ...f.selection, appId: 1, agentId: 2 },
          }),
        ),
        changed,
      );
      await f.installs.verify(f.request({ ...started, grant: { ...f.selection, agentId: 989887, nativeAdminId: "NativeAdminFixture" } }));
      await assert.rejects(f.confirm(started, 1), changed);
      await f.confirm(started);
      await assert.rejects(f.confirm(started), changed);
      assert.deepEqual((await f.resolve()).members, ["MemberCase", "membercase"]);
    }),
);
integration(
  "DingTalk ciphertext rejects restored phase, changed actor, key, company digest or grant generation",
  async () =>
    fixture(async (f) => {
      const attempt = await f.begin(),
        before = (
          await f.sql("SELECT encrypted_value_json FROM data.app_dingtalk_company_attempts WHERE space_id=$1", [
            f.spaces[0],
          ])
        ).rows[0];
      await f.installs.take(f.request({ ...attempt, corpId: f.selection.corpId }));
      await f.sql("UPDATE data.app_dingtalk_company_attempts SET encrypted_value_json=$2 WHERE space_id=$1", [
        f.spaces[0],
        before.encrypted_value_json,
      ]);
      await assert.rejects(
        f.installs.verify(f.request({ ...attempt, grant: { ...f.selection, agentId: 2, nativeAdminId: "NativeAdminFixture" } })),
        corrupt,
      );
      await f.confirm(await f.prepare());
      const captured = await f.resolve(),
        ref = await dingtalkRecipientRef(captured, "MemberCase");
      assert.notEqual(ref, await dingtalkRecipientRef(captured, "membercase"));
      const stored = (await f.sql("SELECT * FROM data.app_dingtalk_company_grants WHERE space_id=$1", [f.spaces[0]]))
        .rows[0];
      assert.doesNotMatch(JSON.stringify(stored), /dingPrivateTestCompany|MemberCase|989887|43847/);
      await assert.rejects(
        new PostgresDingTalkCompanyRepository(f.database, "wrong-key").resolve(f.request({ spaceId: f.spaces[0] })),
        corrupt,
      );
      for (const field of ["actor_user_id", "company_digest", "grant_generation"]) {
        const value =
          field === "actor_user_id" ? "other" : field === "company_digest" ? "b".repeat(64) : crypto.randomUUID();
        await f.sql(`UPDATE data.app_dingtalk_company_grants SET ${field}=$2 WHERE space_id=$1`, [f.spaces[0], value]);
        if (field === "company_digest") assert.equal(await f.resolve(), null);
        else await assert.rejects(f.resolve(), corrupt);
        await f.sql(`UPDATE data.app_dingtalk_company_grants SET ${field}=$2 WHERE space_id=$1`, [
          f.spaces[0],
          stored[field],
        ]);
      }
    }),
);
integration(
  "DingTalk rotation, expired state, removed admin, current status and connection birth cannot widen grants",
  async () =>
    fixture(async (f) => {
      let attempt = await f.prepare();
      await assert.rejects(
        f.confirm(attempt, 0, {
          app: { ...f.app, eventKeyDigest: "b".repeat(64) },
        }),
        changed,
      );
      await f.sql(
        "UPDATE data.app_dingtalk_company_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1",
        [f.spaces[0]],
      );
      await assert.rejects(f.confirm(attempt), changed);
      attempt = await f.prepare();
      await f.sql("UPDATE data.app_connector_connections SET version=version+1 WHERE space_id=$1", [f.spaces[0]]);
      await assert.rejects(f.confirm(attempt), changed);
      await f.confirm(await f.prepare());
      const captured = await f.resolve();
      await f.sql("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'", [f.spaces[0]]);
      assert.equal(await f.resolve(), null);
      await assert.rejects(f.begin(), (e) => e.status === 404);
      await f.sql("UPDATE data.space_members SET role='owner' WHERE space_id=$1 AND user_id='owner'", [f.spaces[0]]);
      await f.sql("UPDATE data.app_connector_connections SET status='error' WHERE space_id=$1", [f.spaces[0]]);
      assert.equal(await f.resolve(), null);
      assert.ok(await f.resolve(0, { forCheck: true }));
      await f.sql(
        "UPDATE data.app_connector_connections SET status='configured',search_rank_sequence='new-birth' WHERE space_id=$1",
        [f.spaces[0]],
      );
      assert.equal(await f.companies.current(f.request({ installation: captured })), false);
    }),
);
integration(
  "DingTalk signed retirement fences pending starts and confirmation races; duplicates cannot resurrect private grants",
  async () =>
    fixture(async (f) => {
      await f.confirm(await f.prepare());
      const captured = await f.resolve(),
        pending = await f.prepare(1),
        eventTime = await f.time();
      await f.companies.retire(f.request({ corpId: f.selection.corpId, eventTime }));
      await assert.rejects(f.confirm(pending, 1), changed);
      assert.equal(await f.resolve(), null);
      assert.equal(await f.companies.current(f.request({ installation: captured })), false);
      assert.equal((await f.companies.retire(f.request({ corpId: f.selection.corpId, eventTime }))).retired, 0);
      for (const table of ["app_dingtalk_company_attempts", "app_dingtalk_company_grants"])
        assert.equal(
          (await f.sql(`SELECT count(*)::int AS n FROM data.${table} WHERE space_id=ANY($1::text[])`, [f.spaces]))
            .rows[0].n,
          0,
        );
      await f.sql(
        "UPDATE data.app_dingtalk_company_fences SET changed_at=clock_timestamp()-interval '1 second' WHERE app_identity=$1",
        [f.identity],
      );
      await f.visible();
      const next = await f.prepare(),
        at = await f.time();
      await Promise.allSettled([
        f.confirm(next),
        f.companies.retire(f.request({ corpId: f.selection.corpId, eventTime: at })),
      ]);
      assert.equal(await f.resolve(), null);
    }),
);
integration(
  "DingTalk member events resolve only exact company and case-sensitive selected users, and deletion cascades private consent",
  async () =>
    fixture(async (f) => {
      await f.confirm(await f.prepare());
      const base = { corpId: f.selection.corpId, memberId: "MemberCase", eventTime: await f.time() };
      assert.equal((await f.companies.incoming(f.request(base))).length, 1);
      for (const extra of [
        { corpId: "dingOtherCompany" },
        { memberId: "MEMBERCASE" },
        { app: { ...f.app, eventKeyDigest: "b".repeat(64) } },
      ])
        assert.deepEqual(await f.companies.incoming(f.request({ ...base, ...extra })), []);
      assert.deepEqual(
        await f.companies.incoming(f.request({ ...base, eventTime: new Date(Date.now() - 700000).toISOString() })),
        [],
      );
      assert.deepEqual(
        await f.companies.incoming(f.request({ ...base, eventTime: new Date(Date.now() + 60000).toISOString() })),
        [],
      );
      await f.prepare();
      await f.sql("DELETE FROM data.app_connector_connections WHERE space_id=$1", [f.spaces[0]]);
      assert.equal(await f.resolve(), null);
      assert.equal(
        (
          await f.sql("SELECT count(*)::int AS n FROM data.app_dingtalk_company_attempts WHERE space_id=$1", [
            f.spaces[0],
          ])
        ).rows[0].n,
        0,
      );
      assert.throws(
        () => new PostgresDingTalkCompanyRepository({ ...f.database, cacheMode: "enabled" }, f.key),
        (e) => e.status === 503,
      );
    }),
);
integration(
  "DingTalk requires a full signed app-visible snapshot; scope replacement and ambiguity fence grants without using contact/admin/dept aliases",
  async () =>
    fixture(async (f) => {
      await f.sql("DELETE FROM data.app_dingtalk_company_visibility WHERE app_identity=$1", [f.identity]);
      const pending = await f.begin();
      await f.installs.take(f.request({ ...pending, corpId: f.selection.corpId }));
      const grant = { ...f.selection, agentId: 989887, nativeAdminId: "NativeAdminFixture" };
      await assert.rejects(f.installs.verify(f.request({ ...pending, grant })), changed);
      const departmentOnly = {
        corpId: f.selection.corpId,
        appId: f.selection.appId,
        agentId: 989887,
        users: [],
        departments: ["1"],
      };
      await f.visible({ scope: departmentOnly });
      await assert.rejects(f.installs.verify(f.request({ ...pending, grant })), changed);
      await f.visible();
      await f.installs.verify(f.request({ ...pending, grant }));
      await f.confirm(pending);
      const captured = await f.resolve(),
        eventTime = await f.time();
      const scope = { ...departmentOnly, users: ["MemberCase"] };
      await f.visible({ eventTime, scope });
      assert.equal(await f.companies.current(f.request({ installation: captured })), false);
      await assert.rejects(f.visible({ eventTime, scope: { ...scope, users: ["membercase"] } }), changed);
      const row = (
        await f.sql("SELECT * FROM data.app_dingtalk_company_visibility WHERE app_identity=$1", [f.identity])
      ).rows[0];
      assert.equal(row.ambiguous, true);
      assert.deepEqual(row.encrypted_value_json, {});
      await assert.rejects(f.visible({ eventTime, scope }), changed);
      assert.equal(await f.resolve(), null);
      await f.visible();
      await f.confirm(await f.prepare());
      const renewed = await f.resolve();
      assert.notEqual(renewed.grantGeneration, captured.grantGeneration);
      assert.notEqual(
        await dingtalkRecipientRef(renewed, "MemberCase"),
        await dingtalkRecipientRef(captured, "MemberCase"),
      );
    }),
);

integration(
  "DingTalk membership birth and version fence removed and readded admins, including outstanding consent",
  async () =>
    fixture(async (f) => {
      await f.confirm(await f.prepare());
      const pending = await f.prepare(1);
      const captured = await f.resolve();
      await f.sql("DELETE FROM data.space_members WHERE space_id=ANY($1::text[]) AND user_id='owner'", [f.spaces]);
      await f.sql(
        "INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at) SELECT unnest($1::text[]),'owner','owner',1,clock_timestamp(),clock_timestamp()",
        [f.spaces],
      );
      assert.equal(await f.resolve(), null);
      assert.equal(await f.companies.current(f.request({ installation: captured })), false);
      await assert.rejects(f.confirm(pending, 1), changed);
      await f.confirm(await f.prepare());
      await f.sql("UPDATE data.space_members SET version=version+2 WHERE space_id=$1 AND user_id='owner'", [
        f.spaces[0],
      ]);
      assert.equal(await f.resolve(), null);
    }),
);
integration(
  "DingTalk lifecycle maintenance removes expired private attempts while retaining current consent",
  async () =>
    fixture(async (f) => {
      await f.prepare();
      await f.prepare(1);
      await f.sql(
        "UPDATE data.app_dingtalk_company_attempts SET expires_at=clock_timestamp()-interval '1 second' WHERE space_id=$1",
        [f.spaces[0]],
      );
      const { runLifecycleMaintenance, parseLifecycleOptions } = await import(
        "../scripts/postgres-lifecycle-maintenance.mjs"
      );
      // connectorDatabase's direct client is distinct from the bounded command pool.
      const { Client } = await import("pg");
      const client = new Client({ connectionString: process.env.XMATRIX_TEST_POSTGRES_URL });
      await client.connect();
      try {
        const result = await runLifecycleMaintenance(client, parseLifecycleOptions(["--batch-size=1", "--max-rows=1"]));
        assert.equal(result.deletedExpiredDingTalkCompanyAttempts, 1);
        const rows = (
          await f.sql("SELECT space_id FROM data.app_dingtalk_company_attempts WHERE space_id=ANY($1::text[])", [
            f.spaces,
          ])
        ).rows;
        assert.deepEqual(
          rows.map((r) => r.space_id),
          [f.spaces[1]],
        );
      } finally {
        await client.end();
      }
    }),
);

integration("DingTalk queued pre-retirement scope cannot revive after bounded lifecycle fence cleanup", async () =>
  fixture(async (f) => {
    await f.confirm(await f.prepare());
    const old = await f.time();
    await f.companies.retire(f.request({ corpId: f.selection.corpId, eventTime: await f.time() }));
    await assert.rejects(f.visible({ eventTime: old }), changed);
    const row = (
      await f.sql(
        "SELECT ambiguous,encrypted_value_json FROM data.app_dingtalk_company_visibility WHERE app_identity=$1",
        [f.identity],
      )
    ).rows[0];
    assert.equal(row.ambiguous, true);
    assert.deepEqual(row.encrypted_value_json, {});
    await f.sql(
      "UPDATE data.app_dingtalk_company_fences SET changed_at=clock_timestamp()-interval '12 minutes' WHERE app_identity=$1",
      [f.identity],
    );
    await f.begin();
    assert.equal(
      (
        await f.sql("SELECT count(*)::int AS n FROM data.app_dingtalk_company_fences WHERE app_identity=$1", [
          f.identity,
        ])
      ).rows[0].n,
      0,
    );
    const pending = await f.begin();
    await f.installs.take(f.request({ ...pending, corpId: f.selection.corpId }));
    await assert.rejects(
      f.installs.verify(f.request({ ...pending, grant: { ...f.selection, agentId: 989887, nativeAdminId: "NativeAdminFixture" } })),
      changed,
    );
  }),
);

integration(
  "DingTalk current checks hold grant, connection and original membership against concurrent replacement",
  async () =>
    fixture(async (f) => {
      await f.confirm(await f.prepare());
      let entered, release;
      const stopped = new Promise((r) => (entered = r)),
        resume = new Promise((r) => (release = r));
      const guarded = {
        cacheMode: "disabled",
        transaction: async (context, callback) =>
          f.database.transaction(context, (tx) =>
            callback({
              query: async (statement) => {
                if (statement.name === "dingtalk_visible_scope_v1") {
                  entered();
                  await resume;
                }
                return tx.query(statement);
              },
            }),
          ),
      };
      const resolving = new PostgresDingTalkCompanyRepository(guarded, f.key).resolve(
        f.request({ spaceId: f.spaces[0] }),
      );
      await stopped;
      const { Client } = await import("pg"),
        writer = new Client({ connectionString: process.env.XMATRIX_TEST_POSTGRES_URL });
      await writer.connect();
      try {
        await writer.query("SET lock_timeout='100ms'");
        for (const sql of [
          "UPDATE data.app_dingtalk_company_grants SET grant_generation=gen_random_uuid() WHERE space_id=$1",
          "UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id='owner'",
          "UPDATE data.app_connector_connections SET status='disconnected' WHERE space_id=$1",
        ])
          await assert.rejects(writer.query(sql, [f.spaces[0]]), (error) => error.code === "55P03");
      } finally {
        release();
        await writer.end();
      }
      assert.ok(await resolving);
    }),
);
integration('DingTalk taken selection must have primary signed visibility before private provider contact reads',async()=>fixture(async({begin,installs,request,selection,sql,identity,visible})=>{
  const attempt=await begin();await installs.take(request({...attempt,corpId:selection.corpId}));
  const selected=await installs.taken(request(attempt));assert.deepEqual(selected.grant,{...selection,agentId:989887});assert.ok(selected.scopeVersion>0);
  await sql('UPDATE data.app_dingtalk_company_visibility SET ambiguous=true,encrypted_value_json=\'{}\'::jsonb WHERE app_identity=$1',[identity]);
  await assert.rejects(installs.taken(request(attempt)),e=>e.status===409);
  await visible({eventTime:new Date(Date.now()+5).toISOString(),scope:{corpId:selection.corpId,appId:selection.appId,agentId:989887,users:['MemberCase'],departments:['1']}});
  await assert.rejects(installs.taken(request(attempt)),e=>e.status===409);
}));


integration("DingTalk primary grants require an encrypted native administrator identity bound to original Human and confirmation", async () => {
  await fixture(async f => {
    const pending=await f.begin();await f.installs.take(f.request(pending));await f.visible();
    const base={...f.selection,agentId:989887};
    for(const nativeAdminId of [undefined,"","@ALL",{}]) await assert.rejects(f.installs.verify(f.request({...pending,grant:{...base,nativeAdminId}})),changed);
    await f.installs.verify(f.request({...pending,grant:{...base,nativeAdminId:"NativeAdminFixture"}}));
    const prepared=await f.installs.prepared(f.request(pending));assert.equal(prepared.grant.nativeAdminId,"NativeAdminFixture");
    const ciphertext=(await f.sql("SELECT encrypted_value_json FROM data.app_dingtalk_company_attempts WHERE connection_id=$1",[`${f.spaces[0]}:dingtalk`])).rows[0];
    assert.ok(!JSON.stringify(ciphertext).includes("NativeAdminFixture"));
    await f.installs.confirm(f.request({...pending,spaceId:f.spaces[0],confirmed:true}));
    const saved=await f.companies.resolve(f.request({spaceId:f.spaces[0]}));assert.equal(saved.nativeAdminId,"NativeAdminFixture");
    assert.equal(saved.actorUserId,"owner");
  });
});
