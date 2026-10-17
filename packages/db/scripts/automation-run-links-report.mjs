import { Client } from "pg";
import { requiredEnv, runIfInvoked, withClient, withClientTransaction } from "./cli.mjs";

// Read only and explicitly Space/window scoped. No payloads, names, credentials,
// historical repairs, or additional attribution ledger are produced.
async function main() {
  const [spaceId, from, to] = process.argv.slice(2);
  const duration = Date.parse(to) - Date.parse(from);
  if (!spaceId || !Number.isFinite(duration) || duration <= 0 || duration > 31 * 86400_000 || process.argv.length !== 5) {
    throw new Error("Usage: automation-run-links-report.mjs <space-id> <from-ISO> <to-ISO>; at most 31 days");
  }
  const client = new Client({ connectionString: requiredEnv("DATABASE_URL"),
    application_name: "xmatrix-automation-run-links-report", statement_timeout: 15_000,
    connectionTimeoutMillis: 10_000 });
  await client.connect();
  const report = await withClient(client, () => withClientTransaction(client, async () => {
    await client.query("SET TRANSACTION READ ONLY, ISOLATION LEVEL REPEATABLE READ");
    const values = [spaceId, from, to];
    const scoped = `SELECT o.* FROM data.automation_occurrences o
      JOIN data.automations a ON a.automation_id=o.automation_id
      JOIN data.channels c ON c.channel_id=a.channel_id
      WHERE c.space_id=$1 AND o.created_at>=$2 AND o.created_at<$3`;
    const totals = (await client.query(`WITH scoped AS (${scoped}) SELECT
      count(*)::int AS occurrences,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM data.automation_occurrence_runs l
        WHERE l.occurrence_id=o.occurrence_id AND l.space_id=$1))::int AS linked_occurrences,
      count(*) FILTER (WHERE o.delivery_kind='message' AND o.run_id IS NULL)::int AS messages_without_reservations,
      (SELECT count(*)::int FROM data.automation_occurrence_runs l JOIN scoped s USING(occurrence_id)
        WHERE l.space_id=$1) AS runs FROM scoped o`, values)).rows[0];
    const unlinked = (await client.query(`WITH scoped AS (${scoped}) SELECT o.occurrence_id,o.status,
      o.delivery_kind,EXISTS (SELECT 1 FROM data.registration_launch_intents p
        WHERE p.space_id=$1 AND p.channel_id=data.automation_occurrence_conversation_id(o.occurrence_id)
          AND p.source_message_id=o.message_id AND p.state='committed') AS committed_launch_exists
      FROM scoped o WHERE NOT EXISTS (SELECT 1 FROM data.automation_occurrence_runs l
        WHERE l.occurrence_id=o.occurrence_id AND l.space_id=$1)
      ORDER BY o.created_at,o.occurrence_id LIMIT 100`, values)).rows;
    const violations = (await client.query(`WITH scoped AS (${scoped}) SELECT count(*)::int AS count
      FROM data.automation_occurrence_runs l JOIN scoped o USING(occurrence_id)
      LEFT JOIN data.registration_launch_intents p ON p.run_id=l.run_id
      LEFT JOIN data.runs r ON r.run_id=l.run_id
      LEFT JOIN data.channels c ON c.channel_id=l.channel_id
      WHERE l.space_id IS DISTINCT FROM $1 OR c.space_id IS DISTINCT FROM $1
        OR r.run_id IS NULL OR r.channel_id IS DISTINCT FROM l.channel_id
        OR (o.delivery_kind='message' AND (p.state IS DISTINCT FROM 'committed'
          OR p.source_message_id IS DISTINCT FROM o.message_id OR p.space_id IS DISTINCT FROM $1
          OR p.channel_id IS DISTINCT FROM data.automation_occurrence_conversation_id(o.occurrence_id)))`, values)).rows[0].count;
    if (violations !== 0) throw new Error(`Run association boundary violations: ${violations}`);
    return { spaceId, from, to, ...totals, unlinkedOccurrences: unlinked,
      unlinkedSampleLimit: 100, boundaryViolations: violations };
  }));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

runIfInvoked(import.meta.url, main);
