-- A Space's move from the Channel tree to pages
-- (docs/design/pages-and-conversations-migration.md §3). The plan says which
-- Channels become pages; a Space owner or admin confirms it; applying it is
-- idempotent and resumable, and the report records what it did.
CREATE TABLE data.page_migrations (
  space_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('proposed', 'confirmed', 'applied')),
  -- {"pages": [channelId, ...]}: the Channels that become pages; every other
  -- Channel becomes a conversation.
  plan_json JSONB NOT NULL,
  proposed_at TIMESTAMPTZ NOT NULL,
  confirmed_by_user_id TEXT,
  confirmed_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  report_json JSONB,
  version BIGINT NOT NULL CHECK (version >= 1),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (jsonb_typeof(plan_json) = 'object'),
  CHECK ((state = 'proposed') = (confirmed_at IS NULL)),
  CHECK ((state = 'applied') = (applied_at IS NOT NULL))
);
