-- Cursor's "Add a payment method to continue" refuses only its API pool's
-- models while Auto stays included, so since #1853 (2026-11-20) it holds only
-- that scope (`account_json.billingRefusalScopes.API`). A refusal recorded
-- before then was held as an account billing refusal (`source='daemon'`,
-- `billingRefusal`): it keeps the whole Cursor registration out of unnamed
-- @auto for 365 days and its Agents cell reads "Out of quota", while nothing
-- clears it, because only a reply clears a billing hold and @auto never sends
-- it work. Cursor gives no other billing refusal, so each such hold is
-- rewritten as the API-scope hold the current Hub records for the same
-- refusal, keeping when it was refused and until when it holds. The pool's
-- other readings stay. Old and new Hubs both read the scoped form, so this
-- contract needs no release before or after it.
--
-- Bounded and idempotent: a second run finds no Cursor account billing hold.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  pending BIGINT;
BEGIN
  SELECT count(*) INTO pending FROM control.registration_quota_observations o
  WHERE o.source = 'daemon' AND COALESCE((o.account_json ->> 'billingRefusal')::boolean, FALSE)
    AND EXISTS (SELECT 1 FROM control.agent_registration_environments e
      WHERE e.owner_user_id = o.owner_user_id AND e.harness = 'cursor'
        AND COALESCE(NULLIF(btrim(e.declaration_json ->> 'quotaPoolId'), ''),
          'registration:' || e.machine_id || ':' || e.harness) = o.quota_pool_id);
  IF pending > 1000 THEN
    RAISE EXCEPTION 'refusing to rewrite % Cursor billing holds; expected a handful', pending;
  END IF;
END $$;

UPDATE control.registration_quota_observations o
SET source = 'provider', remaining = 100,
  observed_at = now() - interval '1 millisecond', expires_at = now(),
  windows_json = NULL,
  account_json = (o.account_json - 'billingRefusal') || jsonb_build_object('billingRefusalScopes',
    jsonb_build_object('API', jsonb_build_object(
      'observedAt', to_json(o.observed_at) #>> '{}',
      'expiresAt', to_json(o.expires_at) #>> '{}')))
WHERE o.source = 'daemon' AND COALESCE((o.account_json ->> 'billingRefusal')::boolean, FALSE)
  AND EXISTS (SELECT 1 FROM control.agent_registration_environments e
    WHERE e.owner_user_id = o.owner_user_id AND e.harness = 'cursor'
      AND COALESCE(NULLIF(btrim(e.declaration_json ->> 'quotaPoolId'), ''),
        'registration:' || e.machine_id || ':' || e.harness) = o.quota_pool_id);
