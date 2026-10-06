-- Model names and harness names are unrelated values. Removed discovery and
-- Profile cutover code wrote the harness name (for example "claude") into
-- `models` lists as a placeholder for "any model"; readers then special-cased
-- it. Those readers now compare models literally, and an empty list means "no
-- model override: runtime default only". This rewrites every persisted model
-- list that still carries its own row's harness name.
--
-- Revisions and versions:
-- * Owner grant / Space policy limits keep grant_revision,
--   grant_execution_revision, policy_revision and policy_execution_revision.
--   Advancing any of them fences starting Runs, staged launches and
--   continuation (registration revocation). A live Run does not block this
--   migration. The harness name is not a model, so it is removed from the
--   grant and from the admission snapshot that Run already holds. Continuation
--   compares that snapshot with the current limits; both lose the same
--   placeholder, and no fence moves.
-- * Environment declarations keep `version`: a reserved allocation fences on
--   it, and the removed entry was never a model any allocation requested.
-- * Space configuration `version` is only the edit form's compare-and-swap
--   token, so it advances like any configuration write.
-- * Legacy Profile `version` feeds the Profile quota-pool identity, so it is
--   kept; only `updated_at` advances.
--
-- Idempotent: a second run matches no rows.

CREATE FUNCTION pg_temp.models_without(models JSONB, name TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $models$
  SELECT COALESCE(jsonb_agg(entry.item ORDER BY entry.position), '[]'::jsonb)
  FROM jsonb_array_elements(models) WITH ORDINALITY AS entry(item, position)
  WHERE entry.item <> to_jsonb(name)
$models$;

-- An alias maps a declared model to the runtime's model id. A harness-named
-- key is no longer a declared model; a harness-named value is not a model id.
CREATE FUNCTION pg_temp.aliases_without(aliases JSONB, name TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $aliases$
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
  FROM jsonb_each(aliases) AS entry(key, value)
  WHERE entry.key <> name AND entry.value <> to_jsonb(name)
$aliases$;

CREATE FUNCTION pg_temp.declaration_names(declaration JSONB, name TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE AS $names$
  SELECT (jsonb_typeof(declaration->'models')='array' AND declaration->'models' @> to_jsonb(ARRAY[name]))
    OR (jsonb_typeof(declaration->'modelAliases')='object' AND (declaration->'modelAliases' ? name
      OR EXISTS (SELECT 1 FROM jsonb_each(declaration->'modelAliases') AS entry(key, value)
        WHERE entry.value = to_jsonb(name))))
$names$;

CREATE FUNCTION pg_temp.declaration_without(declaration JSONB, name TEXT) RETURNS JSONB
LANGUAGE sql IMMUTABLE AS $declaration$
  SELECT CASE WHEN jsonb_typeof(declaration->'modelAliases')='object'
      THEN jsonb_set(stripped, '{modelAliases}', pg_temp.aliases_without(declaration->'modelAliases', name))
      ELSE stripped END
  FROM (SELECT CASE WHEN jsonb_typeof(declaration->'models')='array'
      THEN jsonb_set(declaration, '{models}', pg_temp.models_without(declaration->'models', name))
      ELSE declaration END AS stripped) AS step
$declaration$;

-- Owner-maintained physical environment (directory control facts).
UPDATE control.agent_registration_environments environment
SET declaration_json=pg_temp.declaration_without(environment.declaration_json, environment.harness),
  updated_at=clock_timestamp()
WHERE pg_temp.declaration_names(environment.declaration_json, environment.harness);

-- Owner grants and Space policies (resource limits).
UPDATE data.space_agent_registration_access access
SET grant_limits=CASE WHEN jsonb_typeof(access.grant_limits->'models')='array'
    THEN jsonb_set(access.grant_limits, '{models}', pg_temp.models_without(access.grant_limits->'models', access.harness))
    ELSE access.grant_limits END,
  policy_limits=CASE WHEN jsonb_typeof(access.policy_limits->'models')='array'
    THEN jsonb_set(access.policy_limits, '{models}', pg_temp.models_without(access.policy_limits->'models', access.harness))
    ELSE access.policy_limits END,
  updated_at=clock_timestamp()
WHERE (jsonb_typeof(access.grant_limits->'models')='array' AND access.grant_limits->'models' @> to_jsonb(ARRAY[access.harness]))
  OR (jsonb_typeof(access.policy_limits->'models')='array' AND access.policy_limits->'models' @> to_jsonb(ARRAY[access.harness]));

-- Continuation compares a Run's requested models with the rewritten limits.
-- Drop the same placeholder from admission snapshots so a live Run or a
-- preparing launch stays inside those limits. Run status is left alone.
UPDATE data.run_agent_registrations binding
SET requested_json=jsonb_set(binding.requested_json, '{models}',
  pg_temp.models_without(binding.requested_json->'models', binding.harness))
WHERE jsonb_typeof(binding.requested_json->'models')='array'
  AND binding.requested_json->'models' @> to_jsonb(ARRAY[binding.harness]);

UPDATE data.registration_launch_intents intent
SET resources_json=jsonb_set(intent.resources_json, '{models}',
    pg_temp.models_without(intent.resources_json->'models', intent.harness)),
  updated_at=clock_timestamp()
WHERE jsonb_typeof(intent.resources_json->'models')='array'
  AND intent.resources_json->'models' @> to_jsonb(ARRAY[intent.harness]);

-- Space registration configuration: routing models and the default model.
UPDATE data.space_agent_registrations registration
SET configuration_json=(CASE WHEN jsonb_typeof(registration.configuration_json->'routing')='object'
      THEN jsonb_set(registration.configuration_json, '{routing}',
        pg_temp.declaration_without(registration.configuration_json->'routing', registration.harness))
      ELSE registration.configuration_json END)
    - (CASE WHEN registration.configuration_json->'model' = to_jsonb(registration.harness) THEN 'model' ELSE '' END),
  version=registration.version+1,
  updated_at=clock_timestamp()
WHERE registration.configuration_json->'model' = to_jsonb(registration.harness)
  OR (jsonb_typeof(registration.configuration_json->'routing')='object'
    AND pg_temp.declaration_names(registration.configuration_json->'routing', registration.harness));

-- Legacy Profile routing declarations are still read by legacy routing and
-- copied into registrations by a Profile cutover. A Profile's harness is its
-- runtime, or the registration harness it was cut over to.
UPDATE data.agent_profiles profile
SET metadata_json=jsonb_set(profile.metadata_json, '{routing}',
    pg_temp.declaration_without(pg_temp.declaration_without(profile.metadata_json->'routing', profile.runtime),
      COALESCE(reference.harness, profile.runtime))),
  updated_at=clock_timestamp()
FROM (SELECT candidate.agent_profile_id, legacy.harness
  FROM data.agent_profiles candidate
  LEFT JOIN control.legacy_agent_registration_references legacy ON legacy.legacy_profile_id=candidate.agent_profile_id) AS reference
WHERE reference.agent_profile_id=profile.agent_profile_id
  AND jsonb_typeof(profile.metadata_json->'routing')='object'
  AND (pg_temp.declaration_names(profile.metadata_json->'routing', profile.runtime)
    OR (reference.harness IS NOT NULL AND pg_temp.declaration_names(profile.metadata_json->'routing', reference.harness)));

DROP FUNCTION pg_temp.declaration_without(JSONB, TEXT);
DROP FUNCTION pg_temp.declaration_names(JSONB, TEXT);
DROP FUNCTION pg_temp.aliases_without(JSONB, TEXT);
DROP FUNCTION pg_temp.models_without(JSONB, TEXT);
