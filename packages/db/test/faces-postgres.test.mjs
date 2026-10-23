import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresSpaceControlRepository, readAgentFaces, readUserFaces } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("a person's face is their account's picture alone; an Agent Instance's is its harness's mark, in its Space", async () => {
  const f = await isolatedPostgres("faces", { shard: true });
  try {
    const db = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" });
    for (const [id, image] of [["ada", "https://hub.example/api/avatars/ada/1.png"], ["bob", null], ["outsider", null]]) {
      await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at,image)
        VALUES($1,$1,$1||'@example.test',true,now(),now(),$2)`, [id, image]);
    }
    const spaces = new PostgresSpaceControlRepository(db, "shard-0");
    for (const [spaceId, owner] of [["one", "ada"], ["two", "outsider"]]) {
      await spaces.createSpace({ requestId: randomUUID(), commandId: randomUUID(), spaceId, ownerUserId: owner, name: spaceId });
    }
    // Bob removed his picture; the copy his member row still holds is not his face.
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,version,email,display_name,avatar_url,created_at,updated_at)
      VALUES('one','bob','member',1,NULL,'Bob','https://stale.example/bob.png',now(),now())`);
    // The Runs' foreign keys belong to launch tests.
    await f.run("SET session_replication_role = replica");
    for (const [space, channel, harness] of [["one", "chan-1", "claude_code"], ["one", "chan-2", "custom"], ["two", "chan-3", "codex"]]) {
      await f.run(`INSERT INTO data.runs(run_id,owner_user_id,channel_id,status,version,metadata_json,created_at,updated_at)
        VALUES($1||':1#1','ada',$1,'running',1,'{}',now(),now())`, [channel]);
      await f.run(`INSERT INTO data.instances(instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
        VALUES($1||':1',$1||':1#1',$1,1,'online',1,now(),now())`, [channel]);
      await f.run(`INSERT INTO data.run_agent_registrations
        (run_id,space_id,owner_user_id,machine_id,harness,actor_user_id,allocation_id,authorization_digest,
         grant_revision,grant_execution_revision,policy_revision,policy_execution_revision,requested_json)
        VALUES($1||':1#1',$2,'ada','machine',$3,'ada','allocation-'||$1,repeat('a',64),1,1,1,1,'{}')`, [channel, space, harness]);
    }
    await f.run("SET session_replication_role = origin");

    const users = await db.transaction({ requestId: randomUUID(), operation: "test.faces" }, (tx) =>
      readUserFaces(tx, ["ada", "bob", "nobody"]));
    assert.deepEqual(users, [
      { id: "ada", imageUrl: "https://hub.example/api/avatars/ada/1.png" },
      { id: "bob", imageUrl: null },
      { id: "nobody", imageUrl: null },
    ]);

    const agents = await readAgentFaces(db, { requestId: randomUUID(), spaceId: "one", userId: "bob",
      instanceIds: ["chan-1:1", "chan-2:1", "chan-3:1"] });
    assert.equal(agents[0].id, "chan-1:1");
    assert.match(agents[0].imageUrl, /^\/agent-vendors\//u, "claude_code is Claude's mark");
    assert.deepEqual(agents.slice(1), [{ id: "chan-2:1", imageUrl: null }, { id: "chan-3:1", imageUrl: null }],
      "a custom harness has no mark, and another Space's Instance is not read here");

    await assert.rejects(readAgentFaces(db, { requestId: randomUUID(), spaceId: "two", userId: "bob", instanceIds: [] }),
      (error) => error.code === "space_not_found", "only the Space's members read faces in it");
  } finally {
    await f.close();
  }
});
