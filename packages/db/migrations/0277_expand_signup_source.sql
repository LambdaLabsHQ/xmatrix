-- Where an account came from (packages/protocol/src/signup-source.ts).
--
-- `signup_source_host`: the domain of the site that sent the person to
-- xMatrix, without `www.`, or 'direct' when nothing did. Never a full URL.
-- `signup_source_ref`: the `?ref=` tag on the link they followed, or NULL.
--
-- Written once, by the new account's first page, and only while the account
-- is new and the host is still empty. Expand only, and nullable: accounts
-- from before this column, and sign-ins that carried no source (a native
-- app's), stay NULL, which reads as unknown. Erased with the account row.
ALTER TABLE control.auth_users ADD COLUMN signup_source_host TEXT
  CHECK (signup_source_host IS NULL OR signup_source_host ~ '^[a-z0-9.-]{1,64}$');
ALTER TABLE control.auth_users ADD COLUMN signup_source_ref TEXT
  CHECK (signup_source_ref IS NULL OR signup_source_ref ~ '^[a-z0-9_-]{1,32}$');
