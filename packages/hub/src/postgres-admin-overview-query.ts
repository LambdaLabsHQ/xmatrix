import { adminActivityGroups } from "./postgres-admin-activity-rollup";

/**
 * Message activity: settled days from the rollup plus the retained messages
 * sent after them, or (until a shard's first roll-up) every retained message.
 * `$7` starts the first unsettled day as the caller read it; the statement's
 * own snapshot of the state wins when a roll-up committed in between, so no
 * day is counted twice.
 */
const ROLLED_FACTS = `rollup_state AS (
  SELECT settled_through FROM data.admin_activity_rollup WHERE singleton AND settled_through IS NOT NULL
),
facts AS MATERIALIZED (
  SELECT space_id, day, author_kind, user_id, messages, own_messages, last_sent_at
    FROM data.admin_activity_days WHERE day <= (SELECT settled_through FROM rollup_state)
  UNION ALL
  ${adminActivityGroups("message.sent_at >= $7 AND message.sent_at >= "
    + "((SELECT settled_through FROM rollup_state) + 1)::timestamp AT TIME ZONE 'UTC'")}
)`;

const UNROLLED_FACTS = `rollup_state AS (SELECT NULL::date AS settled_through),
facts AS MATERIALIZED (${adminActivityGroups("true")})`;

/**
 * Metadata-only aggregates for one shard. `$1` starts the rolling 24 hours,
 * `$2` is today's UTC date, `$3` the Space row bound, `$4`/`$5` the first and
 * last UTC day of the activity series, `$6` whether this shard reads Machines.
 */
