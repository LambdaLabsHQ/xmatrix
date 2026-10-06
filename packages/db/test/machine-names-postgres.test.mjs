import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

import { MachineNameError, getMachineName, nameMachine, rejoinMachine, renameMachine, retireMachine } from "../dist/index.js";
import { ensureMachineName, requireMachineName } from "../dist/machine-names.js";

// 0085 names every known Machine once per owner; later sightings never rename
// it, and renaming changes that one row only.

integration("Machine names are backfilled, assigned once, owner-unique and renamable", async () => {
  const isolated = await isolatedPostgres("machine_names", { migrate: false, runtimeRole: false });
  const { client, url } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.machine_daemons (daemon_id text, owner_user_id text, machine_id text, host_id text,
        host_name text, created_at timestamptz, updated_at timestamptz);
      CREATE TABLE data.agent_registrations (owner_user_id text, machine_id text, harness text, created_at timestamptz);
      INSERT INTO data.machine_daemons VALUES
        ('d1','alice','machine:a','studio.local','Studio','2026-01-01','2026-01-01'),
        ('d2','alice','machine:a','studio-renamed','Studio 2','2026-01-01','2026-02-01'),
        ('d3','alice','machine:b','laptop','studio 2','2026-03-01','2026-03-01'),
        ('d4','bob','machine:c','laptop','Studio 2','2026-03-01','2026-03-01'),
        ('d5','alice','machine:d','',NULL,'2026-04-01','2026-04-01');
      INSERT INTO data.agent_registrations VALUES ('alice','machine:e','codex','2026-05-01');`);
    for (const migration of ["0085_expand_machines", "0087_expand_machine_parent", "0121_expand_machine_retirement"]) {
      await client.query(await readFile(new URL(`../migrations/${migration}.sql`, import.meta.url), "utf8"));
    }
    const names = async () => Object.fromEntries((await client.query(
      "SELECT owner_user_id||'/'||machine_id AS key, name FROM data.machines ORDER BY key")).rows
      .map(row => [row.key, row.name]));
    assert.deepEqual(await names(), {
      // The latest daemon's host name; the earliest Machine keeps the bare name
      // and a case-insensitive collision in the same owner is suffixed.
      "alice/machine:a": "Studio 2", "alice/machine:b": "studio 2-2",
      "alice/machine:d": "machine", "alice/machine:e": "machine-2",
      // Another owner may repeat a name.
      "bob/machine:c": "Studio 2",
    });

    const tx = { query: async ({ text, values }) => (await client.query(text, values)).rows };
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:a", hostName: "New host", hostId: "x" });
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:f", hostName: "Studio 2", hostId: "x" });
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:g", hostName: null, hostId: "wsl\u0007box" });
    const assigned = await names();
    assert.equal(assigned["alice/machine:a"], "Studio 2", "a host name change is not a rename");
    assert.equal(assigned["alice/machine:f"], "Studio 2-3");
    assert.equal(assigned["alice/machine:g"], "wslbox");

    // A WSL daemon records its Windows host; a non-derived parent is ignored.
    const host = `machine:${"b".repeat(64)}`;
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:g", hostId: "x", parentMachineId: host });
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:f", hostId: "x", parentMachineId: "machine:a" });
    assert.deepEqual((await client.query("SELECT machine_id, parent_machine_id FROM data.machines WHERE parent_machine_id IS NOT NULL"))
      .rows, [{ machine_id: "machine:g", parent_machine_id: host }]);

    await requireMachineName(tx, { ownerUserId: "alice", machineId: "machine:a" });
    await assert.rejects(requireMachineName(tx, { ownerUserId: "bob", machineId: "machine:a" }),
      error => error.code === "machine_name_required");
    await assert.rejects(requireMachineName(tx, { ownerUserId: "alice", machineId: "machine:uncreated" }),
      error => error.code === "machine_name_required");

    const database = { cacheMode: "disabled", transaction: async (_context, callback) => callback(tx) };
    assert.deepEqual(await renameMachine(database, { requestId: "r1", ownerUserId: "alice",
      machineId: "machine:a", name: "  Build box " }), { machineId: "machine:a", name: "Build box" });
    await assert.rejects(renameMachine(database, { requestId: "r2", ownerUserId: "alice",
      machineId: "machine:b", name: "BUILD BOX" }), error => error instanceof MachineNameError && error.code === "machine_name_taken");
    await assert.rejects(renameMachine(database, { requestId: "r3", ownerUserId: "alice",
      machineId: "machine:b", name: "bad\nname" }), error => error.code === "invalid_machine_name");
    await assert.rejects(renameMachine(database, { requestId: "r4", ownerUserId: "bob",
      machineId: "machine:a", name: "Mine" }), error => error.code === "machine_not_found");
    // Renaming to its own name in another case is not a collision.
    assert.equal((await renameMachine(database, { requestId: "r5", ownerUserId: "alice",
      machineId: "machine:a", name: "build box" })).name, "build box");

    const derived = `machine:${"a".repeat(64)}`;
    assert.deepEqual(await getMachineName(database, { requestId: "get-before", ownerUserId: "alice", machineId: derived }),
      { machineId: derived, name: null });
    assert.deepEqual(await nameMachine(database, { requestId: "create-name", ownerUserId: "alice",
      machineId: derived, name: "  My laptop  " }), { machineId: derived, name: "My laptop" });
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: derived, hostId: "os-hostname" });
    assert.equal((await getMachineName(database, { requestId: "get-after", ownerUserId: "alice", machineId: derived })).name,
      "My laptop", "enrollment preserves the name chosen before creation");
    assert.equal((await getMachineName(database, { requestId: "other-owner", ownerUserId: "bob", machineId: derived })).name,
      null, "another owner never supplies the Machine's name");
    const before = (await client.query("SELECT renamed_at FROM data.machines WHERE owner_user_id='alice' AND machine_id=$1", [derived])).rows[0];
    await nameMachine(database, { requestId: "repeat-name", ownerUserId: "alice", machineId: derived, name: "My laptop" });
    assert.deepEqual((await client.query("SELECT renamed_at FROM data.machines WHERE owner_user_id='alice' AND machine_id=$1", [derived])).rows[0], before);
    await assert.rejects(nameMachine(database, { requestId: "legacy-create", ownerUserId: "alice",
      machineId: "machine:11111111-1111-4111-8111-111111111111", name: "Old" }),
    error => error.code === "invalid_machine_identity");
    await assert.rejects(nameMachine(database, { requestId: "duplicate-create", ownerUserId: "alice",
      machineId: `machine:${"c".repeat(64)}`, name: "MY LAPTOP" }), error => error.code === "machine_name_taken");

    // Independent real transactions race on the same owner's case-insensitive name.
    const concurrentDatabase = { cacheMode: "disabled", transaction: async (_context, callback) => {
      const connection = new Client({ connectionString: url.toString() });
      await connection.connect();
      try {
        await connection.query("BEGIN");
        const result = await callback({ query: async ({ text, values }) => (await connection.query(text, values)).rows });
        await connection.query("COMMIT");
        return result;
      } catch (error) {
        await connection.query("ROLLBACK");
        throw error;
      } finally { await connection.end(); }
    } };
    const raced = await Promise.allSettled(["d", "e"].map((suffix, index) => nameMachine(concurrentDatabase, {
      requestId: `race-${suffix}`, ownerUserId: "alice", machineId: `machine:${suffix.repeat(64)}`,
      name: index === 0 ? "Concurrent" : "CONCURRENT",
    })));
    assert.equal(raced.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(raced.find(result => result.status === "rejected").reason.code, "machine_name_taken");
    assert.equal((await client.query("SELECT count(*)::int AS count FROM data.machines WHERE owner_user_id='alice' AND lower(name)='concurrent'"))
      .rows[0].count, 1);

    // Removing a Machine keeps its row and name; only an explicit rejoin brings it back.
    const retired = await retireMachine(database, { requestId: "r6", ownerUserId: "alice", machineId: "machine:a" });
    assert.equal((await retireMachine(database, { requestId: "r7", ownerUserId: "alice", machineId: "machine:a" }))
      .retiredAt, retired.retiredAt, "a replay keeps the first retirement time");
    await assert.rejects(retireMachine(database, { requestId: "r8", ownerUserId: "bob", machineId: "machine:a" }),
      error => error.code === "machine_not_found");
    await ensureMachineName(tx, { ownerUserId: "alice", machineId: "machine:a", hostName: "Other", hostId: "x" });
    assert.deepEqual((await client.query("SELECT name, retired_at IS NOT NULL AS retired FROM data.machines WHERE owner_user_id='alice' AND machine_id='machine:a'")).rows,
      [{ name: "build box", retired: true }]);
    assert.equal((await rejoinMachine(database, { requestId: "r9", ownerUserId: "alice", machineId: "machine:a" })).rejoined, true);
    assert.equal((await rejoinMachine(database, { requestId: "r10", ownerUserId: "alice", machineId: "machine:a" })).rejoined, false);

    // XMATRIX-HUB-41: a named Machine's daemon check must not wait on the owner
    // name lock. First assignment still takes it, so a suffix race cannot commit
    // two Machines under one name.
    const holder = new Client({ connectionString: url.toString() });
    const reader = new Client({ connectionString: url.toString() });
    await holder.connect();
    await reader.connect();
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('machine-names:'||$1,0))", ["alice"]);
      await reader.query("BEGIN");
      await reader.query("SET LOCAL lock_timeout = '200ms'");
      const reading = { query: async ({ text, values }) => (await reader.query(text, values)).rows };
      const started = Date.now();
      await requireMachineName(reading, { ownerUserId: "alice", machineId: "machine:a" });
      await ensureMachineName(reading, { ownerUserId: "alice", machineId: "machine:a",
        hostName: "Blocked", hostId: "x" });
      assert.ok(Date.now() - started < 1_000, "a named Machine waited on the owner name lock");
      assert.equal((await reader.query(
        "SELECT name FROM data.machines WHERE owner_user_id='alice' AND machine_id='machine:a'")).rows[0].name,
      "build box");
      await assert.rejects(ensureMachineName(reading, { ownerUserId: "alice", machineId: "machine:locked",
        hostName: "Locked", hostId: "x" }), error => error.code === "55P03");
    } finally {
      await reader.query("ROLLBACK").catch(() => {});
      await holder.query("ROLLBACK").catch(() => {});
      await reader.end().catch(() => {});
      await holder.end().catch(() => {});
    }
  } finally { await isolated.close(); }
});
