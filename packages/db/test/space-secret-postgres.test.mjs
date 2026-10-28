import assert from "node:assert/strict";
import test from "node:test";
import { connectionString, spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";

const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

integration("a live Run reads an auto secret when it asks; an ask secret after an admin approves that Run", async () => {
  const f = await spaceSecretFixture();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "open-key", value: "open-value",
      envName: "OPEN_KEY", access: "auto" });
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "closed-key", value: "closed-value" });
    assert.deepEqual((await f.secret.runRead(f.run)).secrets,
      [{ secretRef: "open-key", envName: "OPEN_KEY", value: "open-value" }], "only what it may read now");
    await assert.rejects(f.secret.runRead(f.run, ["closed-key"]), (error) => error.code === "secret_approval_required");
    await assert.rejects(f.secret.approve({ userId: f.ids.owner, runId: f.ids.run, channelId: f.ids.channel,
      secretRef: "closed-key" }), (error) => error.code === "forbidden", "a member does not approve");
    const status = await f.secret.approve({ userId: f.ids.admin, runId: f.ids.run, channelId: f.ids.channel,
      secretRef: "closed-key" });
    assert.equal(status.readable, true);
    assert.deepEqual((await f.secret.runRead(f.run, ["closed-key"])).secrets.map((secret) => secret.value), ["closed-value"]);
    const stored = await f.client.query("SELECT encrypted_value_json FROM data.space_secrets WHERE space_id=$1", [f.ids.space]);
    assert.doesNotMatch(JSON.stringify(stored.rows), /open-value|closed-value/u);
    const audit = await f.client.query(`SELECT secret_refs_json FROM data.secret_grant_audit
      WHERE owner_user_id=$1 AND action='space_read'`, [f.ids.owner]);
    assert.ok(audit.rows.some((row) => JSON.stringify(row.secret_refs_json) === JSON.stringify(["closed-key"])));
    await f.client.query("UPDATE data.space_members SET role='participant' WHERE space_id=$1 AND user_id=$2",
      [f.ids.space, f.ids.owner]);
    await assert.rejects(f.secret.runRead(f.run, ["open-key"]), (error) => error.status >= 400,
      "a Run whose owner is no longer a member reads none of the Space's secrets");
    await f.client.query("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2",
      [f.ids.space, f.ids.owner]);
    await f.client.query("UPDATE data.runs SET status='stopped' WHERE run_id=$1", [f.ids.run]);
    await assert.rejects(f.secret.runRead(f.run), (error) => error.code === "request_context_unavailable");
  } finally { await f.close(); }
});

integration("concurrent Agent saves of one alias leave exactly one secret, readable by that Run", async () => {
  const f = await spaceSecretFixture();
  try {
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) =>
      f.secret.runCreate(f.run, { secretRef: "agent-created", value: `value-${index}`, envName: "API_KEY" })));
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results.filter((candidate) => candidate.status === "rejected")) {
      assert.equal(result.reason.code, "secret_already_exists", result.reason.stack);
    }
    const [row] = (await f.client.query("SELECT access FROM data.space_secrets WHERE space_id=$1", [f.ids.space])).rows;
    assert.equal(row.access, "ask");
    assert.equal((await f.secret.runRead(f.run, ["agent-created"])).secrets.length, 1, "approved for the Run that saved it");
  } finally { await f.close(); }
});

integration("a Space creates and reads past 128 secrets without truncating aliases, values or approvals", async () => {
  const f = await spaceSecretFixture();
  try {
    for (let index = 0; index < 128; index++) {
      await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin,
        secretRef: `key-${String(index).padStart(3, "0")}`, value: `value-${index}`, access: "auto" });
    }
    await f.secret.runCreate(f.run, { secretRef: "last-key", value: "last-value" });
    const listed = await f.secret.list({ spaceId: f.ids.space, userId: f.ids.owner });
    assert.equal(listed.secrets.length, 129);
    assert.equal(listed.secrets.at(-1).secretRef, "last-key");
    const runList = await f.secret.runList(f.run);
    assert.equal(runList.secrets.length, 129);
    assert.deepEqual(runList.secrets.at(-1),
      { secretRef: "last-key", envName: "LAST_KEY", access: "ask", readable: true });
    const read = await f.secret.runRead(f.run);
    assert.equal(read.secrets.length, 129);
    assert.deepEqual(read.secrets.at(-1), { secretRef: "last-key", envName: "LAST_KEY", value: "last-value" });
    const status = await f.secret.requestStatus({ userId: f.ids.admin, runId: f.ids.run,
      channelId: f.ids.channel, secretRef: "last-key" });
    assert.equal(status.saved, true);
    assert.equal(status.readable, true);
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "last-closed", value: "closed-value" });
    await assert.rejects(f.secret.runRead(f.run, ["last-closed"]), error => error.code === "secret_approval_required");
    await f.secret.approve({ userId: f.ids.admin, runId: f.ids.run, channelId: f.ids.channel, secretRef: "last-closed" });
    assert.equal((await f.secret.runRead(f.run, ["last-closed"])).secrets[0].value, "closed-value");
    const access = await f.secret.accessStatus({ userId: f.ids.admin, runId: f.ids.run,
      channelId: f.ids.channel, secretRefs: ["last-key", "last-closed"] });
    assert.deepEqual(access.secrets.map(secret => secret.secretRef), ["last-closed", "last-key"]);
  } finally { await f.close(); }
});

