-- Durable per-program outside-event delivery obligations, retried through each
-- Channel's launch coordinator so one blocked program never starves later
-- programs or suppresses other webhook effects (#1642).
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.norn_event_deliveries (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  -- SHA-256 hex of the provider's event identity (the same id recorded in ledger.seen).
  event_id TEXT NOT NULL,
  -- Event occurrence payload ({ what, streams, cloudEvent?, grant? }) for coordinator replay.
  payload_json JSONB NOT NULL CHECK (jsonb_typeof(payload_json)='object'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,program_id,event_id),
  -- Deferred: a Channel that moves to another Space takes its programs and deliveries in one transaction.
  FOREIGN KEY(space_id,program_id) REFERENCES data.norn_programs(space_id,program_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX norn_event_deliveries_due_idx
  ON data.norn_event_deliveries(channel_id,next_attempt_at) WHERE delivered_at IS NULL;
