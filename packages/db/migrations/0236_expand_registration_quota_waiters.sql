-- A summon refused because its provider quota read as used up waits on that
-- pool here. The transaction that records a reading with headroom for the pool
-- (a daemon probe or an Instance's own report) marks the wait ready with a new
-- token, so the event cannot be lost; the Hub then makes the Channel's quota
-- retry due and deletes the row by that token. A wait still ready after its
-- delivery failed is delivered again until it is done or expires. Rows only
-- name what to wake: the Channel's quota retry decides and admits the launch.

-- Fail fast instead of queueing quota writes behind this transaction.
SET LOCAL lock_timeout = '5s';

CREATE TABLE control.registration_quota_waiters (
  owner_user_id TEXT NOT NULL,
  quota_pool_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  -- The reading that refused: only one observed after it can end the wait.
  refused_through TIMESTAMPTZ NOT NULL,
  -- Set, with a fresh token, by the reading that ends the wait.
  ready_at TIMESTAMPTZ,
  ready_token UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (owner_user_id, quota_pool_id, channel_id),
  CHECK (length(owner_user_id) BETWEEN 1 AND 300),
  CHECK (length(quota_pool_id) BETWEEN 1 AND 300),
  CHECK (length(channel_id) BETWEEN 1 AND 180),
  CHECK ((ready_at IS NULL) = (ready_token IS NULL))
);

-- Delivery after a reading reads one owner's ready waits; recovery reads the
-- oldest ready waits of any owner.
CREATE INDEX registration_quota_waiters_ready_idx
  ON control.registration_quota_waiters (ready_at) WHERE ready_at IS NOT NULL;
