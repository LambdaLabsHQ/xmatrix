#!/usr/bin/env node

import process from "node:process";

import { Client } from "pg";

import { requiredEnv, runIfInvoked, withClientTransaction, withClient } from "./cli.mjs";

const KNOWN_STATES = new Set(["active", "draining", "offline"]);


function shardId(source = process.env) {
  const value = requiredEnv("POSTGRES_SHARD_ID", source);
  if (value.length > 300 || !/^[A-Za-z0-9._:-]+$/u.test(value)) {
    throw new Error("POSTGRES_SHARD_ID is invalid");
  }
  return value;
}

export function admissionCommand(argv, source = process.env) {
  if (argv.length !== 1 || !new Set(["show", "active", "draining"]).has(argv[0])) {
    throw new Error("Usage: shard-admission.mjs <show|active|draining>");
  }
  const target = argv[0];
  const shard = shardId(source);
  if (target !== "show") {
    const expected = `SET POSTGRES SHARD ${shard} ADMISSION TO ${target}`;
    if (source.POSTGRES_SHARD_ADMISSION_CONFIRMATION !== expected) {
      throw new Error(`set POSTGRES_SHARD_ADMISSION_CONFIRMATION to '${expected}'`);
    }
  }
  return { shard, target };
}

async function connect(source = process.env) {
  const client = new Client({
    connectionString: requiredEnv("DATABASE_URL", source),
    connectionTimeoutMillis: 5_000,
    query_timeout: 30_000,
    application_name: "xmatrix-shard-admission-operator",
  });
  await client.connect();
  return client;
}

async function readState(client, shard, lock = false) {
  const result = await client.query(`SELECT shard_id,state,capacity_class,updated_at
    FROM control.postgres_shards WHERE shard_id=$1${lock ? " FOR UPDATE" : ""}`, [shard]);
  if (result.rows.length !== 1 || !KNOWN_STATES.has(result.rows[0].state)) {
    throw new Error(`PostgreSQL shard ${shard} is missing or has unsupported state`);
  }
  return result.rows[0];
}

export async function executeAdmission(client, command) {
  if (command.target === "show") return readState(client, command.shard);
  return withClientTransaction(client, async () => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('xmatrix-postgres-shard-admission', 0))",
    );
    const before = await readState(client, command.shard, true);
    const result = await client.query(`UPDATE control.postgres_shards
      SET state=$2,updated_at=clock_timestamp()
      WHERE shard_id=$1 RETURNING shard_id,state,capacity_class,updated_at`,
    [command.shard, command.target]);
    return { ...result.rows[0], previousState: before.state };
  });
}

export async function run(argv = process.argv.slice(2), source = process.env) {
  const command = admissionCommand(argv, source);
  const client = await connect(source);
  return withClient(client, async () => {
    const result = await executeAdmission(client, command);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  });
}

runIfInvoked(import.meta.url, run);
