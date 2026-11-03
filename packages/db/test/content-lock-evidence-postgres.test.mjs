import assert from "node:assert/strict";
import { createAuthorityDatabase, databaseFailureEvidence } from "../dist/index.js";
import { integration, isolatedPostgres, postgresDiagnosticClients } from "./postgres-database.fixture.mjs";

// HUB-BN already named the content transaction, but its idle-in-transaction
// snapshot could not identify the last statement or how long it had been idle.
// Exercise the database owner and real pg_stat_activity, including private SQL.
integration("content lock evidence names only fixed statements and retains statement/state ages", async () => {
  const f = await isolatedPostgres("content_lock_evidence", { migrate: false, runtimeRole: false });
  const diagnostics = postgresDiagnosticClients();
  const database = createAuthorityDatabase({ connectionString: f.url.toString(), shardId: "shard-0",
    lockTimeoutMs: 1200, clientFactory: diagnostics.clientFactory });
  try {
    await f.run("CREATE TABLE private_lock (id int PRIMARY KEY)");
    await f.run("INSERT INTO private_lock VALUES (1)");
    for (const operation of ["content.ref.commit", "content.intent.create"]) {
      for (const name of ["content_ref_intent_lock_v1", "private_query_name"]) {
        let ready, release;
        const locked = new Promise(resolve => { ready = resolve; });
        const proceed = new Promise(resolve => { release = resolve; });
        const holder = database.transaction({ requestId: "private-holder", operation }, async tx => {
          await tx.query({ name, text: "SELECT id FROM private_lock WHERE id=$1 FOR SHARE", values: [1], maxRows: 1 });
          ready();
          await proceed;
        });
        try {
          await locked;
          await assert.rejects(database.transaction({ requestId: "private-waiter", operation: "channel.channel_configure" },
            tx => tx.query({ name: "channel_mutation_root_lock_v2",
              text: "SELECT id FROM private_lock WHERE id=$1 FOR UPDATE", values: [1], maxRows: 1 })), error => {
            assert.equal(error.code, "55P03");
            const [failure] = databaseFailureEvidence(error);
            const blocker = failure.lockWait.blockers[0];
            assert.equal(blocker.owner, `op:${operation}`);
            assert.equal(blocker.state, "idle in transaction");
            assert.equal(blocker.queryName, name === "private_query_name" ? "unclassified" : name);
            assert.ok(blocker.queryAgeMs >= blocker.stateAgeMs);
            assert.ok(blocker.stateAgeMs > 0);
            assert.ok(blocker.ageMs >= blocker.queryAgeMs);
            assert.doesNotMatch(JSON.stringify(failure), /private|SELECT|FOR SHARE|postgres:/u);
            return true;
          });
        } finally { release(); await holder; }
      }
    }
    assert.equal(diagnostics.attempts, 4, "one bounded sample per wait, no retry");
    await database.transaction({ requestId: "fast", operation: "channel.channel_configure" }, tx =>
      tx.query({ name: "channel_mutation_root_lock_v2", text: "SELECT id FROM private_lock FOR UPDATE", maxRows: 1 }));
    assert.equal(diagnostics.attempts, 4, "fast queries open no diagnostic connection");
  } finally { await f.close(); }
});
