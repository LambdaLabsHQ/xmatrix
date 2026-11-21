import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createAuthorityDatabase, PostgresEmailCampaignRepository } from "../dist/index.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

integration("a campaign mails each person once, and never anyone who unsubscribed or deleted their account", async () => {
  const f = await isolatedPostgres("email_campaigns", { shard: true });
  const repo = new PostgresEmailCampaignRepository(createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0" }));
  try {
    await f.run(`INSERT INTO control.account_deletion_requests(user_id,request_id,state,receipt_hash,committed_at)
      VALUES('gone',$1,'committed',$2,now())`, [randomUUID(), "b".repeat(64)]);
    await repo.unsubscribe(randomUUID(), "quiet");
    await repo.unsubscribe(randomUUID(), "quiet");
    assert.equal(await repo.unsubscribed(randomUUID(), "quiet"), true);
    const people = ["a", "b", "quiet", "gone", "a"];
    const dry = await repo.eligible(randomUUID(), "c1", people, false);
    assert.deepEqual(dry.eligible.sort(), ["a", "b"]);
    assert.deepEqual(dry.skipped, { unsubscribed: 1, deleted: 1, alreadySent: 0 });
    assert.deepEqual((await repo.eligible(randomUUID(), "c1", people, false)).eligible.sort(), ["a", "b"], "a dry run claims nothing");
    const [first, second] = await Promise.all([repo.eligible(randomUUID(), "c1", people, true), repo.eligible(randomUUID(), "c1", people, true)]);
    assert.deepEqual([...first.eligible, ...second.eligible].sort(), ["a", "b"], "concurrent batches never claim the same person twice");
    await repo.record(randomUUID(), "c1", "a", "failed");
    const again = await repo.eligible(randomUUID(), "c1", people, true);
    assert.deepEqual(again.eligible, [], "a failed send is not retried automatically");
    assert.equal(again.skipped.alreadySent, 2);
    assert.deepEqual((await repo.eligible(randomUUID(), "c2", ["a"], false)).eligible, ["a"], "each campaign is separate");
  } finally { await f.close(); }
});
