import assert from "node:assert/strict";
import { PostgresSpaceControlRepository } from "../dist/index.js";
import { integration } from "./postgres-database.fixture.mjs";
import { spaceSecretFixture } from "./space-secret-postgres.fixture.mjs";
import { recoveringDatabase } from "./response-fault-postgres.fixture.mjs";

// Healthy transfer tests own the two-confirmation move. Generic client tests
// cannot catch this caller retaining BEGIN or reusing authority after a loss.
integration("transfer queues recover one loss and recheck admin authority and placement (XMATRIX-HUB-BW)", async () => {
  const f = await spaceSecretFixture();
  let fault;
  const { database, clients } = recoveringDatabase(() => fault);
  const spaces = new PostgresSpaceControlRepository(database, "shard-0");
  const input = { requestId: crypto.randomUUID(), spaceId: f.ids.space,
    principal: { kind: "user", id: f.ids.admin } };
  const read = (extra = {}) => spaces.listTransferProposals({ ...input, ...extra });
  const matches = /FROM data\.channel_transfer_proposals/u;
  const lose = (extra = {}) => fault = { matches, remaining: 1,
    error: new Error("Connection terminated unexpectedly"), checkouts: [], ...extra };
  try {
    assert.deepEqual(await read(), { proposals: [] }, "admins can read an empty queue");
    const snapshot = { spaces: [], members: [], tree: [], access: [], targetParent: [] };
    await f.client.query(`INSERT INTO data.channel_transfer_proposals
      (space_id,proposal_id,target_space_id,channel_id,created_by_kind,created_by_id,
       snapshot_json,status,created_at,expires_at)
      SELECT $1,'proposal-'||n,$2,$3,'user',$4,$5::jsonb,'pending',now()+n*interval '1 second',
        now()+interval '1 hour' FROM generate_series(1,101) n`,
    [f.ids.space, `${f.ids.space}:target`, f.ids.channel, f.ids.admin, JSON.stringify(snapshot)]);
    const expected = await read();
    assert.equal(expected.proposals.length, 100);
    assert.equal(expected.proposals[0].id, "proposal-101");
    const before = clients.length;
    lose();
    assert.deepEqual(await read(), expected);
    assert.equal(fault.checkouts.length, 1);
    assert.ok(fault.checkouts[0].ended, "the lost response destroys its checkout");
    assert.ok(clients.indexOf(fault.checkouts[0]) < clients.length - 1, "recovery uses a fresh connection");
    assert.ok(clients.slice(before).every(c => c.ended && !c.queries.some(sql => /^(BEGIN|COMMIT)/u.test(sql))),
      "request sessions close without opening a transaction");
    assert.deepEqual(await read({ channelId: "unrelated-channel" }), { proposals: [] });
    await assert.rejects(read({ principal: { kind: "user", id: f.ids.owner } }),
      { code: "transfer_admin_required" });
    await assert.rejects(read({ principal: { kind: "agent", id: f.ids.instance } }),
      { code: "human_required" });
    for (const [error, attempts] of [[new Error("Connection terminated unexpectedly"), 2],
      [Object.assign(new Error("statement timeout"), { code: "57014" }), 1]]) {
      lose({ remaining: 3, error });
      await assert.rejects(read(), error);
      assert.equal(fault.checkouts.length, attempts, "only lost responses retry, once");
    }
    lose({ beforeThrow: () => f.client.query(
      "UPDATE control.space_placement SET placement_epoch=2 WHERE space_id=$1", [f.ids.space]) });
    await assert.rejects(read(), /local Space placement fence is stale/u);
    assert.equal(fault.checkouts.length, 1);
    fault = undefined;
    await f.client.query("UPDATE control.space_placement SET placement_epoch=1 WHERE space_id=$1", [f.ids.space]);
    lose({ beforeThrow: () => f.client.query(
      "UPDATE data.space_members SET role='member' WHERE space_id=$1 AND user_id=$2", [f.ids.space, f.ids.admin]) });
    await assert.rejects(read(), { code: "transfer_admin_required" });
    assert.equal(fault.checkouts.length, 1, "recovery sees the revoked admin role");
    assert.ok(clients.every(c => c.ended));
  } finally {
    await f.client.query("DELETE FROM data.channel_transfer_proposals WHERE space_id=$1", [f.ids.space]);
    await f.close();
  }
});
