import pg from "pg";

/**
 * One REPEATABLE READ READ ONLY transaction on the primary database and on
 * each shard named by its environment variable, for an operational report.
 * `run` gets the clients, primary first; every client is closed afterwards.
 */
export async function withReadOnlyShards(shardUrlEnvs, env, statementTimeout, run) {
  const clients = [];
  try {
    for (const name of ["POSTGRES_RUNTIME_DATABASE_URL", ...shardUrlEnvs]) {
      if (!env[name]) throw new Error(`Missing environment ${name}`);
      const client = new pg.Client({ connectionString: env[name], connectionTimeoutMillis: 10000 });
      clients.push(client);
      await client.connect();
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query(`SET LOCAL statement_timeout='${statementTimeout}'`);
      await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
    }
    return await run(clients);
  } finally {
    await Promise.allSettled(clients.map(client => client.end()));
  }
}
