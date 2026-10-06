-- Claims (docs/strategy/go-to-market-2026-09.md §3.3): a claim is a lease on a
-- page block, "alice's claude:1 is on this", with an expiry. One active claim
-- per block, unless a maintainer opens the block for competition.
CREATE TABLE data.page_claims (
  space_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  -- The heading slug of the block; empty claims the whole page.
  block_id TEXT NOT NULL DEFAULT '',
  holder_kind TEXT NOT NULL CHECK (holder_kind IN ('user', 'agent')),
  holder_id TEXT NOT NULL,
  holder_label TEXT NOT NULL,
  -- The person the claim counts against: the human, or the Agent's owner.
  owner_user_id TEXT NOT NULL,
  conversation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'completed')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, claim_id),
  CHECK (length(block_id) <= 200),
  CHECK (char_length(holder_label) BETWEEN 1 AND 200)
);

CREATE INDEX page_claims_block_idx ON data.page_claims (space_id, page_id, block_id, state, expires_at);

-- Blocks a maintainer opened for competition: several claims may run at once.
CREATE TABLE data.page_block_competitions (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  block_id TEXT NOT NULL,
  opened_by_user_id TEXT NOT NULL,
  opened_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id, block_id)
);
