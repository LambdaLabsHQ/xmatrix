CREATE TABLE data.spaces (
  space_id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  search_rank_sequence TEXT NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(kind) BETWEEN 1 AND 80),
  CHECK (length(name) BETWEEN 1 AND 300),
  CHECK (length(search_rank_sequence) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at),
  UNIQUE (search_rank_sequence)
);

CREATE INDEX spaces_owner_idx ON data.spaces (owner_user_id, space_id);

CREATE TABLE data.space_management_configs (
  space_id TEXT PRIMARY KEY,
  config_json JSONB NOT NULL CHECK (jsonb_typeof(config_json) = 'object'),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_user_id TEXT NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(updated_by_user_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(config_json) <= 262144)
);

CREATE TABLE data.space_management_snapshots (
  space_id TEXT PRIMARY KEY,
  snapshot_json JSONB NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  version BIGINT NOT NULL CHECK (version >= 1),
  received_at TIMESTAMPTZ NOT NULL,
  imported_by_user_id TEXT NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(imported_by_user_id) BETWEEN 1 AND 300),
  CHECK (pg_column_size(snapshot_json) <= 1048576)
);

CREATE TABLE data.space_billing_subscriptions (
  space_id TEXT PRIMARY KEY,
  billing_owner_user_id TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL,
  provider_subscription_id TEXT NOT NULL UNIQUE,
  provider_price_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan = 'pro'),
  status TEXT NOT NULL CHECK (status IN (
    'trialing', 'active', 'past_due', 'incomplete', 'incomplete_expired',
    'unpaid', 'canceled', 'paused'
  )),
  seat_quantity INTEGER NOT NULL CHECK (seat_quantity BETWEEN 1 AND 99),
  current_period_end TIMESTAMPTZ,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  grace_until TIMESTAMPTZ,
  provider_event_created_at TIMESTAMPTZ NOT NULL,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(billing_owner_user_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX space_billing_subscriptions_customer_idx
  ON data.space_billing_subscriptions (provider_customer_id);

CREATE TABLE data.space_billing_usage (
  space_id TEXT PRIMARY KEY,
  free_message_count BIGINT NOT NULL DEFAULT 0 CHECK (free_message_count BETWEEN 0 AND 500),
  free_limit_notice_state TEXT NOT NULL DEFAULT 'none'
    CHECK (free_limit_notice_state IN ('none', 'pending', 'sent')),
  free_limit_notice_channel_id TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.space_billing_checkout_intents (
  checkout_intent_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  billing_owner_user_id TEXT NOT NULL,
  plan TEXT NOT NULL CHECK (plan = 'pro'),
  billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
  provider_price_id TEXT NOT NULL,
  seat_quantity INTEGER NOT NULL CHECK (seat_quantity BETWEEN 1 AND 99),
  status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'completed', 'expired')),
  provider_checkout_session_id TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(checkout_intent_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (expires_at > created_at),
  CHECK (updated_at >= created_at)
);

CREATE INDEX space_billing_checkout_intents_space_idx
  ON data.space_billing_checkout_intents (space_id, status, expires_at);

CREATE TABLE data.space_billing_webhook_events (
  space_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'ignored_stale')),
  expires_at TIMESTAMPTZ NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, provider_event_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(provider_event_id) BETWEEN 1 AND 300),
  CHECK (length(event_type) BETWEEN 1 AND 160)
);

CREATE INDEX space_billing_webhook_events_expiry_idx
  ON data.space_billing_webhook_events (expires_at, space_id, provider_event_id);

CREATE TABLE data.space_billing_notice_deliveries (
  space_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL CHECK (principal_kind IN ('user', 'agent')),
  principal_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 12),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  lease_until TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  last_error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(principal_id) BETWEEN 1 AND 300),
  CHECK (length(message_id) BETWEEN 1 AND 300),
  CHECK ((status = 'leased' AND lease_until IS NOT NULL) OR status <> 'leased'),
  CHECK (updated_at >= created_at)
);

CREATE INDEX space_billing_notice_deliveries_due_idx
  ON data.space_billing_notice_deliveries (status, next_attempt_at, space_id);

CREATE TABLE data.space_members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  version BIGINT NOT NULL CHECK (version >= 1),
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, user_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX space_members_one_owner_idx
  ON data.space_members (space_id) WHERE role = 'owner';

CREATE INDEX space_members_user_idx ON data.space_members (user_id, space_id);

CREATE TABLE data.space_invites (
  invite_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  created_by_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'accepted', 'expired')),
  accepted_by_user_id TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  requires_approval BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  CHECK (length(invite_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (use_count <= COALESCE(max_uses, use_count))
);

CREATE INDEX space_invites_space_status_idx
  ON data.space_invites (space_id, status, created_at, invite_id);

CREATE TABLE data.space_join_requests (
  join_request_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  invite_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied')),
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  decided_by_user_id TEXT,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  CHECK (length(join_request_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(invite_id) BETWEEN 1 AND 300),
  CHECK (length(user_id) BETWEEN 1 AND 300)
);

CREATE UNIQUE INDEX space_join_requests_pending_idx
  ON data.space_join_requests (space_id, user_id) WHERE status = 'pending';

CREATE INDEX space_join_requests_space_status_idx
  ON data.space_join_requests (space_id, status, created_at, join_request_id);

CREATE TABLE data.space_member_creation_policies (
  space_id TEXT PRIMARY KEY,
  agent_profile_creation_policy TEXT NOT NULL
    CHECK (agent_profile_creation_policy IN ('members', 'admins')),
  automation_creation_policy TEXT NOT NULL
    CHECK (automation_creation_policy IN ('members', 'admins')),
  version BIGINT NOT NULL CHECK (version >= 1),
  updated_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(updated_by_user_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE TABLE data.channels (
  channel_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  parent_channel_id TEXT,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  archived_at TIMESTAMPTZ,
  search_rank_sequence TEXT NOT NULL UNIQUE,
  version BIGINT NOT NULL CHECK (version >= 1),
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (parent_channel_id IS NULL OR length(parent_channel_id) BETWEEN 1 AND 300),
  CHECK (length(name) BETWEEN 1 AND 300),
  CHECK (length(name_key) BETWEEN 1 AND 300),
  CHECK (metadata_json IS NULL OR jsonb_typeof(metadata_json) = 'object'),
  CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX channels_active_sibling_name_idx
  ON data.channels (space_id, COALESCE(parent_channel_id, ''), name_key)
  WHERE archived_at IS NULL;

CREATE INDEX channels_space_parent_idx
  ON data.channels (space_id, parent_channel_id, archived_at, name_key, channel_id);

CREATE TABLE data.channel_access (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  grant_version BIGINT NOT NULL CHECK (grant_version >= 1),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, channel_id, subject_kind, subject_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (length(subject_kind) BETWEEN 1 AND 80),
  CHECK (length(subject_id) BETWEEN 1 AND 300),
  CHECK (updated_at >= created_at)
);

CREATE INDEX channel_access_subject_idx
  ON data.channel_access (space_id, subject_kind, subject_id, channel_id);
