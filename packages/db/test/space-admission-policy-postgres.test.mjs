import assert from "node:assert/strict";
import test from "node:test";
import { ALLOW_ALL as POLICY, programFixture, sha256 } from "./space-admission-policy-postgres.fixture.mjs";
import { connectionString } from "./space-secret-postgres.fixture.mjs";

const integration = connectionString || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

integration("only a Space admin adopts or withdraws the policy, and only an admin is given its text", async () => {
  const f = await programFixture();
  try {
    await assert.rejects(f.secret.adoptAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.owner, pageId: f.page, libraryName: "Access",
      sourceText: POLICY, sourceSha256: sha256(POLICY) }), (error) => error.code === "forbidden", "a member does not adopt");
    await assert.rejects(f.secret.adoptAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.admin, pageId: `${f.page}:elsewhere`,
      libraryName: "Access", sourceText: POLICY, sourceSha256: sha256(POLICY) }), (error) => error.code === "page_not_found",
    "a Page that is not in the Space names nothing");
    const { policy } = await f.adopt();
    assert.deepEqual({ ...policy, adoptedAt: "" }, { pageId: f.page, libraryName: "Access", sourceText: POLICY,
      sourceSha256: sha256(POLICY), adoptedByUserId: f.ids.admin, adoptedAt: "" });
    assert.equal((await f.secret.admissionPolicy({ spaceId: f.ids.space, userId: f.ids.admin })).policy.sourceText, POLICY);
    const asMember = await f.secret.admissionPolicy({ spaceId: f.ids.space, userId: f.ids.owner });
    assert.deepEqual([asMember.canAdopt, asMember.policy.sourceText, asMember.policy.sourceSha256], [false, "", sha256(POLICY)]);
    await assert.rejects(f.secret.withdrawAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.owner }), (error) => error.code === "forbidden");
    assert.deepEqual(await f.secret.withdrawAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.admin }), { withdrawn: true });
    assert.deepEqual(await f.secret.runAdmission(f.run), {});
    const audit = await f.client.query(`SELECT action FROM data.secret_grant_audit WHERE space_id=$1 AND owner_user_id=$2
      ORDER BY created_at`, [f.ids.space, f.ids.admin]);
    assert.deepEqual(audit.rows.map((row) => row.action), ["policy_adopt", "policy_withdraw"]);
  } finally { await f.close(); }
});

integration("a Run is working for a Page program only while it executes that program's delivery", async () => {
  const f = await programFixture();
  try {
    await f.adopt();
    const work = async () => (await f.secret.runAdmission(f.run)).work;
    assert.equal(await work(), undefined, "an open request the Run is not executing is not its work");

    // Launched by the delivery and nothing reported yet: the trigger stands in.
    await f.launchedBy(f.delivery);
    assert.deepEqual(await work(), f.work);

    // Its execution of the delivery, while accepted or running.
    const first = await f.execution(f.delivery, "running");
    assert.deepEqual(await work(), f.work);

    // It finished the delivery's turn, and a chat message woke the same Run: the launch trigger no longer counts.
    await f.client.query("UPDATE data.agent_message_executions SET state='completed' WHERE binding_id=$1", [first]);
    await f.execution("chat-message", "running");
    assert.equal(await work(), undefined);

    // Working on the delivery again.
    const again = await f.execution(f.delivery, "accepted");
    assert.deepEqual(await work(), f.work);

    // A delegated request is its holder's choice, not the program's.
    await f.client.query("UPDATE data.norn_requests SET delegator_user_id=$2 WHERE space_id=$1", [f.ids.space, f.ids.admin]);
    assert.equal(await work(), undefined);
    await f.client.query("UPDATE data.norn_requests SET delegator_user_id=NULL WHERE space_id=$1", [f.ids.space]);

    // A settled request, a stopped program, a program that is not on a Page.
    await f.client.query("UPDATE data.norn_requests SET settled_at=now() WHERE space_id=$1", [f.ids.space]);
    assert.equal(await work(), undefined);
    await f.client.query("UPDATE data.norn_requests SET settled_at=NULL WHERE space_id=$1", [f.ids.space]);
    await f.client.query("UPDATE data.norn_programs SET state='completed' WHERE space_id=$1", [f.ids.space]);
    assert.equal(await work(), undefined);
    await f.client.query("UPDATE data.norn_programs SET state='running',page_id=NULL,page_name=NULL WHERE space_id=$1", [f.ids.space]);
    assert.equal(await work(), undefined);
    await f.client.query("UPDATE data.norn_programs SET page_id=$2,page_name='patrol' WHERE space_id=$1", [f.ids.space, f.page]);
    assert.deepEqual(await work(), f.work);

    // The program's text changes: the digest follows it.
    await f.client.query("UPDATE data.norn_programs SET source='run(@claude, \"Something else\")->wait' WHERE space_id=$1", [f.ids.space]);
    assert.notEqual((await work()).digest, f.work.digest);
    await f.client.query("UPDATE data.agent_message_executions SET state='completed' WHERE binding_id=$1", [again]);
    assert.equal(await work(), undefined);
  } finally { await f.close(); }
});

