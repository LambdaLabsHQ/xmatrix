/**
 * Platform activity per UTC day, settled once and then read from a rollup.
 *
 * A day settles two days after it began, from the messages present then: a
 * message that reaches xMatrix more than a day after it was sent, or is
 * deleted after its day settled, does not change that day. The admin overview
 * reads settled days from `data.admin_activity_days` and only the days after
 * them from `data.messages`, so its cost follows the days and people it
 * reports rather than every message ever sent. Metadata only — kinds, ids,
 * and times, never what a message says.
 */

import type { AuthorityDatabase } from "@xmatrix/db";
import type { QueryResultRow } from "pg";

import { createPostgresAuthorityFleet, type PostgresAuthorityFleet } from "./postgres-authority-fleet";
import type { Env } from "./types";

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;

/** The minute of each hour when the scheduled tick settles admin activity. */
const ROLLUP_MINUTE = 41;

/**
 * One row per message, as the rollup keeps it. People count for themselves;
 * an Agent's message counts for its send-time owner (legacy messages without a
 * sender preview fall back to their persisted Run binding); apps and xMatrix
 * count for nobody. A message is the person's own when a Space member typed
 * the text, which leaves out imports, scheduled posts, and notices.
 */
const ADMIN_MESSAGE_ACTIVITY_FACTS = `SELECT message.space_id,
    (message.sent_at AT TIME ZONE 'UTC')::date AS day,
    message.author_kind,
    CASE WHEN message.author_kind = 'user' THEN message.author_id
      WHEN message.author_kind = 'agent' THEN COALESCE(CASE WHEN message.preview_json IS NULL
        THEN binding.owner_user_id ELSE NULLIF(message.preview_json#>>'{senderSnapshot,userId}', '') END, '')
      ELSE '' END AS user_id,
    (message.author_kind = 'user' AND message.message_kind = 'xmatrix.message.text'
      AND message.message_id NOT LIKE 'system:%' AND message.message_id NOT LIKE 'scheduled-message:%'
      AND EXISTS (SELECT 1 FROM data.space_members member
        WHERE member.space_id = message.space_id AND member.user_id = message.author_id)) AS own,
    message.sent_at
  FROM data.messages message
  LEFT JOIN data.instances instance ON message.author_kind = 'agent'
    AND message.preview_json IS NULL AND instance.instance_id = message.author_id
  LEFT JOIN data.run_agent_registrations binding ON binding.run_id = instance.run_id
    AND binding.space_id = message.space_id`;

/** Retained messages matching `sent`, grouped to the rollup's grain. */
export function adminActivityGroups(sent: string): string {
  return `SELECT space_id, day, author_kind, user_id, count(*)::int AS messages,
    (count(*) FILTER (WHERE own))::int AS own_messages, max(sent_at) AS last_sent_at
  FROM (${ADMIN_MESSAGE_ACTIVITY_FACTS} WHERE message.deleted_at IS NULL AND ${sent}) facts
  GROUP BY space_id, day, author_kind, user_id`;
}

/** UTC midnight starting the day after `$n`. */
const dayAfter = (parameter: string) => `(${parameter}::date + 1)::timestamp AT TIME ZONE 'UTC'`;

// Days are settled from scratch: rows a Space move brought for a day this
// shard has not settled are replaced by what its messages say.
const SETTLE_FIRST = [
  "DELETE FROM data.admin_activity_days WHERE day <= $1::date",
  `INSERT INTO data.admin_activity_days
    (space_id, day, author_kind, user_id, messages, own_messages, last_sent_at)
  ${adminActivityGroups(`message.sent_at < ${dayAfter("$1")}`)}`,
] as const;
const SETTLE_NEXT = [
  "DELETE FROM data.admin_activity_days WHERE day > $1::date AND day <= $2::date",
  `INSERT INTO data.admin_activity_days
    (space_id, day, author_kind, user_id, messages, own_messages, last_sent_at)
  ${adminActivityGroups(`message.sent_at >= ${dayAfter("$1")} AND message.sent_at < ${dayAfter("$2")}`)}`,
] as const;

