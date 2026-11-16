import { integration, isolatedPostgres } from "./postgres-database.fixture.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { maintainMachineResourceHistory, readMachineResourceHistory } from "../dist/index.js";
import { machineResourceHistoryInsert, machineResourceHistorySamples } from "../dist/machine-control.js";

const HOUR = 3_600_000;

integration("Machine resource history is owner-scoped, rolled up hourly and pruned by age", async () => {
  const isolated = await isolatedPostgres("machine_resource_history", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.machines (owner_user_id text, machine_id text);
      INSERT INTO data.machines VALUES ('alice','machine:a'), ('bob','machine:b');`);
    await client.query(await readFile(new URL("../migrations/0165_expand_machine_resource_history.sql", import.meta.url), "utf8"));
    // Holds each query to the Hub client's contract: at most 10000 result rows, and no more than it declared.
    const database = { transaction: async (_context, callback) =>
      callback({ query: async ({ text, values, maxRows }) => {
        assert.ok(Number.isSafeInteger(maxRows) && maxRows >= 0 && maxRows <= 10_000, `maxRows ${maxRows} is outside the client contract`);
        const { rows } = await client.query(text, values);
        assert.ok(rows.length <= maxRows);
        return rows;
      } }) };

    const now = Date.parse("2026-10-07T12:30:00Z");
    const insert = (owner, machine, at, cpu, memoryAvailable) => client.query(`INSERT INTO
      data.machine_resource_samples (owner_user_id,machine_id,observed_at,cpu_usage_percent,load_average_1m,
        memory_total_bytes,memory_available_bytes,disk_total_bytes,disk_available_bytes)
      VALUES ($1,$2,$3,$4,1.5,1000,$5,100,40)`, [owner, machine, new Date(at).toISOString(), cpu, memoryAvailable]);
    await insert("alice", "machine:a", now - 10 * 60_000, 20, 750);
    await insert("alice", "machine:a", now - 9 * 60_000, 80, 250);
    await insert("alice", "machine:a", now - 2 * HOUR, 40, 500);
    await insert("alice", "machine:a", now - 8 * 24 * HOUR, 99, 0);
    await insert("bob", "machine:b", now - 5 * 60_000, 10, 900);

    const hour = await readMachineResourceHistory(database, {
      requestId: "r", ownerUserId: "alice", machineId: "machine:a", range: "1h", now });
    assert.equal(hour.resolution, "minute");
    assert.deepEqual(hour.points.map(point => [point.cpuPercent, point.memoryPercent, point.diskPercent]),
      [[20, 25, 60], [80, 75, 60]]);
    assert.equal(hour.points[0].loadAverage1m, 1.5);

    // Before maintenance, a long range aggregates the minute rows still there.
    const pending = await readMachineResourceHistory(database, {
      requestId: "r", ownerUserId: "alice", machineId: "machine:a", range: "7d", now });
    assert.equal(pending.resolution, "hour");
    assert.deepEqual(pending.points.map(point => [point.at, point.cpuPercent, point.cpuPercentMax]), [
      ["2026-10-07T10:00:00.000Z", 40, 40],
      ["2026-10-07T12:00:00.000Z", 50, 80],
    ]);

    // Another owner's Machine reads as missing, never as empty history.
    await assert.rejects(readMachineResourceHistory(database, {
      requestId: "r", ownerUserId: "alice", machineId: "machine:b", range: "1h", now }),
    error => error.code === "machine_not_found" && error.status === 404);

    const first = await maintainMachineResourceHistory(database, { requestId: "m", now });
    assert.equal(first.prunedSamples, 1, "only the sample older than 7 days goes");
    const again = await maintainMachineResourceHistory(database, { requestId: "m", now });
    assert.equal(again.prunedSamples, 0);
    assert.deepEqual((await client.query(`SELECT machine_id, hour_start, sample_count FROM data.machine_resource_hourly
      ORDER BY machine_id, hour_start`)).rows.map(row => [row.machine_id, row.hour_start.toISOString(), row.sample_count]),
    [["machine:a", "2026-10-07T10:00:00.000Z", 1]], "only completed hours roll up, once");

    // Rolled-up hours and the current hour's minute rows read as one series.
    const rolled = await readMachineResourceHistory(database, {
      requestId: "r", ownerUserId: "alice", machineId: "machine:a", range: "30d", now });
    assert.deepEqual(rolled.points.map(point => point.at), ["2026-10-07T10:00:00.000Z", "2026-10-07T12:00:00.000Z"]);

    await client.query(`INSERT INTO data.machine_resource_hourly (owner_user_id,machine_id,hour_start,sample_count)
      VALUES ('alice','machine:a',$1,1)`, [new Date(now - 91 * 24 * HOUR).toISOString()]);
    assert.equal((await maintainMachineResourceHistory(database, { requestId: "m", now })).prunedHours, 1);
  } finally {
    await isolated.close();
  }
});

integration("A report's batched minute samples land in one statement, only for the live connection", async () => {
  const isolated = await isolatedPostgres("machine_resource_history_batch", { migrate: false, runtimeRole: false });
  const { client } = isolated;
  try {
    await client.query(`CREATE SCHEMA data;
      CREATE TABLE data.machines (owner_user_id text, machine_id text);
      CREATE TABLE data.machine_daemons (daemon_id text, status text, connection_epoch bigint);
      INSERT INTO data.machine_daemons VALUES ('daemon-a','online',4);`);
    await client.query(await readFile(new URL("../migrations/0165_expand_machine_resource_history.sql", import.meta.url), "utf8"));
    const now = Date.parse("2026-11-06T08:00:30Z");
    const sample = (offset, cpu) => ({ observedAt: new Date(now - offset).toISOString(), cpuUsagePercent: cpu,
      loadAverage: [0.5, 0.5, 0.5], memoryTotalBytes: 1000, memoryAvailableBytes: 400,
      diskTotalBytes: 100, diskAvailableBytes: 30 });
    const samples = machineResourceHistorySamples(sample(0, 50), [sample(2 * 60_000, 10), sample(60_000, 20)], now);
    const write = (connectionEpoch, rows) => client.query(machineResourceHistoryInsert({ ownerUserId: "alice",
      machineId: "machine:a", daemonId: "daemon-a", connectionEpoch, samples: rows }));
    await write(4, samples);
    // A replaced connection writes nothing; the same minute again updates in place.
    await write(3, machineResourceHistorySamples(sample(0, 99), [], now));
    await write(4, machineResourceHistorySamples(sample(0, 60), [], now));
    const { rows } = await client.query(`SELECT observed_at, cpu_usage_percent, load_average_1m, memory_available_bytes
      FROM data.machine_resource_samples ORDER BY observed_at`);
    assert.deepEqual(rows.map(row => [row.observed_at.toISOString(), row.cpu_usage_percent, row.load_average_1m,
      Number(row.memory_available_bytes)]), [
      ["2026-11-06T07:58:00.000Z", 10, 0.5, 400],
      ["2026-11-06T07:59:00.000Z", 20, 0.5, 400],
      ["2026-11-06T08:00:00.000Z", 60, 0.5, 400],
    ]);
  } finally {
    await isolated.close();
  }
});