integration("large values do not block alias lists, and oversized bulk reads fail without partial disclosure", async () => {
  const f = await spaceSecretFixture();
  try {
    const value = "x".repeat(64 * 1024);
    for (let index = 0; index < 96; index++) {
      await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin,
        secretRef: `large-${String(index).padStart(3, "0")}`, value, access: "auto" });
    }
    assert.equal((await f.secret.list({ spaceId: f.ids.space, userId: f.ids.owner })).secrets.length, 96);
    assert.equal((await f.secret.runList(f.run)).secrets.length, 96);
    await assert.rejects(f.secret.runRead(f.run), error => error.code === "secret_response_too_large" && error.status === 413);
    const audit = await f.client.query(`SELECT secret_refs_json FROM data.secret_grant_audit
      WHERE owner_user_id=$1 AND action='space_read'`, [f.ids.owner]);
    assert.equal(audit.rows.length, 0, "a refused bulk read returned and audited no values");
    const named = await f.secret.runRead(f.run, ["large-095"]);
    assert.deepEqual(named.secrets, [{ secretRef: "large-095", envName: "LARGE_095", value }]);
  } finally { await f.close(); }
});

integration("two Spaces keep same-alias values and approvals separate even when a Run's owner belongs to both", async () => {
  const a = await spaceSecretFixture(), b = await spaceSecretFixture();
  try {
    await b.client.query(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,'admin',1,now(),now())`, [b.ids.space, a.ids.owner]);
    for (const [fixture, value] of [[a, "space-a-value"], [b, "space-b-value"]]) {
      await fixture.secret.put({ spaceId: fixture.ids.space, userId: fixture.ids.admin,
        secretRef: "shared-alias", value, access: "ask" });
    }
    await a.secret.approve({ userId: a.ids.admin, runId: a.ids.run, channelId: a.ids.channel, secretRef: "shared-alias" });
    assert.equal((await a.secret.runRead(a.run, ["shared-alias"])).secrets[0].value, "space-a-value");
    await assert.rejects(b.secret.runRead(b.run, ["shared-alias"]), error => error.code === "secret_approval_required");
    for (const read of [() => a.secret.runRead({ ...a.run, spaceId: b.ids.space }, ["shared-alias"]),
      () => a.secret.runList({ ...a.run, spaceId: b.ids.space }),
      () => b.secret.approve({ userId: b.ids.admin, runId: a.ids.run, channelId: b.ids.channel, secretRef: "shared-alias" })]) {
      await assert.rejects(read(), error => error.status >= 400, "membership in both Spaces does not move the Run or its approval");
    }
    await b.secret.put({ spaceId: b.ids.space, userId: b.ids.admin, secretRef: "shared-alias", access: "auto" });
    assert.equal((await b.secret.runRead(b.run, ["shared-alias"])).secrets[0].value, "space-b-value");
    const envelope = (await a.client.query(`SELECT encrypted_value_json FROM data.space_secrets
      WHERE space_id=$1 AND secret_ref='shared-alias'`, [a.ids.space])).rows[0].encrypted_value_json;
    await b.client.query(`UPDATE data.space_secrets SET encrypted_value_json=$2::jsonb
      WHERE space_id=$1 AND secret_ref='shared-alias'`, [b.ids.space, JSON.stringify(envelope)]);
    await assert.rejects(b.secret.runRead(b.run, ["shared-alias"]), error => error.code === "secret_authority_corrupt",
      "a new Space-bound ciphertext cannot be transplanted to another Space");
  } finally { await a.close(); await b.close(); }
});

integration("a Run reads its secrets while a launch holds its Channel and Run rows; saving one still waits (XMATRIX-HUB-6B)", async () => {
  const f = await spaceSecretFixture();
  const launch = new (f.client.constructor)({ connectionString });
  await launch.connect();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "open-key", value: "open-value",
      envName: "OPEN_KEY", access: "auto" });
    await launch.query("BEGIN");
    // runtime_new_work's Channel lock, and a lifecycle update of the reading Run.
    await launch.query("SELECT 1 FROM data.channels WHERE channel_id=$1 FOR UPDATE", [f.ids.channel]);
    await launch.query("SELECT 1 FROM data.runs WHERE run_id=$1 FOR UPDATE", [f.ids.run]);
    await launch.query("SELECT 1 FROM data.instances WHERE instance_id=$1 FOR UPDATE", [f.ids.instance]);
    const started = Date.now();
    assert.deepEqual((await f.secret.runRead(f.run, ["open-key"])).secrets.map((secret) => secret.value), ["open-value"]);
    assert.deepEqual((await f.secret.runList(f.run)).secrets.map((secret) => secret.secretRef), ["open-key"]);
    assert.ok(Date.now() - started < 1_500, "reads do not wait for the held rows");
    await assert.rejects(f.secret.runCreate(f.run, { secretRef: "agent-created", value: "v", envName: "API_KEY" }),
      (error) => /lock timeout/u.test(String(error?.message ?? "")) || error?.code === "55P03" ||
        /lock timeout/u.test(String(error?.cause?.message ?? "")),
      "saving a secret is still ordered behind the Channel's lifecycle");
  } finally {
    await launch.query("ROLLBACK").catch(() => {});
    await launch.end();
    await f.close();
  }
});
