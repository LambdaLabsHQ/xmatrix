SET LOCAL lock_timeout = '5s';
-- Primary App authority; only resource identifiers, states and delivery cursors.
-- A subscription's deletion removes its derived watcher, never provider data.
CREATE TABLE data.app_apple_commerce_watches (
  relation_id TEXT PRIMARY KEY REFERENCES data.app_source_relations(relation_id) ON DELETE CASCADE,
  watch_id UUID NOT NULL DEFAULT gen_random_uuid(),
  relation_version BIGINT NOT NULL,
  connection_generation TEXT NOT NULL,
  credential_version BIGINT NOT NULL,
  snapshot_json JSONB,
  pending_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  sequence BIGINT NOT NULL DEFAULT 0,
  observed_at TIMESTAMPTZ,
  retrying BOOLEAN NOT NULL DEFAULT false,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_id UUID,
  lease_until TIMESTAMPTZ,
  CHECK (snapshot_json IS NULL OR jsonb_typeof(snapshot_json)='array'),
  CHECK (jsonb_typeof(pending_json)='array')
);
CREATE INDEX app_apple_commerce_watches_due_idx ON data.app_apple_commerce_watches(available_at);
