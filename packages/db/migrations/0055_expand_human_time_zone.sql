-- The zone a person reads time in, on both sides of the Human Profile sync.
--
-- Expand only. Nullable everywhere: accounts that predate the column have no
-- zone, and a reader that finds none renders in its own and says so, which is
-- the behaviour that already exists. No backfill gates this migration.
--
-- An IANA name, never a fixed offset — an offset describes one instant, so a
-- stored one is wrong for half the year on either side of a daylight-saving
-- boundary.
ALTER TABLE control.auth_users ADD COLUMN time_zone TEXT;
ALTER TABLE data.human_profiles ADD COLUMN time_zone TEXT;
