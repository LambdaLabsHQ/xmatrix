import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectionString, integration } from "./postgres-database.fixture.mjs";

import { Client } from "pg";

import { allocateInstanceOrdinals, instanceOrdinalFor, reserveNaturalKey } from "../dist/index.js";

const at = "2026-09-25T00:00:00.000Z";

async function transaction(client, work) {
  const tx = { query: async ({ text, values }) => (await client.query(text, values)).rows };
  await client.query("BEGIN");
  try {
    const result = await work(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function instance(client, channelId, ordinal) {
  const runId = `${channelId}:${ordinal}#1`;
  await client.query(`INSERT INTO data.runs (run_id,owner_user_id,channel_id,status,version,created_at,updated_at)
    VALUES ($1,'owner',$2,'running',1,$3,$3)`, [runId, channelId, at]);
  await client.query(`INSERT INTO data.instances (instance_id,run_id,channel_id,channel_instance_id,status,version,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'online',1,$5,$5)`, [`${channelId}:${ordinal}`, runId, channelId, ordinal, at]);
}

integration("reservations mint natural ids, replay exactly, and never reuse an ordinal", async () => {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const channelId = `natural-${randomUUID()}`;
    // An ordinal written before the counter existed, and a historical backfill address.
    await instance(client, channelId, 4);
    await instance(client, channelId, 8000000000000123);

    const reserve = (creationKey, scope, channelInstanceId) => transaction(client, tx =>
      reserveNaturalKey(tx, { creationKey, channelId, scope, at, ...(channelInstanceId ? { channelInstanceId } : {}) }));
    const first = await reserve(`summon:${channelId}:a`, "instance");
    assert.deepEqual(first, { channelId, channelInstanceId: 5, runOrdinal: 1,
      instanceId: `${channelId}:5`, runId: `${channelId}:5#1` });
    assert.deepEqual(await reserve(`summon:${channelId}:a`, "instance"), first, "a replay receives the same ids");
    await assert.rejects(reserve(`summon:${channelId}:a`, "about"), error => error.code === "natural_key_mismatch");

    // A legacy allocator in the same Channel continues after the reservation.
    assert.equal(await transaction(client, tx => allocateInstanceOrdinals(tx, channelId, 2)), 6);
    assert.equal(await transaction(client, tx => instanceOrdinalFor(tx, channelId, `${channelId}:5`)), 5,
      "a natural id carries its own ordinal");
    assert.equal(await transaction(client, tx => instanceOrdinalFor(tx, channelId, "not-natural")), 8);

    await instance(client, channelId, 5);
    const reborn = await reserve(`reborn:${channelId}:a`, "run", 5);
    assert.deepEqual([reborn.instanceId, reborn.runId, reborn.runOrdinal], [`${channelId}:5`, `${channelId}:5#2`, 2]);
    assert.equal((await reserve(`reborn:${channelId}:b`, "run", 5)).runId, `${channelId}:5#3`);
    assert.equal((await reserve(`reborn:${channelId}:legacy`, "run", 4)).runId, `${channelId}:4#2`,
      "an Instance that predates its counter is on its first Run");
    await assert.rejects(reserve(`reborn:${channelId}:missing`, "run", 99), error => error.code === "natural_key_instance_missing");

    const about = await reserve(`about:${channelId}:a`, "about");
    assert.deepEqual([about.instanceId, about.runId], [null, `${channelId}:about#1`]);
    assert.equal((await reserve(`about:${channelId}:b`, "about")).runId, `${channelId}:about#2`);
  } finally {
    await client.end();
  }
});

integration("concurrent reservations in one Channel never share an ordinal", async () => {
  const clients = await Promise.all(Array.from({ length: 8 }, async () => {
    const client = new Client({ connectionString });
    await client.connect();
    return client;
  }));
  try {
    const channelId = `natural-${randomUUID()}`;
    const reservations = await Promise.all(clients.map((client, index) => transaction(client, tx =>
      reserveNaturalKey(tx, { creationKey: `summon:${channelId}:${index}`, channelId, scope: "instance", at }))));
    assert.deepEqual(reservations.map(row => row.channelInstanceId).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await Promise.all(clients.map(client => client.end()));
  }
});

integration("a due Automation records its occurrence under a reserved natural key", async () => {
  const { createAuthorityDatabase, PostgresAutomationRepository } = await import("../dist/index.js");
  const client = new Client({ connectionString });
  await client.connect();
  const channelId = `natural-${randomUUID()}`, automationId = `automation-${randomUUID()}`;
  try {
    const columns = async (table) => (await client.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema='data' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL`, [table])).rows;
    const insert = async (table, values) => {
      const defaults = { text: "x", bigint: 1, integer: 1, boolean: false, jsonb: {}, "timestamp with time zone": at };
      const row = { ...Object.fromEntries((await columns(table)).map(c => [c.column_name, defaults[c.data_type] ?? "x"])), ...values };
      const keys = Object.keys(row);
      await client.query(`INSERT INTO data.${table} (${keys.join(",")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(",")})`,
        keys.map(key => row[key] !== null && typeof row[key] === "object" ? JSON.stringify(row[key]) : row[key]));
    };
    await insert("channels", { channel_id: channelId, space_id: `space-${channelId}`, archived_at: null,
      search_rank_sequence: Math.floor(Math.random() * 2 ** 40) });
    await insert("automations", { automation_id: automationId, channel_id: channelId, enabled: true, version: 1,
      next_run_at: at, owner_user_id: "owner", payload_json: { intervalMinutes: 60, input: {} } });
    const database = createAuthorityDatabase({ connectionString, shardId: "shard-0" });
    await new PostgresAutomationRepository(database).maintain({ requestId: randomUUID(), now: "2026-09-25T00:01:00.000Z",
      runTimeoutMs: 60_000 });
    const occurrence = (await client.query(`SELECT run_id,instance_id FROM data.automation_occurrences WHERE automation_id=$1`,
      [automationId])).rows[0];
    assert.deepEqual(occurrence, { run_id: `${channelId}:1#1`, instance_id: `${channelId}:1` });
  } finally {
    await client.query("DELETE FROM data.automation_occurrences WHERE automation_id=$1", [automationId]);
    await client.query("DELETE FROM data.automations WHERE automation_id=$1", [automationId]);
    await client.end();
  }
});
