import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { withReadOnlyShards } from "./read-only-shards.mjs";

/*
 * How far each new account got, step by step, and what stopped it
 * (docs/operations/new-user-funnel.md). Read-only, metadata only: no name,
 * email, message, page or prompt text leaves the database. A person is a
 * short hash of their id; failures are codes, never the error text.
 */

const STAGES = ["registered", "space", "machine", "agents", "message", "reply", "page"];

/** What the first browser or client a person signed in with was. */
export function deviceOf(userAgent) {
  const ua = String(userAgent ?? "");
  if (/xMatrix\/\d|Electron\//u.test(ua)) return "desktop_app";
  if (/iPhone|Android.+Mobile|iPad/u.test(ua)) return "phone";
  if (/^xMatrix (CLI|device sign-in|app)/u.test(ua)) return "cli";
  if (/Mozilla\//u.test(ua)) return "desktop_web";
  return "unknown";
}

export function platformOf(userAgent) {
  const ua = String(userAgent ?? "");
  if (/iPhone|iPad/u.test(ua)) return "ios";
  if (/Android/u.test(ua)) return "android";
  if (/Macintosh|Mac OS X|macos/u.test(ua)) return "macos";
  if (/Windows|windows/u.test(ua)) return "windows";
  if (/Linux|X11/u.test(ua)) return "linux";
  return "unknown";
}

/** A turn failure's class, read from the notice xMatrix wrote, never shown. */
export function turnFailureClass(body) {
  const text = String(body ?? "").toLowerCase();
  if (/failed to authenticate|oauth|not logged in|\/login|invalid api key|authentication/u.test(text)) return "harness_signed_out";
  if (/usage limit|quota|rate limit/u.test(text)) return "usage_limited";
  return "turn_failed";
}

export function personKey(userId) {
  return createHash("sha256").update(String(userId)).digest("hex").slice(0, 10);
}

/** The furthest step a person reached, and the per-stage counts. */
export function summarizeFunnel(people) {
  const reached = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  for (const person of people) {
    const index = STAGES.indexOf(person.stage);
    for (let i = 0; i <= index; i++) reached[STAGES[i]]++;
  }
  const stoppedAt = Object.fromEntries(STAGES.map(stage => [stage, people.filter(p => p.stage === stage).length]));
  return { people: people.length, reached, stoppedAt };
}

function stageOf(fact) {
  if (fact.pages > 0) return "page";
  if (fact.firstReplyAt) return "reply";
  if (fact.humanMessages > 0) return "message";
  if (fact.agents.length > 0) return "agents";
  if (fact.machines > 0) return "machine";
  if (fact.spaces > 0) return "space";
  return "registered";
}

export async function readNewUserFunnel(from, to, shardUrlEnvs = [], env = process.env) {
  const start = Date.parse(from), end = Date.parse(to);
  if (![from, to].every(value => typeof value === "string" && /T.*(?:Z|\+00:00)$/u.test(value)) ||
      !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 31 * 86400000) {
    throw new Error("Supply a UTC registration window of at most 31 days");
  }
  return withReadOnlyShards(shardUrlEnvs, env, "20s", async (clients) => {
    const control = clients[0];
    const users = (await control.query(`SELECT u.id, u.created_at,
        (SELECT s.user_agent FROM control.auth_sessions s WHERE s.user_id=u.id AND s.user_agent IS NOT NULL
          AND s.user_agent<>'' ORDER BY s.created_at LIMIT 1) AS first_agent
      FROM control.auth_users u WHERE u.created_at >= $1 AND u.created_at < $2
      ORDER BY u.created_at, u.id LIMIT 2001`, [from, to])).rows;
    if (users.length > 2000) throw new Error("More than 2000 registrations; narrow the window");
    const ids = users.map(user => user.id);
    const facts = new Map(users.map(user => [user.id, {
      spaces: 0, machines: 0, daemonOnline: false, agents: [], agentLogin: {}, humanMessages: 0,
      launches: 0, startupFailures: [], turnFailures: [], firstReplyAt: null, pages: 0,
    }]));
    for (const client of clients) {
      const rows = (await client.query(`WITH cohort AS (SELECT unnest($1::text[]) AS id),
        member AS (SELECT s.user_id, s.space_id FROM data.space_members s JOIN cohort c ON c.id=s.user_id)
      SELECT c.id,
        (SELECT count(*)::int FROM member m WHERE m.user_id=c.id) AS spaces,
        (SELECT count(*)::int FROM data.machines x WHERE x.owner_user_id=c.id AND x.retired_at IS NULL) AS machines,
        EXISTS(SELECT 1 FROM data.machine_daemons d WHERE d.owner_user_id=c.id AND d.status='online') AS daemon_online,
        (SELECT coalesce(json_agg(json_build_object('harness', h->>'id', 'login', h->>'login')), '[]')
          FROM data.machine_daemons d, jsonb_array_elements(coalesce(d.metadata_json->'harnesses'->'items','[]')) h
          WHERE d.owner_user_id=c.id AND (h->>'installed')::boolean) AS harnesses,
        (SELECT coalesce(array_agg(DISTINCT r.harness), '{}') FROM data.agent_registrations r WHERE r.owner_user_id=c.id) AS agents,
        (SELECT count(*)::int FROM data.messages m JOIN member s ON s.space_id=m.space_id AND s.user_id=c.id
          WHERE m.author_kind='user' AND m.author_id=c.id AND m.message_id NOT LIKE 'system:%'
            AND m.message_id NOT LIKE 'scheduled-message:%' AND m.message_kind='xmatrix.message.text') AS human_messages,
        (SELECT count(*)::int FROM data.agent_launches l JOIN member s ON s.space_id=l.space_id AND s.user_id=c.id) AS launches,
        (SELECT min(l.first_reply_at) FROM data.agent_launches l JOIN member s ON s.space_id=l.space_id AND s.user_id=c.id) AS first_reply_at,
        (SELECT coalesce(array_agg(coalesce(t.payload_json->'operationFailure'->>'code', t.payload_json->>'statusPhase')), '{}')
          FROM data.machine_run_terminal_reports t WHERE t.owner_user_id=c.id
            AND t.payload_json->>'statusPhase' IN ('wrapper_startup_failed','codex_app_starting','auth_resolving',
              'workspace_registering','relay_registering','daemon_auth_refresh_failed')) AS startup_failures,
        (SELECT coalesce(array_agg(m.preview_json->>'bodyPreview'), '{}') FROM data.messages m
          JOIN member s ON s.space_id=m.space_id AND s.user_id=c.id WHERE m.message_id LIKE 'turn-failure:%') AS turn_failures,
        (SELECT count(*)::int FROM data.pages p JOIN member s ON s.space_id=p.space_id AND s.user_id=c.id
          WHERE p.created_by_user_id=c.id) AS pages
      FROM cohort c`, [ids])).rows;
      for (const row of rows) {
        const fact = facts.get(row.id);
        fact.spaces += row.spaces;
        fact.machines += row.machines;
        fact.daemonOnline ||= row.daemon_online;
        for (const item of row.harnesses) fact.agentLogin[item.harness] ??= item.login ?? "unknown";
        fact.agents = [...new Set([...fact.agents, ...row.agents])];
        fact.humanMessages += row.human_messages;
        fact.launches += row.launches;
        if (row.first_reply_at && (!fact.firstReplyAt || row.first_reply_at < fact.firstReplyAt)) fact.firstReplyAt = row.first_reply_at;
        fact.startupFailures.push(...row.startup_failures);
        fact.turnFailures.push(...row.turn_failures.map(turnFailureClass));
        fact.pages += row.pages;
      }
    }
    const people = users.map((user) => {
      const fact = facts.get(user.id);
      const replyAfter = fact.firstReplyAt ? Math.round((Date.parse(fact.firstReplyAt) - Date.parse(user.created_at)) / 60000) : null;
      return {
        person: personKey(user.id),
        registeredAt: new Date(user.created_at).toISOString(),
        device: deviceOf(user.first_agent),
        platform: platformOf(user.first_agent),
        stage: stageOf(fact),
        machines: fact.machines,
        daemonOnline: fact.daemonOnline,
        agents: fact.agents.map(harness => ({ harness, login: fact.agentLogin[harness] ?? "unknown" })),
        humanMessages: fact.humanMessages,
        launches: fact.launches,
        minutesToFirstReply: replyAfter,
        startupFailures: fact.startupFailures,
        turnFailures: fact.turnFailures,
        pages: fact.pages,
      };
    });
    return { from, to, ...summarizeFunnel(people), peopleDetail: people };
  });
}

/** Who keeps using xMatrix, new or not: each person with a message of their
 * own in the 28 days before `to`, by the days they used it. Members of the
 * named team Spaces are marked, so they can be counted apart. */
export async function readActivePeople(to, shardUrlEnvs = [], internalSpaceIds = [], env = process.env) {
  const end = Date.parse(to);
  if (typeof to !== "string" || !/T.*(?:Z|\+00:00)$/u.test(to) || !Number.isFinite(end)) {
    throw new Error("Supply a UTC end time");
  }
  // Whole UTC days, `to`'s own day being the last: at most 7 and 28 of them.
  const lastDay = Math.floor((end - 1) / 86400000) * 86400000;
  const since28 = new Date(lastDay - 27 * 86400000).toISOString();
  const since7 = new Date(lastDay - 6 * 86400000).toISOString();
  return withReadOnlyShards(shardUrlEnvs, env, "20s", async (clients) => {
    const people = new Map();
    for (const client of clients) {
      const rows = (await client.query(`WITH own AS (
          SELECT m.author_id, m.space_id, m.channel_id, m.message_id, m.sent_at FROM data.messages m
          WHERE m.author_kind='user' AND m.message_kind='xmatrix.message.text'
            AND m.message_id NOT LIKE 'system:%' AND m.message_id NOT LIKE 'scheduled-message:%'
            AND m.deleted_at IS NULL AND m.sent_at >= $1 AND m.sent_at < $2
        )
        SELECT o.author_id AS id,
          count(DISTINCT date_trunc('day', o.sent_at)) FILTER (WHERE o.sent_at >= $3)::int AS days7,
          count(DISTINCT date_trunc('day', o.sent_at))::int AS days28,
          count(*) FILTER (WHERE o.sent_at >= $3)::int AS messages7,
          count(*)::int AS messages28,
          count(DISTINCT o.channel_id)::int AS conversations28,
          max(o.sent_at) AS last_at,
          (SELECT count(*)::int FROM data.agent_launches l JOIN own x ON x.space_id=l.space_id
             AND x.channel_id=l.channel_id AND x.message_id=l.trigger_id
           WHERE x.author_id=o.author_id AND l.first_reply_at IS NOT NULL) AS replied_tasks28,
          (SELECT coalesce(array_agg(DISTINCT e.agent_name), '{}') FROM data.agent_message_executions e
             JOIN own x ON x.space_id=e.space_id AND x.message_id=e.source_message_id
           WHERE x.author_id=o.author_id) AS agents28,
          EXISTS(SELECT 1 FROM data.space_members s WHERE s.user_id=o.author_id AND s.space_id=ANY($4::text[])) AS team
        FROM own o GROUP BY o.author_id`, [since28, to, since7, internalSpaceIds])).rows;
      for (const row of rows) {
        const person = people.get(row.id) ?? { days7: 0, days28: 0, messages7: 0, messages28: 0, conversations28: 0,
          repliedTasks28: 0, agents28: new Set(), lastAt: null, team: false };
        person.days7 = Math.max(person.days7, row.days7);
        person.days28 = Math.max(person.days28, row.days28);
        person.messages7 += row.messages7;
        person.messages28 += row.messages28;
        person.conversations28 += row.conversations28;
        person.repliedTasks28 += row.replied_tasks28;
        for (const agent of row.agents28) person.agents28.add(agent);
        if (!person.lastAt || row.last_at > person.lastAt) person.lastAt = row.last_at;
        person.team ||= row.team;
        people.set(row.id, person);
      }
    }
    const registered = new Map((await clients[0].query(`SELECT id, created_at FROM control.auth_users WHERE id=ANY($1)`,
      [[...people.keys()]])).rows.map(row => [row.id, row.created_at]));
    const list = [...people.entries()].map(([id, person]) => ({
      person: personKey(id),
      team: person.team,
      daysRegistered: registered.has(id) ? Math.floor((end - Date.parse(registered.get(id))) / 86400000) : null,
      activeDays7: person.days7,
      activeDays28: person.days28,
      messages7: person.messages7,
      messages28: person.messages28,
      conversations28: person.conversations28,
      repliedTasks28: person.repliedTasks28,
      agents28: [...person.agents28].sort(),
      lastActiveAt: new Date(person.lastAt).toISOString(),
    })).sort((a, b) => b.activeDays28 - a.activeDays28 || b.messages28 - a.messages28);
    const outside = list.filter(person => !person.team);
    return {
      asOf: to,
      active7: outside.filter(person => person.activeDays7 > 0).length,
      active28: outside.length,
      returning: outside.filter(person => person.activeDays28 >= 3).length,
      team: list.filter(person => person.team).length,
      people: list,
    };
  });
}

/** `<from> <to> [shard env…] [--active] [--internal-space <id>]…` */
export function parseArguments(args) {
  const shardUrlEnvs = [], internalSpaceIds = [];
  let active = false;
  const [from, to, ...rest] = args;
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === "--active") active = true;
    else if (rest[index] === "--internal-space" && rest[index + 1]) internalSpaceIds.push(rest[++index]);
    else if (/^[A-Z][A-Z0-9_]*$/u.test(rest[index])) shardUrlEnvs.push(rest[index]);
    else throw new Error(`Unknown argument ${rest[index]}`);
  }
  if (!from || !to) throw new Error("Usage: new-user-funnel.mjs <from UTC> <to UTC> [shard URL env…] [--active] [--internal-space <id>]…");
  return { from, to, shardUrlEnvs, internalSpaceIds, active };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { from, to, shardUrlEnvs, internalSpaceIds, active } = parseArguments(process.argv.slice(2));
    const funnel = await readNewUserFunnel(from, to, shardUrlEnvs);
    console.log(JSON.stringify(active
      ? { ...funnel, active: await readActivePeople(to, shardUrlEnvs, internalSpaceIds) } : funnel, null, 2));
  } catch {
    // Driver errors may contain credentials, SQL parameters or private IDs.
    console.error("New-user funnel failed; verify the UTC window, shard environments and database access.");
    process.exitCode = 1;
  }
}
