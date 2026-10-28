import assert from "node:assert/strict";
import { digestCanonicalCloneCborV1 } from "@xmatrix/protocol";
import { createAuthorityDatabase, PostgresQuotaRetryRepository, assertQuotaRetryAdmission } from "../dist/index.js";
import { fenceChannelRunsForStop } from "../dist/channel-stop-fence.js";
import { lockChannelLifecycle } from "../dist/channel-capability-policy.js";
import { integration, isolatedPostgres, seedMessageSpace } from "./postgres-database.fixture.mjs";

// This owns the durable explicit-choice/admission boundary. Existing capacity
// retries concern running Codex turns and cannot catch a pre-launch stop race.
integration("quota recovery is explicit, source-bound, replayable and fenced with final admission", async t => {
  const f = await isolatedPostgres("quota_retry", { shard: true });
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const placement = { spaceId: "space", shardId: "shard-0", placementEpoch: 1 };
  const repository = new PostgresQuotaRetryRepository(database, placement);
  const key = { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "claude" };
  const tx = callback => database.transaction({ requestId: crypto.randomUUID(), operation: "quota.test", placement }, callback);
  const source = async channelId => {
    await f.run(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES($1,'space',$1,$1,'open',$1,1,now(),now())`, [channelId]);
    await f.run(`INSERT INTO data.messages(space_id,channel_id,message_id,timeline_sequence,entity_version,author_kind,author_id,
      message_kind,content_hash,payload_kind,payload_ref,sent_at,updated_at,created_at,search_rank_sequence,body_hash)
      VALUES('space',$1,$1,1,1,'user','owner','xmatrix.message.text','hash','inline','ref',now(),now(),now(),$1,$2)`,
    [channelId, await digestCanonicalCloneCborV1("@claude Finish the pending task")]);
    return repository.offer({ channelId, actorUserId: "owner", sourceMessageId: channelId,
      sourceMention: "@claude", selectionIndex: 0, registrations: [key] });
  };
  const read = (channelId, id, actorUserId = "owner") => repository.read({ channelId, id, actorUserId });
  const choose = (channelId, id, action = "wait", actorUserId = "owner") => repository.choose({ channelId, id, action, actorUserId });
  const admission = (channelId, permit) => tx(async transaction => {
    await lockChannelLifecycle(transaction, { channelId, capability: "runtime_new_work" });
    await assertQuotaRetryAdmission(transaction, { channelId, actorUserId: "owner", admission: permit });
  });
  try {
    await seedMessageSpace(f.client, { space: "space", channel: "seed", at: new Date().toISOString(), tables: [],
      members: [{ id: "owner", role: "owner" }, { id: "other", role: "member" }] });
    await t.test("offers and reloads schedule nothing; the author explicitly chooses on either device", async () => {
      const id = await source("explicit");
      assert.equal((await read("explicit", id)).state, "offered");
      assert.deepEqual(await repository.due("explicit"), []);
      assert.equal((await read("explicit", id, "other")).canChoose, false);
      await assert.rejects(choose("explicit", id, "wait", "other"), error => error.code === "quota_retry_not_found");
      await Promise.all([choose("explicit", id), choose("explicit", id)]);
      const rows = await repository.due("explicit");
      assert.equal(rows.length, 1);
      const [a, b] = await Promise.all([repository.dispatch({ channelId: "explicit", row: rows[0] }), repository.dispatch({ channelId: "explicit", row: rows[0] })]);
      assert.deepEqual(a, b, "transport and two-device replay retain the attempt generation");
      await admission("explicit", a);
      await choose("explicit", id, "cancel");
      await assert.rejects(admission("explicit", a), error => error.code === "quota_retry_cancelled");
      await assert.rejects(choose("explicit", id), error => error.code === "quota_retry_cancelled");
    });
    await t.test("a Channel stop cancels waiting even before any Run exists", async () => {
      const id = await source("stopped");
      await choose("stopped", id);
      const [row] = await repository.due("stopped");
      const permit = await repository.dispatch({ channelId: "stopped", row });
      await tx(async transaction => {
        await lockChannelLifecycle(transaction, { channelId: "stopped", capability: "runtime_new_work" });
        await fenceChannelRunsForStop(transaction, { spaceId: "space", channelId: "stopped", actorUserId: "owner",
          sourceMessageId: "stop", at: new Date().toISOString(), scope: { kind: "channel" } });
      });
      assert.equal((await read("stopped", id)).state, "cancelled");
      await assert.rejects(admission("stopped", permit), error => error.code === "quota_retry_cancelled");
      assert.deepEqual(await repository.due("stopped"), []);
    });
    await t.test("source changes, withdrawal, deadlines and lost Channel authority fence recovery", async () => {
      for (const [name, mutation] of [
        ["edited", "UPDATE data.messages SET invocation_input_version=2,entity_version=2 WHERE channel_id=$1"],
        ["recalled", "UPDATE data.messages SET recalled_at=now() WHERE channel_id=$1"],
        ["deleted", "UPDATE data.messages SET deleted_at=now() WHERE channel_id=$1"],
        ["expired", "UPDATE data.agent_quota_retries SET expires_at=now()-interval '1 second' WHERE channel_id=$1"],
      ]) {
        const id = await source(name); await choose(name, id);
        await f.run(mutation, [name]);
        assert.deepEqual(await repository.due(name), [], name);
        assert.equal((await read(name, id)).canChoose, false);
      }
      const id = await source("revoked"); await choose("revoked", id);
      await f.run("UPDATE data.space_members SET role='viewer' WHERE user_id='owner'");
      assert.deepEqual(await repository.due("revoked"), []);
      assert.equal((await read("revoked", id)).canChoose, false);
      await f.run("UPDATE data.space_members SET role='owner' WHERE user_id='owner'");
    });
    await t.test("a definitively refused attempt advances once; old permits cannot dispatch its replacement", async () => {
      const id = await source("generation"); await choose("generation", id);
      const [row] = await repository.due("generation");
      const old = await repository.dispatch({ channelId: "generation", row });
      await repository.settle("generation", row, "waiting", Date.now()-1);
      await repository.settle("generation", row, "waiting", Date.now()-1);
      const [next] = await repository.due("generation");
      assert.equal(next.generation, old.generation + 1);
      await assert.rejects(admission("generation", old), error => error.code === "quota_retry_cancelled");
      const current = await repository.dispatch({ channelId: "generation", row: next });
      await admission("generation", current);
      await repository.settle("generation", next, "dispatched");
      assert.equal((await read("generation", id)).state, "dispatched");
      assert.deepEqual(await repository.due("generation"), []);
    });
  } finally { await f.close(); }
});
