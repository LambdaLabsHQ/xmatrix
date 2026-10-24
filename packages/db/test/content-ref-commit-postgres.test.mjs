import assert from "node:assert/strict";
import { createAuthorityDatabase, PostgresContentRepository } from "../dist/index.js";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// The repository owns intent consumption and canonical routing. SQL-call mocks
// cannot prove that its successful reuse paths leave the same durable state.
integration("blob ref reuse completes its upload and repairs the canonical directory", async t => {
  const f = await isolatedPostgres("content_ref_commit", { shard: true });
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
  const content = new PostgresContentRepository(database, "shard-0");
  const principal = { kind: "user", id: "content-owner" };
  const spaceId = "content-space", scopeId = `space:${spaceId}`;
  const checksum = "a".repeat(64);
  const intent = async (id, { encodedBytes = 100, hash = checksum } = {}) => {
    await content.createIntent({ requestId: id, commandId: `create:${id}`, intentId: id,
      scopeId, contentHash: hash, encodedBytes,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), principal });
    return { requestId: `commit:${id}`, commandId: `commit:${id}`, intentId: id,
      expectedIntentVersion: 1, refId: `ref:${id}`, ownerKind: "message_attachment", ownerId: "message",
      scopeId, objectKey: `objects/${hash}`, checksum: hash, encodedBytes, verifiedAt: new Date().toISOString(), principal };
  };
  const routes = () => f.run(`SELECT entity_kind,entity_id,state FROM control.entity_space_routes
    WHERE space_id=$1 ORDER BY entity_kind,entity_id`, [spaceId]);
  const pending = () => f.run("SELECT intent_id FROM data.blob_upload_intents WHERE space_id=$1 ORDER BY intent_id", [spaceId]);
  try {
    await seedTestSpacePlacement(f.client, spaceId, new Date().toISOString());
    await f.run("INSERT INTO data.space_control_heads VALUES ($1,0,now())", [spaceId]);
    await f.run(`INSERT INTO data.spaces
      (space_id,owner_user_id,name,search_rank_sequence,version,metadata_json,created_at,updated_at)
      VALUES ($1,$2,$1,$1,1,'{}',now(),now())`, [spaceId, principal.id]);
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,created_at,updated_at)
      VALUES ($1,$2,'owner',1,now(),now())`, [spaceId, principal.id]);

    const first = await intent("first");
    const canonical = await content.commitRef(first);
    await t.test("reuse consumes each verified intent and preserves one reference under concurrent commits", async () => {
      const inputs = await Promise.all([intent("second"), intent("third")]);
      const outcomes = await Promise.allSettled(inputs.map(input => content.commitRef(input)));
      assert.deepEqual(outcomes.map(result => result.status), ["fulfilled", "fulfilled"],
        outcomes.filter(result => result.status === "rejected").map(result => result.reason).join("\n"));
      assert.deepEqual(outcomes.map(result => result.value), [canonical, canonical]);
      assert.deepEqual(await pending(), [], "successful uploads cannot remain pending");
      assert.deepEqual(await f.run("SELECT ref_id FROM data.content_refs WHERE space_id=$1", [spaceId]),
        [{ ref_id: canonical.refId }]);
      for (const input of inputs) {
        assert.deepEqual(await content.commitRef(input), canonical, "the exact command replays its canonical result");
        await assert.rejects(content.readIntent({ requestId: "read", intentId: input.intentId, principal }),
          { code: "blob_intent_unavailable" });
      }
      assert.deepEqual(await routes(), [
        ...["first", "second", "third"].map(entity_id => ({ entity_kind: "content-intent", entity_id, state: "deleted" })),
        { entity_kind: "content-ref", entity_id: canonical.refId, state: "active" },
      ]);
    });

    await t.test("a new upload recovers a prior commit whose directory publication was interrupted", async () => {
      const interrupted = await intent("interrupted");
      interrupted.ownerId = "other-message";
      const unavailable = new PostgresContentRepository({ ...database, async transaction(context, work) {
        if (context.operation === "content-intent.directory-publish") throw new Error("directory unavailable");
        return database.transaction(context, work);
      } }, "shard-0");
      await assert.rejects(unavailable.commitRef(interrupted), /directory unavailable/u);
      const retry = { ...await intent("replacement"), ownerId: interrupted.ownerId };
      const recovered = await content.commitRef(retry);
      assert.equal(recovered.refId, interrupted.refId);
      assert.ok((await routes()).some(row => row.entity_kind === "content-ref" &&
        row.entity_id === recovered.refId && row.state === "active"), "reuse must restore the returned reference's route");
      assert.ok(!(await routes()).some(row => row.entity_id === retry.refId), "an unused alias has no route");
      assert.deepEqual(await content.readRef({ requestId: "read-ref", refId: recovered.refId, principal }), recovered);
      assert.deepEqual(await pending(), []);
    });

    await t.test("concurrent first uploads elect one immutable object and owner reference", async () => {
      const hash = "b".repeat(64);
      const inputs = await Promise.all([intent("fresh-a", { hash }), intent("fresh-b", { hash })]);
      const outcomes = await Promise.allSettled(inputs.map(input => content.commitRef(input)));
      for (const result of outcomes) assert.equal(result.status, "fulfilled", result.reason?.message);
      assert.deepEqual(outcomes[0].value, outcomes[1].value);
      assert.deepEqual(await f.run("SELECT object_id FROM data.content_objects WHERE space_id=$1 AND checksum=$2",
        [spaceId, hash]), [{ object_id: `sha256:${hash}` }]);
      assert.deepEqual(await pending(), []);
    });

    await t.test("a rejected reuse preserves its intent, immutable metadata and visibility boundary", async () => {
      await f.run(`INSERT INTO data.channels
        (channel_id,space_id,name,name_key,mode,search_rank_sequence,version,metadata_json,created_at,updated_at)
        VALUES ('scope-channel',$1,'Scope','scope','closed','scope-channel',1,'{}',now(),now())`, [spaceId]);
      await f.run(`INSERT INTO control.channel_space_routes
        (channel_id,space_id,shard_id,placement_epoch,entity_version,state,updated_at)
        VALUES ('scope-channel',$1,'shard-0',1,1,'active',now())`, [spaceId]);
      const scoped = await intent("scope-change");
      await assert.rejects(content.commitRef({ ...scoped, scopeId: "channel:scope-channel" }), { code: "blob_ref_conflict" });
      assert.equal((await content.readIntent({ requestId: "scope-read", intentId: scoped.intentId, principal })).state, "pending");
      // The same validated upload can still succeed for a distinct owner;
      // refusing a scope change neither consumed it nor created an alias.
      await content.commitRef({ ...scoped, ownerId: "scoped-message", scopeId: "channel:scope-channel" });
      const rejected = await intent("rejected", { encodedBytes: 101 });
      await assert.rejects(content.commitRef(rejected), { code: "blob_object_mismatch" });
      assert.equal((await content.readIntent({ requestId: "read-rejected", intentId: rejected.intentId, principal })).state, "pending");
      assert.ok((await routes()).some(row => row.entity_kind === "content-intent" &&
        row.entity_id === rejected.intentId && row.state === "active"));
    });
  } finally { await f.close(); }
});
