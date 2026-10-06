CREATE TABLE data.user_space_locale_preferences (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  display_locale TEXT,
  editing_locale TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, user_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (display_locale IS NULL OR length(display_locale) BETWEEN 1 AND 32),
  CHECK (editing_locale IS NULL OR length(editing_locale) BETWEEN 1 AND 32),
  CHECK (updated_at >= created_at)
);

CREATE INDEX user_space_locale_preferences_user_idx
  ON data.user_space_locale_preferences (user_id, space_id);

CREATE TABLE data.user_space_channel_view_preferences (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  child_views_json JSONB NOT NULL CHECK (jsonb_typeof(child_views_json) = 'object'),
  follow_up_review_schedule TEXT NOT NULL CHECK (
    follow_up_review_schedule IN ('off', 'daily', 'weekdays', 'weekly')
  ),
  pinned_channel_ids_json JSONB NOT NULL CHECK (jsonb_typeof(pinned_channel_ids_json) = 'array'),
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, user_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(child_views_json) <= 16384),
  CHECK (jsonb_array_length(pinned_channel_ids_json) <= 200),
  CHECK (updated_at >= created_at)
);

CREATE INDEX user_space_channel_view_preferences_user_idx
  ON data.user_space_channel_view_preferences (user_id, space_id);
