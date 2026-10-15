-- A page's name is the top-level heading its document opens with (0192,
-- docs/design/pages-live-document.md §4.1). A page whose document opens with no
-- such heading would lose the name it has, so its title is written above its
-- text, as a new revision by xMatrix. A document whose heading sits under a stray
-- leading rule (`page read` frontmatter pasted into the text) loses the rule instead. Apply before the release that reads names
-- from documents ships; a Hub that still serves the title only sees each such
-- document gain its first line. Bounded and idempotent: a second run finds no
-- page to name.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TEMP TABLE unnamed_page ON COMMIT DROP AS
  SELECT p.space_id, p.page_id, p.head_revision, p.title, h.body,
    (SELECT max(revision) FROM data.page_revisions pr
      WHERE pr.space_id = p.space_id AND pr.page_id = p.page_id) + 1 AS revision
  FROM data.pages p
  JOIN data.page_revisions h ON h.space_id = p.space_id AND h.page_id = p.page_id AND h.revision = p.head_revision
  WHERE data.page_name(h.body) IS NULL AND btrim(COALESCE(p.title, '')) <> '';

DO $$
DECLARE
  pending BIGINT;
BEGIN
  -- Refuse an unexpectedly large operation before any page is rewritten.
  SELECT count(*) INTO pending FROM unnamed_page;
  IF pending > 10000 THEN RAISE EXCEPTION 'Page name backfill exceeds 10000 pages'; END IF;
END $$;

INSERT INTO data.page_revisions (space_id, page_id, revision, body, authors_json, conversation_ids, kind,
  based_on_revision, created_at)
SELECT u.space_id, u.page_id, u.revision,
  CASE WHEN data.page_name(regexp_replace(u.body, '^[[:space:]]*-{3,}[[:blank:]]*\n[[:space:]]*', '')) IS NOT NULL
    THEN regexp_replace(u.body, '^[[:space:]]*-{3,}[[:blank:]]*\n[[:space:]]*', '')
    ELSE '# ' || btrim(regexp_replace(u.title, '\s+', ' ', 'g')) || E'\n'
      || CASE WHEN btrim(u.body, E' \t\r\n') = '' THEN '' ELSE E'\n' || ltrim(u.body, E'\r\n') END
  END,
  '[{"kind":"agent","id":"xmatrix","label":"xMatrix"}]'::jsonb, '{}', 'edit', u.head_revision, now()
FROM unnamed_page u;

UPDATE data.pages p SET head_revision = u.revision, version = p.version + 1
FROM unnamed_page u WHERE p.space_id = u.space_id AND p.page_id = u.page_id;
