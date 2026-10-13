-- What a Space says each harness is for: one free text per Space and harness,
-- written by people in whatever words they like. Automatic routing reads it,
-- and nothing else, when it judges how well a harness suits a piece of work.
-- revision counts the edits; a writer may name the one it read.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.space_harness_profiles (
  space_id TEXT NOT NULL CHECK (length(space_id) BETWEEN 1 AND 300),
  harness TEXT NOT NULL CHECK (harness ~ '^[a-z][a-z0-9-]{0,79}$' AND harness <> 'custom'),
  description TEXT NOT NULL CHECK (char_length(description) <= 1000),
  revision BIGINT NOT NULL CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, harness)
);

-- The description used to live on each registration. Carry what was written
-- there into the harness's profile, one line per distinct text; the
-- registration field is no longer read.
INSERT INTO data.space_harness_profiles (space_id, harness, description, revision, updated_at)
SELECT space_id, harness, left(string_agg(DISTINCT description, E'\n' ORDER BY description), 1000), 1, clock_timestamp()
FROM (SELECT space_id, harness, btrim(configuration_json->'routing'->>'description') AS description
      FROM data.space_agent_registrations) declared
WHERE description <> ''
GROUP BY space_id, harness;
