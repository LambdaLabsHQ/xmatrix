import assert from "node:assert/strict";
import { Client } from "pg";
import { createAuthorityDatabase, databaseFailureEvidence } from "../dist/index.js";
import { commitRuntime } from "../dist/runtime-control.js";
import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";

// HUB-BH failed in commitRuntime, after the Run writes. Channel/execution lock
// tests never wait on this head. A real cycle must retain its live other end
// before PostgreSQL removes the edge, and diagnostics must not change rollback.
integration("runtime head deadlocks retain their blocker and roll back without replay", async () => {
  const fixture = await isolatedPostgres("runtime_head_deadlock");
  const holder = fixture.client;
  let samples = 0, unavailable = false;
  const database = createAuthorityDatabase({ connectionString: fixture.url.toString(), shardId: "shard-0",
    applicationName: "xmatrix-hub-runtime", lockTimeoutMs: 4000, clientFactory: config => {
      if (config.application_name === "xmatrix-lock-diagnostic") {
        samples++;
        if (unavailable) throw new Error("private-diagnostic-failure");
      }
      return new Client(config);
    } });
  const at = new Date().toISOString();
  const value = { entityId: "private-run", status: "starting" };
  try {
    await holder.query("INSERT INTO data.space_control_heads VALUES ('private-space',0,now())");
    await holder.query("CREATE TABLE private_run_lock (id int PRIMARY KEY, version int)");
    await holder.query("INSERT INTO private_run_lock VALUES (1,0)");
    for (const [operation, names, missingDiagnostic] of [
      ["registration.launch.commit", undefined, false],
      ["runtime.machine-lifecycle", { head: "machine_lifecycle_head_advance_v1", outbox: "machine_lifecycle_outbox_v1" }, false],
      ["registration.launch.commit", undefined, true],
    ]) {
      unavailable = missingDiagnostic;
      await holder.query(`BEGIN; SET LOCAL application_name='xmatrix-hub-runtime runtime.instance_transition';
        SET LOCAL deadlock_timeout='5s'; SET LOCAL statement_timeout='8s'`);
      await holder.query("SELECT 1 FROM data.space_control_heads WHERE space_id='private-space' FOR UPDATE");
      let ready, release;
      const locked = new Promise(resolve => { ready = resolve; });
      const proceed = new Promise(resolve => { release = resolve; });
      let attempts = 0;
      const failed = assert.rejects(database.transaction({ requestId: "private-request", operation }, async tx => {
        attempts++;
        await tx.query({ name: "test_run_write_v1", text: "UPDATE private_run_lock SET version=version+1 WHERE id=1", maxRows: 0 });
        ready();
        await proceed;
        await commitRuntime(tx, "private-space", value, at, names);
      }), error => {
        assert.equal(error.code, "40P01", "the original deadlock stays authoritative");
        const [evidence] = databaseFailureEvidence(error);
        assert.equal(evidence.queryName, names?.head ?? "runtime_control_head_advance_v1");
        assert.equal(evidence.lockWait?.status, unavailable ? "unavailable" : "sampled");
        if (!unavailable) {
          assert.equal(evidence.lockWait.waiter.owner, `op:${operation}`);
          assert.equal(evidence.lockWait.waiter.wait, "Lock");
          assert.equal(evidence.lockWait.blockers.length, 1);
          assert.equal(evidence.lockWait.blockers[0].owner, "op:runtime.instance_transition");
          assert.equal(evidence.lockWait.blockers[0].state, "active");
          assert.equal(evidence.lockWait.blockers[0].wait, "Lock", "the blocker is itself waiting in the cycle");
          assert.ok(evidence.lockWait.blockers[0].ageMs > 0);
        }
        assert.doesNotMatch(JSON.stringify(evidence), /private-|SELECT|UPDATE|postgres:\/\//u);
        return true;
      });
      await locked;
      const otherEnd = holder.query("SELECT 1 FROM private_run_lock WHERE id=1 FOR UPDATE");
      release();
      await Promise.all([failed, otherEnd]);
      await holder.query("ROLLBACK");
      assert.equal(attempts, 1, "diagnostics never replay the failed callback");
      assert.equal((await holder.query("SELECT version FROM private_run_lock")).rows[0].version, 0);
      assert.equal((await holder.query("SELECT commit_sequence FROM data.space_control_heads")).rows[0].commit_sequence, "0");
      assert.equal((await holder.query("SELECT count(*) FROM data.outbox")).rows[0].count, "0");
    }
    assert.equal(samples, 3, "one diagnostic attempt per deadlock, including diagnostic failure");
    unavailable = false;
    await database.transaction({ requestId: "fast", operation: "registration.launch.commit" },
      tx => commitRuntime(tx, "private-space", value, at));
    assert.equal(samples, 3, "an uncontended head opens no diagnostic connection");
    assert.equal((await holder.query("SELECT commit_sequence FROM data.space_control_heads")).rows[0].commit_sequence, "1");
    assert.equal((await holder.query("SELECT count(*) FROM data.outbox")).rows[0].count, "1");
  } finally {
    await holder.query("ROLLBACK").catch(() => {});
    await fixture.close();
  }
});
