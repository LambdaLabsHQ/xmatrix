-- An account's diagnostics consent facts.
--
-- `diagnostics_regime`: the regime of the country the account signed up from,
-- 'consent-required' (EU/EEA/UK/Switzerland, or a country the edge could not
-- tell) or 'default-ok'. Only the regime is kept, never the country. Accounts
-- that predate the column get it the first time a beta client reads it, from
-- that request's Cloudflare country, and keep it from then on.
--
-- `diagnostics_choice`: the person's explicit choice, 'opted-in' or
-- 'opted-out', with the time it was made as evidence of consent. Only ticking
-- the opt-in box or turning the switch is a choice; a default and a dismissed
-- notice never write here.
--
-- Expand only, and nullable: a reader that finds no regime treats the account
-- as consent-required, and no choice as none. Erased with the account row.
ALTER TABLE control.auth_users ADD COLUMN diagnostics_regime TEXT
  CHECK (diagnostics_regime IS NULL OR diagnostics_regime IN ('consent-required', 'default-ok'));
ALTER TABLE control.auth_users ADD COLUMN diagnostics_choice TEXT
  CHECK (diagnostics_choice IS NULL OR diagnostics_choice IN ('opted-in', 'opted-out'));
ALTER TABLE control.auth_users ADD COLUMN diagnostics_choice_at TIMESTAMPTZ;