integration("the policy's Allow approves the Run as its adopter, and nothing that moved in between", async () => {
  const f = await programFixture();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "closed-key", value: "closed-value" });
    await f.adopt();
    await f.execution(f.delivery, "running");
    const admission = await f.secret.runAdmission(f.run);
    assert.deepEqual(admission.work, f.work);
    const admit = (overrides = {}) => f.secret.runAdmit(f.run, { secretRef: "closed-key",
      sourceSha256: admission.policy.sourceSha256, work: admission.work, ...overrides });

    // The policy changed, or the work the answer named is no longer the Run's: nothing is approved.
    assert.deepEqual(await admit({ sourceSha256: sha256("another text") }), { readable: false });
    assert.deepEqual(await admit({ work: { ...f.work, digest: sha256("edited") } }), { readable: false });
    assert.deepEqual(await admit({ work: undefined }), { readable: false });
    await assert.rejects(f.secret.runRead(f.run, ["closed-key"]), (error) => error.code === "secret_approval_required");

    assert.deepEqual(await admit(), { readable: true });
    assert.deepEqual((await f.secret.runRead(f.run, ["closed-key"])).secrets.map((secret) => secret.value), ["closed-value"]);
    const approval = await f.client.query("SELECT approved_by_user_id FROM data.run_secret_approvals WHERE run_id=$1", [f.ids.run]);
    assert.deepEqual(approval.rows.map((row) => row.approved_by_user_id), [f.ids.admin], "approved by whoever adopted the policy");
    const audit = await f.client.query(`SELECT owner_user_id,secret_refs_json FROM data.secret_grant_audit
      WHERE space_id=$1 AND action='policy_approve'`, [f.ids.space]);
    assert.deepEqual(audit.rows.map((row) => [row.owner_user_id, JSON.stringify(row.secret_refs_json)]), [[f.ids.admin, "[\"closed-key\"]"]]);
    await assert.rejects(admit({ secretRef: "no-such-key" }), (error) => error.code === "secret_not_found");
  } finally { await f.close(); }
});

integration("a policy whose adopter is no longer an admin, or that was withdrawn, is no policy", async () => {
  const f = await programFixture();
  try {
    await f.secret.put({ spaceId: f.ids.space, userId: f.ids.admin, secretRef: "closed-key", value: "closed-value" });
    await f.adopt();
    const { policy } = await f.secret.runAdmission(f.run);
    // The adopter loses the role between the read and the write.
    await f.client.query("UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2", [f.ids.space, f.ids.admin]);
    assert.deepEqual(await f.secret.runAdmission(f.run), {});
    assert.deepEqual(await f.secret.runAdmit(f.run, { secretRef: "closed-key", sourceSha256: policy.sourceSha256 }), { readable: false });
    await f.client.query("UPDATE data.space_members SET role='admin' WHERE space_id=$1 AND user_id=$2", [f.ids.space, f.ids.admin]);
    assert.equal((await f.secret.runAdmission(f.run)).policy.sourceSha256, policy.sourceSha256);
    await f.secret.withdrawAdmissionPolicy({ spaceId: f.ids.space, userId: f.ids.admin });
    assert.deepEqual(await f.secret.runAdmit(f.run, { secretRef: "closed-key", sourceSha256: policy.sourceSha256 }), { readable: false });
    // A Run that is no longer live is put to no policy.
    await f.adopt();
    await f.client.query("UPDATE data.runs SET status='stopped' WHERE run_id=$1", [f.ids.run]);
    await assert.rejects(f.secret.runAdmission(f.run), (error) => error.code === "request_context_unavailable");
  } finally { await f.close(); }
});
