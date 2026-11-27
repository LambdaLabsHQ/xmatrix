-- The admission policy a Space adopted (docs/design/admission-policy.md): the
-- text of one Space library, as a Space admin read and adopted it in person,
-- with the Page it was written on. The Hub evaluates this text, never the
-- Page's, when a Run asks to use a secret that asks first. No row is no
-- policy: every such request goes to its card.
--
-- Old Hubs never read this table, so until they drain a request they handle
-- gets its card as before.
SET LOCAL lock_timeout = '5s';
CREATE TABLE data.space_admission_policies (
  space_id TEXT PRIMARY KEY CHECK (length(space_id) BETWEEN 1 AND 300),
  page_id TEXT NOT NULL CHECK (length(page_id) BETWEEN 1 AND 300),
  library_name TEXT NOT NULL CHECK (library_name ~ '^[A-Z][A-Za-z0-9_]{0,39}$'),
  source_text TEXT NOT NULL CHECK (length(source_text) BETWEEN 1 AND 20000),
  source_sha256 TEXT NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  adopted_by_user_id TEXT NOT NULL CHECK (length(adopted_by_user_id) BETWEEN 1 AND 300),
  adopted_at TIMESTAMPTZ NOT NULL
);
