import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PostgresMessageRepository } from "../dist/message-control.js";
import { integration, isolatedPostgres, seedTestSpacePlacement } from "./postgres-database.fixture.mjs";

// Automation appends have no caller-supplied sender snapshot. A membership
// created before naming must still stamp the current Human Profile, just as
// the Space catalog does. Real SQL covers both append and standalone reads.
integration("Human message senders use the current account profile while membership still authorizes them", async () => {
  const f = await isolatedPostgres("message_human_profile", { shard: true });
  try {
    await seedTestSpacePlacement(f.client, "space", new Date().toISOString());
    await f.run(`INSERT INTO control.auth_users(id,name,email,email_verified,image,created_at,updated_at)
      VALUES ('owner','QA Named Person','qa@example.test',true,NULL,now(),now())`);
    await f.run(`INSERT INTO data.spaces(space_id,owner_user_id,name,search_rank_sequence,version,created_at,updated_at)
      VALUES ('space','owner','QA','space',1,now(),now())`);
    await f.run(`INSERT INTO data.space_members(space_id,user_id,role,display_name,avatar_url,version,created_at,updated_at)
      VALUES ('space','owner','owner',NULL,'https://example.test/old-avatar.png',1,now(),now())`);
    await f.run(`INSERT INTO data.channels(channel_id,space_id,name,name_key,mode,search_rank_sequence,version,created_at,updated_at)
      VALUES ('channel','space','QA','qa','open','channel',1,now(),now())`);
    const repository = new PostgresMessageRepository(f.session);
    const input = () => ({ requestId: randomUUID(), spaceId: "space", channelId: "channel",
      principal: { kind: "user", id: "owner" } });
    const readers = [() => repository.senderIdentity(input()),
      async () => (await repository.prepareAppend({ ...input(), senderPrincipal: { kind: "user", id: "owner" } })).senderIdentity];
    for (const read of readers) {
      assert.equal((await read()).displayName, "QA Named Person");
      assert.equal((await read()).avatarUrl, null, "clearing a profile avatar must not resurrect the membership copy");
    }
    await f.run("UPDATE control.auth_users SET name='QA Renamed Person',image='https://example.test/current.png' WHERE id='owner'");
    for (const read of readers) {
      assert.equal((await read()).displayName, "QA Renamed Person");
      assert.equal((await read()).avatarUrl, "https://example.test/current.png");
    }
    await f.run("DELETE FROM control.auth_users WHERE id='owner'");
    await f.run("UPDATE data.space_members SET display_name='Historical member' WHERE user_id='owner'");
    for (const read of readers) {
      assert.equal((await read()).displayName, "Historical member");
      assert.equal((await read()).avatarUrl, null, "an account that is gone has no face; its membership copy is not one");
    }
    await f.run("INSERT INTO control.auth_users(id,name,email,email_verified,created_at,updated_at) VALUES ('outsider','Named outsider','outsider@example.test',true,now(),now())");
    await assert.rejects(repository.senderIdentity({ ...input(), principal: { kind: "user", id: "outsider" } }),
      error => error.code === "channel_not_found");
  } finally { await f.close(); }
});
