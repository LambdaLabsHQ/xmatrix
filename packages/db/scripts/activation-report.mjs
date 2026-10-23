import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { withReadOnlyShards } from "./read-only-shards.mjs";

// Operational report only: identity classification is explicit, never inferred
// from email, activity, membership outside the configured team, or names.
export function summarizeActivation(users, facts, config, from, to) {
  const groups = Object.fromEntries(["internalOrTest", "confirmedExternal", "unclassified"].map(key =>
    [key, { registrations: 0, humanMessage: 0, firstReply: 0, pageCreated: 0,
      activatedWithPage: 0, weekTwoEligible: 0, weekTwoActive: 0 }]));
  const excluded = new Set(config.excludedUserIds);
  const external = new Set(config.externalUserIds);
  for (const user of users) {
    const fact = facts.get(user.id) ?? {};
    const group = groups[excluded.has(user.id) || fact.internal ? "internalOrTest"
      : external.has(user.id) ? "confirmedExternal" : "unclassified"];
    group.registrations++;
    for (const key of ["humanMessage", "firstReply", "pageCreated", "activatedWithPage"]) {
      if (fact[key]) group[key]++;
    }
    if (Date.parse(user.created_at) + 14 * 86400000 <= Date.parse(to)) {
      group.weekTwoEligible++;
      if (fact.weekTwoActive) group.weekTwoActive++;
    }
  }
  return { from, to, cohorts: groups };
}

function validateConfig(config) {
  for (const key of ["excludedUserIds", "externalUserIds", "internalSpaceIds", "shardUrlEnvs"]) {
    if (!Array.isArray(config[key]) || config[key].length > 1000 ||
        config[key].some(value => typeof value !== "string" || !value || value.length > 300)) {
      throw new Error(`Invalid ${key}`);
    }
  }
  if (config.externalUserIds.some(id => config.excludedUserIds.includes(id))) {
    throw new Error("External and excluded classifications overlap");
  }
  if (config.shardUrlEnvs.length > 31 || new Set(config.shardUrlEnvs).size !== config.shardUrlEnvs.length) {
    throw new Error("Supply each shard environment once");
  }
}

export async function readActivationReport(config, from, to, env = process.env) {
  validateConfig(config);
  const start = Date.parse(from), end = Date.parse(to);
  if (![from, to].every(value => typeof value === "string" && /T.*(?:Z|\+00:00)$/.test(value)) ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 90 * 86400000) {
    throw new Error("Supply a UTC registration window of at most 90 days");
  }
  return withReadOnlyShards(config.shardUrlEnvs, env, "15s", async (clients) => {
    const control = clients[0];
    const placements = (await control.query(`SELECT space_id,shard_id,state
      FROM control.space_placement ORDER BY space_id LIMIT 10001`)).rows;
    if (placements.length > 10000) throw new Error("Space placement exceeds report bound");
    if (placements.some(row => row.state !== "active")) throw new Error("Space placement is not stable");
    const users = (await control.query(`SELECT id,created_at FROM control.auth_users
      WHERE created_at >= $1 AND created_at < $2 ORDER BY created_at,id LIMIT 10001`, [from, to])).rows;
    if (users.length > 10000) throw new Error("Registration cohort exceeds 10000; narrow the window");
    const facts = new Map();
    const visited = new Set();
    for (const client of clients) {
      const identity = (await client.query("SELECT shard_id FROM control.postgres_local_identity")).rows;
      if (identity.length !== 1 || visited.has(identity[0].shard_id)) throw new Error("Duplicate or missing shard identity");
      const shard = identity[0].shard_id;
      visited.add(shard);
      const spaces = placements.filter(row => row.shard_id === shard).map(row => row.space_id);
      const rows = (await client.query(`WITH cohort AS (
        SELECT * FROM unnest($1::text[],$2::timestamptz[]) AS c(id,registered_at)
      ), human AS (
        SELECT m.author_id,m.space_id,m.message_id,m.channel_id,m.sent_at
        FROM data.messages m JOIN cohort c ON c.id=m.author_id
        WHERE m.space_id=ANY($3::text[]) AND m.author_kind='user'
          AND m.message_id NOT LIKE 'scheduled-message:%' AND m.message_id NOT LIKE 'system:%'
          AND m.deleted_at IS NULL AND m.recalled_at IS NULL
          AND m.sent_at >= c.registered_at AND m.sent_at < $4
      ) SELECT c.id,
        EXISTS(SELECT 1 FROM data.space_members s WHERE s.user_id=c.id
          AND s.space_id=ANY($5::text[]) AND s.space_id=ANY($3::text[])) AS internal,
        EXISTS(SELECT 1 FROM human h WHERE h.author_id=c.id) AS "humanMessage",
        EXISTS(SELECT 1 FROM human h JOIN data.agent_launches l ON l.space_id=h.space_id
          AND l.channel_id=h.channel_id AND l.trigger_id=h.message_id
          WHERE h.author_id=c.id AND l.first_reply_at >= h.sent_at AND l.first_reply_at < $4) AS "firstReply",
        EXISTS(SELECT 1 FROM data.pages p WHERE p.created_by_user_id=c.id AND p.space_id=ANY($3::text[])
          AND p.created_at >= c.registered_at AND p.created_at < $4) AS "pageCreated",
        EXISTS(SELECT 1 FROM human h JOIN data.agent_launches l ON l.space_id=h.space_id
          AND l.channel_id=h.channel_id AND l.trigger_id=h.message_id
          JOIN data.pages p ON p.space_id=h.space_id AND p.created_by_user_id=c.id
          WHERE h.author_id=c.id AND l.first_reply_at >= h.sent_at
          AND p.created_at >= l.first_reply_at AND p.created_at < $4) AS "activatedWithPage",
        EXISTS(SELECT 1 FROM human h WHERE h.author_id=c.id
          AND h.sent_at >= c.registered_at + interval '7 days'
          AND h.sent_at < c.registered_at + interval '14 days') AS "weekTwoActive"
      FROM cohort c`, [users.map(row => row.id), users.map(row => row.created_at), spaces, to,
        config.internalSpaceIds])).rows;
      for (const row of rows) {
        const fact = facts.get(row.id) ?? {};
        for (const [key, value] of Object.entries(row)) if (key !== "id") fact[key] ||= value;
        facts.set(row.id, fact);
      }
    }
    if (placements.some(row => !visited.has(row.shard_id))) throw new Error("Incomplete shard coverage");
    return { ...summarizeActivation(users, facts, config, from, to), coveredShards: visited.size };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [configPath, from, to, ...extra] = process.argv.slice(2);
    if (!configPath || extra.length) throw new Error("Usage: activation-report.mjs <private-config.json> <from UTC> <to UTC>");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    console.log(JSON.stringify(await readActivationReport(config, from, to), null, 2));
  } catch {
    // Driver errors may contain credentials, SQL parameters or private IDs.
    console.error("Activation report failed; verify config, UTC window, shard coverage and database access.");
    process.exitCode = 1;
  }
}
