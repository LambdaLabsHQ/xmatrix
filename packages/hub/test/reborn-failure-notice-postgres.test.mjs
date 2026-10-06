import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import {
  createAuthorityDatabase,
} from "../../db/src/index.ts";
import {
  reconcileRebornWithPort,
} from "../src/reborn-reconcile.ts";

const url = process.env.XMATRIX_TEST_POSTGRES_URL;
const integration = url || process.env.XMATRIX_REQUIRE_POSTGRES_TEST === "true" ? test : test.skip;

integration("expired Reborn retains its visible failure across lost notice acknowledgements", async () => {
  assert.ok(url, "XMATRIX_TEST_POSTGRES_URL is required");
  const database = createAuthorityDatabase({ connectionString: url, shardId: "shard-0" }).openSession();
  const id = `notice-test:${randomUUID()}`;
  const query = (name, text, values = [], maxRows = 1) => database.transaction({ requestId: id, operation: "test.reborn-notice" },
    tx => tx.query({ name, text, values, maxRows }));
  const notices = new Set();
  let attempts = 0;
  const unexpected = async () => assert.fail("a failed recovery cannot issue execution controls");
  const port = { advance: unexpected, stop: unexpected, status: unexpected, spawn: unexpected, spawnStatus: unexpected,
    async notifyFailure(row, body) {
      assert.equal(row.intent_id, id);
      assert.equal(row.error_code, "reborn_expired");
      assert.match(body, /Reborn failed \[reborn_expired\]/);
      notices.add(`${row.intent_id}:${body}`);
      if (++attempts === 1) throw new Error("lost notice acknowledgement");
    } };
  try {
    await query("test_reborn_notice_seed_v1", `INSERT INTO data.agent_reborn_intents
      (intent_id,space_id,channel_id,actor_user_id,owner_user_id,source_run_id,source_instance_id,
       successor_run_id,stop_control_id,machine_id,hostname,stop_required,stop_payload_json,
       run_input_json,instance_input_json,spawn_payload_json,created_at,updated_at,expires_at)
      VALUES ($1,'space','channel','owner','owner',$1,$1,$1,$1,'machine','host',true,
        '{}','{}','{}','{}',clock_timestamp(),clock_timestamp(),clock_timestamp()-interval '1 second')`, [id], 0);
    await reconcileRebornWithPort(database, "shard-0", port, "channel");
    const [failed] = await query("test_reborn_notice_read_v1", `SELECT state,error_code,failure_notified_at,lease_owner
      FROM data.agent_reborn_intents WHERE intent_id=$1`, [id]);
    assert.deepEqual(failed, { state: "failed", error_code: "reborn_expired", failure_notified_at: null, lease_owner: null });
    await query("test_reborn_notice_due_v1", `UPDATE data.agent_reborn_intents SET next_attempt_at=clock_timestamp()
      WHERE intent_id=$1`, [id], 0);
    await reconcileRebornWithPort(database, "shard-0", port, "channel");
    await reconcileRebornWithPort(database, "shard-0", port, "channel");
    const [done] = await query("test_reborn_notice_done_v1", `SELECT failure_notified_at IS NOT NULL AS notified
      FROM data.agent_reborn_intents WHERE intent_id=$1`, [id]);
    assert.equal(done.notified, true);
    assert.equal(attempts, 2);
    assert.equal(notices.size, 1);
  } finally {
    await query("test_reborn_notice_cleanup_v1", "DELETE FROM data.agent_reborn_intents WHERE intent_id=$1", [id], 0);
    await database.close();
  }
});
