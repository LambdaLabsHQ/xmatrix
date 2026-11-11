-- A Norn program started from a Channel message. Its request ledger is the
-- only authority for what it asked and what was answered; norn_requests only
-- finds a request by the reference its holder answers with and by the message
-- that delivered it, and is written in the transaction that writes the ledger.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.norn_programs (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- The message that carries the program.
  program_id TEXT NOT NULL,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent')),
  -- A user id, or the Instance that sent the message.
  author_id TEXT NOT NULL,
  -- Whose current authority every delivery is checked against.
  authority_user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  ledger_json JSONB NOT NULL CHECK (jsonb_typeof(ledger_json)='object'),
  state TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
  -- A stop in the Channel, not yet read by a pass.
  stop_reason TEXT,
  next_due_at TIMESTAMPTZ,
  -- When the program's end was told to the Channel.
  reported_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,program_id)
);
CREATE INDEX norn_programs_channel_idx ON data.norn_programs(channel_id,state);
CREATE TABLE data.norn_requests (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  -- The request's identity in the ledger.
  request_id TEXT NOT NULL,
  -- What its holder answers with.
  request_ref TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch >= 0),
  holder TEXT NOT NULL,
  -- One message per holding: a handover delivers the request again.
  delivery_message_id TEXT NOT NULL,
  delivered_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(space_id,program_id,request_id),
  UNIQUE(space_id,request_ref),
  -- Deferred: a Channel that moves to another Space takes both tables with it in one transaction.
  FOREIGN KEY(space_id,program_id) REFERENCES data.norn_programs(space_id,program_id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX norn_requests_open_idx ON data.norn_requests(channel_id,delivery_message_id) WHERE settled_at IS NULL;
