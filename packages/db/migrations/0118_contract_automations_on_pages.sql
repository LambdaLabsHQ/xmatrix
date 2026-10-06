-- Every Automation but a Space's Focus review belongs to a page section
-- (docs/design/pages-live-document.md §6.4). Apply once every serving Hub
-- creates Automations only on pages (the release that shipped "Automations are
-- created only on a page section").
--
-- Each Automation that still belongs only to a conversation is anchored here,
-- in the same transaction as the constraint: its reference is appended to the
-- page its conversation was last linked to, or else to its Space's first root
-- page, as a new revision by xMatrix. It refuses to run while an Automation's
-- Space has no page at all.

SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE unanchored_automation ON COMMIT DROP AS
  SELECT a.automation_id, c.space_id, COALESCE(l.page_id, r.page_id) AS page_id,
    '[' || regexp_replace(regexp_replace(COALESCE(NULLIF(btrim(a.payload_json->>'name'), ''), 'Automation'),
      '\s+', ' ', 'g'), '([][\\])', '\\\1', 'g') || '](xmatrix:automation/' || a.automation_id || ')' AS reference
  FROM data.automations a
  JOIN data.channels c ON c.channel_id = a.channel_id
  LEFT JOIN LATERAL (SELECT pl.page_id FROM data.page_links pl
    JOIN data.pages lp ON lp.space_id = pl.space_id AND lp.page_id = pl.page_id
    WHERE pl.space_id = c.space_id AND pl.conversation_id = a.channel_id
    ORDER BY pl.last_seen_at DESC, pl.link_id LIMIT 1) l ON true
  LEFT JOIN LATERAL (SELECT p.page_id FROM data.pages p
    WHERE p.space_id = c.space_id AND p.parent_page_id IS NULL
    ORDER BY p.position, p.page_id LIMIT 1) r ON true
  WHERE a.page_id IS NULL AND a.payload_json->>'payloadVersion' IS DISTINCT FROM '4';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM unanchored_automation WHERE page_id IS NULL) THEN
    RAISE EXCEPTION 'An Automation''s Space has no page to anchor it to; create one, then apply';
  END IF;
END $$;

CREATE TEMP TABLE anchored_page ON COMMIT DROP AS
  SELECT u.space_id, u.page_id, p.head_revision,
    (SELECT max(revision) FROM data.page_revisions pr
      WHERE pr.space_id = u.space_id AND pr.page_id = u.page_id) + 1 AS revision,
    string_agg(u.reference, E'\n\n' ORDER BY u.automation_id) AS references_text
  FROM unanchored_automation u
  JOIN data.pages p ON p.space_id = u.space_id AND p.page_id = u.page_id
  GROUP BY u.space_id, u.page_id, p.head_revision;

INSERT INTO data.page_revisions (space_id, page_id, revision, body, authors_json, conversation_ids, kind,
  based_on_revision, created_at)
SELECT a.space_id, a.page_id, a.revision,
  CASE WHEN btrim(h.body) = '' THEN '' ELSE rtrim(h.body, E'\n') || E'\n\n' END || a.references_text || E'\n',
  '[{"kind":"agent","id":"xmatrix","label":"xMatrix"}]'::jsonb, '{}', 'edit', a.head_revision, now()
FROM anchored_page a
JOIN data.page_revisions h ON h.space_id = a.space_id AND h.page_id = a.page_id AND h.revision = a.head_revision;

UPDATE data.pages p SET head_revision = a.revision, version = p.version + 1, updated_at = now()
FROM anchored_page a WHERE p.space_id = a.space_id AND p.page_id = a.page_id;

UPDATE data.automations a SET page_id = u.page_id, version = a.version + 1, updated_at = now()
FROM unanchored_automation u WHERE a.automation_id = u.automation_id;

ALTER TABLE data.automations ADD CONSTRAINT automations_on_a_page_check
  CHECK (page_id IS NOT NULL OR payload_json->>'payloadVersion' = '4') NOT VALID;
ALTER TABLE data.automations VALIDATE CONSTRAINT automations_on_a_page_check;
