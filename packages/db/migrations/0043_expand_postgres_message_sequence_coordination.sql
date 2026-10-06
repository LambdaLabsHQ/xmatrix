CREATE TABLE data.channel_message_sequences (
  space_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  allocated_sequence BIGINT NOT NULL CHECK (allocated_sequence >= 0),
  confirmed_sequence BIGINT NOT NULL CHECK (confirmed_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, channel_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (confirmed_sequence <= allocated_sequence)
);

INSERT INTO data.channel_message_sequences
  (space_id, channel_id, allocated_sequence, confirmed_sequence, updated_at)
SELECT space_id, channel_id, MAX(timeline_sequence), MAX(timeline_sequence), now()
FROM data.messages
GROUP BY space_id, channel_id
ON CONFLICT (space_id, channel_id) DO NOTHING;

CREATE TABLE data.message_sequence_reservations (
  space_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence >= 1),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed')),
  fact_digest TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, command_id),
  UNIQUE (space_id, channel_id, sequence),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(command_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 300),
  CHECK (fact_digest IS NULL OR length(fact_digest) = 64),
  CHECK (updated_at >= created_at),
  CHECK (expires_at >= created_at)
);

CREATE INDEX message_sequence_reservations_expiry_idx
  ON data.message_sequence_reservations (expires_at, space_id, command_id);
