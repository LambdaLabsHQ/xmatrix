/** One metadata-only scan and one SQL round trip per physical shard. */
export const POSTGRES_ADMIN_OVERVIEW_QUERY = `WITH admin_message_facts AS MATERIALIZED (
  SELECT space_id, author_id, author_kind, created_at
  FROM data.messages WHERE deleted_at IS NULL
),
totals AS (
WITH space_totals AS (
          SELECT COUNT(*) AS spaces FROM data.spaces
        ), channel_totals AS (
          SELECT COUNT(*) AS channels,
            COUNT(*) AS active_channels FROM data.channels
        ), message_totals AS (
          SELECT COUNT(*) AS messages,
            COUNT(*) FILTER (WHERE created_at >= $1) AS messages_last_24h,
            COUNT(*) FILTER (WHERE created_at >= $2) AS messages_last_7d,
            COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
            COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages
           FROM admin_message_facts
        ), run_totals AS (
          SELECT COUNT(*) AS runs,
            COUNT(*) FILTER (WHERE status IN ('starting', 'running')) AS active_runs FROM data.runs
        ), automation_totals AS (
          SELECT COUNT(*) AS automations,
            COUNT(*) FILTER (WHERE enabled) AS enabled_automations FROM data.automations
        )
        SELECT space_totals.*, channel_totals.*, message_totals.*,
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
          SELECT space_id, COUNT(*) AS messages,
            COUNT(*) FILTER (WHERE created_at >= $2) AS messages_last_7d,
            MAX(created_at) AS last_message_at
           FROM admin_message_facts GROUP BY space_id
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
          SELECT author_id AS user_id, COUNT(*) AS messages, MAX(created_at) AS last_message_at
           FROM admin_message_facts WHERE author_kind = 'user' GROUP BY author_id
        )
       SELECT membership_users.*, COALESCE(agent_counts.agent_registrations, 0) AS agent_registrations,
        COALESCE(message_counts.messages, 0) AS messages, message_counts.last_message_at,
        COUNT(*) OVER () AS total_count
       FROM membership_users LEFT JOIN agent_counts USING (user_id)
       LEFT JOIN message_counts USING (user_id)
       ORDER BY spaces DESC, first_seen_at, user_id
       LIMIT 10000
),
activity AS (
WITH daily_counts AS (
        SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
          COUNT(*) AS messages,
          COUNT(*) FILTER (WHERE author_kind = 'user') AS human_messages,
          COUNT(*) FILTER (WHERE author_kind = 'agent') AS agent_messages
         FROM admin_message_facts
         WHERE created_at >= $4 AND created_at < $5
         GROUP BY date_trunc('day', created_at AT TIME ZONE 'UTC')
       )
       SELECT to_char(days.day, 'YYYY-MM-DD') AS day,
         COALESCE(daily_counts.messages, 0) AS messages,
         COALESCE(daily_counts.human_messages, 0) AS human_messages,
         COALESCE(daily_counts.agent_messages, 0) AS agent_messages
        FROM generate_series($4::timestamptz AT TIME ZONE 'UTC',
          ($5::timestamptz AT TIME ZONE 'UTC') - interval '1 day',
          interval '1 day') AS days(day)
        LEFT JOIN daily_counts USING (day) ORDER BY days.day
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
  COALESCE((SELECT json_agg(totals) FROM totals), '[]'::json) AS totals,
  COALESCE((SELECT json_agg(spaces ORDER BY created_at DESC, id) FROM spaces), '[]'::json) AS spaces,
  COALESCE((SELECT json_agg(users ORDER BY spaces DESC, first_seen_at, user_id) FROM users), '[]'::json) AS users,
  COALESCE((SELECT json_agg(activity ORDER BY day) FROM activity), '[]'::json) AS activity,
  COALESCE((SELECT json_agg(storage ORDER BY logical_bytes DESC, category) FROM storage), '[]'::json) AS storage,
  COALESCE((SELECT json_agg(machine_row ORDER BY owner_user_id) FROM machines machine_row), '[]'::json) AS machines`;
