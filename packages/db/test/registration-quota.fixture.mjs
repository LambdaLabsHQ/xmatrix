import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { connectionString as url } from "./postgres-database.fixture.mjs";

/** The registration and quota tables, migrated into one private schema, with
 * the daemon tables the quota probe reads. `sql` and `rewrite` address it. */
export async function registrationQuotaSchema(prefix) {
  const schema = `${prefix}_${process.pid}`;
  const setup = new Client({ connectionString: url }); await setup.connect();
  const rewrite = text => text.replaceAll("data.", `${schema}.`).replaceAll("control.", `${schema}.`);
  const sql = (text, values) => setup.query(rewrite(text), values);
  await setup.query(`CREATE SCHEMA ${schema}`);
  for (const file of ["0059_expand_agent_registration_keys.sql", "0060_expand_registration_access.sql",
    "0063_expand_registration_authority.sql", "0065_expand_registration_environment.sql",
    "0071_expand_registration_quota_observations.sql", "0119_expand_registration_quota_windows.sql",
    "0158_expand_registration_quota_account.sql", "0236_expand_registration_quota_waiters.sql"]) {
    await sql(await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  }
  await sql(`CREATE TABLE data.machine_daemons (daemon_id text,owner_user_id text,machine_id text,hostname text,status text,
      capabilities_json jsonb,connection_epoch bigint);
    CREATE TABLE data.machine_daemon_commands (command_id text,owner_user_id text,machine_id text,hostname text,
      command_type text,created_at timestamptz)`);
  return { sql, rewrite, close: async () => {
    await setup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await setup.end();
  } };
}