function overviewQuery(facts: string): string {
  return `WITH ${facts},
totals AS (
WITH space_totals AS (
          SELECT COUNT(*) AS spaces FROM data.spaces
        ), channel_totals AS (
          SELECT COUNT(*) AS channels,
            COUNT(*) AS active_channels FROM data.channels
        ), message_totals AS (
          SELECT COALESCE(SUM(messages), 0) AS messages,
            COALESCE(SUM(messages) FILTER (WHERE day >= $2::date - 6), 0) AS messages_last_7d,
            COALESCE(SUM(messages) FILTER (WHERE author_kind = 'user'), 0) AS human_messages,
            COALESCE(SUM(messages) FILTER (WHERE author_kind = 'agent'), 0) AS agent_messages
           FROM facts
        ), run_totals AS (
          SELECT COUNT(*) AS runs,
            COUNT(*) FILTER (WHERE status IN ('starting', 'running')) AS active_runs FROM data.runs
        ), automation_totals AS (
          SELECT COUNT(*) AS automations,
            COUNT(*) FILTER (WHERE enabled) AS enabled_automations FROM data.automations
        )
        SELECT space_totals.*, channel_totals.*, message_totals.*,
          (SELECT COUNT(*) FROM data.messages WHERE deleted_at IS NULL AND sent_at >= $1) AS messages_last_24h,
          (SELECT COUNT(*) FROM data.space_agent_registrations) AS agent_registrations,
          run_totals.*, (SELECT COUNT(*) FROM data.instances) AS agent_instances,
          automation_totals.*,
          (SELECT COALESCE(SUM(logical_bytes), 0) FROM data.space_storage_usage) AS storage_logical_bytes
        FROM space_totals CROSS JOIN channel_totals CROSS JOIN message_totals
        CROSS JOIN run_totals CROSS JOIN automation_totals
),
spaces AS (
WITH member_counts AS (
          SELECT space_id, COUNT(*) AS members FROM data.space_members GROUP BY space_id
        ), channel_counts AS (
          SELECT space_id, COUNT(*) AS channels,
            COUNT(*) AS active_channels
           FROM data.channels GROUP BY space_id
        ), agent_counts AS (
          SELECT space_id, COUNT(*) AS agent_registrations FROM data.space_agent_registrations GROUP BY space_id
        ), message_counts AS (
          SELECT space_id, SUM(messages) AS messages,
            SUM(messages) FILTER (WHERE day >= $2::date - 6) AS messages_last_7d,
            MAX(last_sent_at) AS last_message_at
           FROM facts GROUP BY space_id
        )
       SELECT s.space_id AS id, s.name, s.owner_user_id,
        COALESCE(member_counts.members, 0) AS members,
        COALESCE(channel_counts.channels, 0) AS channels,
        COALESCE(channel_counts.active_channels, 0) AS active_channels,
        COALESCE(agent_counts.agent_registrations, 0) AS agent_registrations,
        COALESCE(message_counts.messages, 0) AS messages,
        COALESCE(message_counts.messages_last_7d, 0) AS messages_last_7d,
        s.created_at, message_counts.last_message_at
       FROM data.spaces s LEFT JOIN member_counts USING (space_id)
       LEFT JOIN channel_counts USING (space_id) LEFT JOIN agent_counts USING (space_id)
       LEFT JOIN message_counts USING (space_id)
       ORDER BY s.created_at DESC, s.space_id LIMIT $3
),
users AS (
WITH membership_users AS (
          SELECT user_id, MIN(email) AS email, COUNT(*) AS spaces,
            COUNT(*) FILTER (WHERE role = 'owner') AS owned_spaces,
            MIN(created_at) AS first_seen_at FROM data.space_members GROUP BY user_id
        ), agent_counts AS (
          SELECT owner_user_id AS user_id, COUNT(*) AS agent_registrations
           FROM data.space_agent_registrations GROUP BY owner_user_id
        ), message_counts AS (
          SELECT user_id, COALESCE(SUM(messages) FILTER (WHERE author_kind = 'user'), 0) AS messages,
            MAX(last_sent_at) AS last_message_at
           FROM facts WHERE author_kind IN ('user', 'agent') AND user_id <> '' GROUP BY user_id
        )
       SELECT membership_users.*, COALESCE(agent_counts.agent_registrations, 0) AS agent_registrations,
        COALESCE(message_counts.messages, 0) AS messages, message_counts.last_message_at,
        COUNT(*) OVER () AS total_count
       FROM membership_users LEFT JOIN agent_counts USING (user_id)
       LEFT JOIN message_counts USING (user_id)
       ORDER BY spaces DESC, first_seen_at, user_id
       LIMIT 10000
),
user_days AS (
SELECT user_id,
        array_agg(DISTINCT day - DATE '1970-01-01' ORDER BY day - DATE '1970-01-01') AS days,
        COUNT(*) OVER () AS total_count
       FROM facts WHERE own_messages > 0 AND day >= $4::date - 29 AND day <= $5::date
       GROUP BY user_id ORDER BY user_id
       LIMIT 10000
),
activity AS (
WITH daily_counts AS (
        SELECT day, SUM(messages) AS messages,
          SUM(messages) FILTER (WHERE author_kind = 'user') AS human_messages,
          SUM(messages) FILTER (WHERE author_kind = 'agent') AS agent_messages,
          SUM(own_messages) AS own_messages,
          COUNT(DISTINCT space_id) FILTER (WHERE own_messages > 0) AS active_spaces
         FROM facts WHERE day >= $4::date AND day <= $5::date
         GROUP BY day
       ), daily_runs AS (
        SELECT (created_at AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS runs_started
         FROM data.runs
         WHERE created_at >= $4::date::timestamp AT TIME ZONE 'UTC'
           AND created_at < ($5::date + 1)::timestamp AT TIME ZONE 'UTC'
         GROUP BY 1
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         COALESCE(daily_counts.messages, 0) AS messages,
         COALESCE(daily_counts.human_messages, 0) AS human_messages,
         COALESCE(daily_counts.agent_messages, 0) AS agent_messages,
         COALESCE(daily_counts.own_messages, 0) AS own_messages,
         COALESCE(daily_counts.active_spaces, 0) AS active_spaces,
         COALESCE(daily_runs.runs_started, 0) AS runs_started
        FROM (SELECT series::date AS day
          FROM generate_series($4::date::timestamp, $5::date::timestamp, interval '1 day') AS series) AS days
        LEFT JOIN daily_counts USING (day) LEFT JOIN daily_runs USING (day) ORDER BY days.day
),
storage AS (
SELECT category, SUM(logical_rows) AS rows, SUM(logical_bytes) AS logical_bytes,
        MAX(updated_at) AS updated_at FROM data.space_storage_usage
       GROUP BY category ORDER BY logical_bytes DESC, category
       LIMIT 1001
),
machines AS (
SELECT owner_user_id, MIN(owner_email) AS email, COUNT(*) AS machines,
        COUNT(*) FILTER (WHERE status = 'online') AS online_machines,
        COUNT(*) OVER () AS total_count
       FROM data.machine_daemons WHERE $6::boolean GROUP BY owner_user_id ORDER BY owner_user_id
       LIMIT 10000
)
SELECT
  (SELECT settled_through FROM rollup_state) AS settled_through,
  COALESCE((SELECT json_agg(totals) FROM totals), '[]'::json) AS totals,
  COALESCE((SELECT json_agg(spaces ORDER BY created_at DESC, id) FROM spaces), '[]'::json) AS spaces,
  COALESCE((SELECT json_agg(users ORDER BY spaces DESC, first_seen_at, user_id) FROM users), '[]'::json) AS users,
  COALESCE((SELECT json_agg(user_days ORDER BY user_id) FROM user_days), '[]'::json) AS user_days,
  COALESCE((SELECT json_agg(activity ORDER BY day) FROM activity), '[]'::json) AS activity,
  COALESCE((SELECT json_agg(storage ORDER BY logical_bytes DESC, category) FROM storage), '[]'::json) AS storage,
  COALESCE((SELECT json_agg(machine_row ORDER BY owner_user_id) FROM machines machine_row), '[]'::json) AS machines`;
}

/** Settled days plus the messages sent from `$7` on. */
export const POSTGRES_ADMIN_OVERVIEW_QUERY = overviewQuery(ROLLED_FACTS);

/** Every message; read only until the shard's first roll-up. */
export const POSTGRES_ADMIN_OVERVIEW_UNROLLED_QUERY = overviewQuery(UNROLLED_FACTS);

export const POSTGRES_ADMIN_OVERVIEW_STATE_QUERY = `SELECT settled_through
  FROM data.admin_activity_rollup WHERE singleton`;