/** The last UTC day that has settled at `now`: the day before yesterday. */
export function adminActivitySettledThrough(now: number): string {
  if (!Number.isFinite(now)) throw new Error("admin activity time is invalid");
  return new Date(Math.floor(now / UTC_DAY_MS) * UTC_DAY_MS - 2 * UTC_DAY_MS).toISOString().slice(0, 10);
}

interface RollupStateRow extends QueryResultRow {
  settled_through: Date | string | null;
}

/** A DATE column as `YYYY-MM-DD`, however the driver hands it over. */
export function adminDate(value: Date | string): string {
  if (value instanceof Date) {
    // node-postgres reads DATE as local midnight.
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString().slice(0, 10);
  }
  if (!/^\d{4}-\d{2}-\d{2}/u.test(value)) throw new Error("admin activity date is invalid");
  return value.slice(0, 10);
}

export type AdminActivityRollUp =
  | { status: "settled"; from: string | null; through: string }
  | { status: "current" }
  | { status: "busy" };

/**
 * Settles one shard's days up to the day before yesterday. The state row is
 * locked for the whole roll-up; a concurrent roll-up finds it locked and
 * leaves the work to the one already running.
 */
export async function rollUpAdminActivity(
  database: AuthorityDatabase,
  input: { requestId: string; now: number },
): Promise<AdminActivityRollUp> {
  const through = adminActivitySettledThrough(input.now);
  return database.transaction({ requestId: input.requestId, operation: "admin.activity.rollup" }, async (transaction) => {
    const state = (await transaction.query<RollupStateRow>({
      name: "admin_activity_rollup_state_lock_v1",
      text: `SELECT settled_through FROM data.admin_activity_rollup
        WHERE singleton FOR UPDATE SKIP LOCKED`,
      values: [],
      maxRows: 1,
    }))[0];
    if (!state) return { status: "busy" };
    const from = state.settled_through === null ? null : adminDate(state.settled_through);
    if (from !== null && from >= through) return { status: "current" };
    const [remove, insert] = from === null ? SETTLE_FIRST : SETTLE_NEXT;
    const values = from === null ? [through] : [from, through];
    await transaction.query({ name: `admin_activity_rollup_clear_${from === null ? "first" : "next"}_v1`,
      text: remove, values, maxRows: 0 });
    await transaction.query({ name: `admin_activity_rollup_settle_${from === null ? "first" : "next"}_v1`,
      text: insert, values, maxRows: 0 });
    await transaction.query({
      name: "admin_activity_rollup_advance_v1",
      text: `UPDATE data.admin_activity_rollup
        SET settled_through = $1::date, updated_at = clock_timestamp() WHERE singleton`,
      values: [through],
      maxRows: 0,
    });
    return { status: "settled", from, through };
  });
}

export async function rollUpAdminActivityFleet(
  fleet: Pick<PostgresAuthorityFleet, "physicalShards">,
  now: number,
): Promise<AdminActivityRollUp[]> {
  return Promise.all(fleet.physicalShards.map(({ shardId, database }) =>
    rollUpAdminActivity(database, { requestId: `admin-activity-rollup:${shardId}:${now}`, now })));
}

/** Called on every scheduled tick; looks once an hour, and settles a new day once a day. */
export async function rollUpAdminActivityOnSchedule(env: Env, scheduledTime: number): Promise<void> {
  if (new Date(scheduledTime).getUTCMinutes() !== ROLLUP_MINUTE) return;
  // A shard's first roll-up reads its whole message history once.
  await rollUpAdminActivityFleet(createPostgresAuthorityFleet(env, {
    applicationName: "xmatrix-hub-admin-activity-rollup",
    statementTimeoutMs: 60_000,
    transactionTimeoutMs: 120_000,
    lockTimeoutMs: 2_000,
  }), scheduledTime);
}
