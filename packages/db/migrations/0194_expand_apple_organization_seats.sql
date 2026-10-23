-- App Store seats an organization assigns to its people (Volume Purchasing).
-- Each assigned transaction belongs for good to the xMatrix user who first
-- restored it, and each Apple group to the one Space its people share, the
-- Space of whoever restored first. The Space's canonical billing row stays the
-- entitlement; its seat count is recomputed from its group's active seats.
CREATE TABLE control.apple_seat_groups (
  environment TEXT NOT NULL CHECK (environment IN ('Production','Sandbox')),
  group_key TEXT NOT NULL CHECK (length(group_key) BETWEEN 1 AND 200),
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment, group_key)
);
CREATE TABLE control.apple_assigned_seats (
  environment TEXT NOT NULL CHECK (environment IN ('Production','Sandbox')),
  original_transaction_id TEXT NOT NULL CHECK (length(original_transaction_id) BETWEEN 1 AND 100),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 300),
  group_key TEXT NOT NULL,
  product_id TEXT NOT NULL CHECK (length(product_id) BETWEEN 1 AND 200),
  expires_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (environment, original_transaction_id),
  FOREIGN KEY (environment, group_key) REFERENCES control.apple_seat_groups(environment, group_key)
);
CREATE INDEX apple_assigned_seats_group_idx ON control.apple_assigned_seats(environment, group_key);
