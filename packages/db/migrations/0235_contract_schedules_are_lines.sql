-- A page's schedule is a line of its text, written as Obsidian Tasks writes a
-- recurring or scheduled task (docs/design/pages-live-document.md §6.1):
--   - [ ] <instruction> 🔁 every 12 hours, on merged:owner/repo@main
--   - [ ] <instruction> ⏳ 2026-11-03 01:00 Z
-- Each page Automation's `[name](xmatrix:automation/<id>)` reference becomes
-- its line, after the line that held the reference, whose link is left as its
-- name; a line that held only the reference is replaced by the schedule's
-- line. An Automation with no reference (detached) is written paused at the
-- end of its page. Each Automation keeps the line as `payload_json.source`,
-- which is how the Hub knows it, its instruction as one line, and a
-- reminder's time to the minute, so its first sync changes nothing.
--
-- Apply before the release that syncs schedules from lines ships: that Hub
-- leaves an Automation without a line alone, and does not run it. A Hub still
-- reading references meanwhile pauses the Automations of a page someone edits;
-- the new Hub resumes them from their `[ ]` lines. Bounded and idempotent: a
-- second run finds no Automation without its line.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TEMP TABLE schedule_line ON COMMIT DROP AS
  SELECT a.automation_id, a.page_id, c.space_id,
    regexp_replace(btrim(regexp_replace(COALESCE(a.payload_json #>> '{input,datum,text}',
      a.payload_json #>> '{message,body}', ''), '[🔁⏳✅️]', '', 'g')), '\s+', ' ', 'g') AS instruction,
    a.payload_json ->> 'once' = 'true' AS once,
    (a.payload_json ->> 'intervalMinutes')::int AS minutes,
    a.enabled AND a.detached_at IS NULL AS running,
    a.last_run_at, date_trunc('minute', a.next_run_at AT TIME ZONE 'UTC') AS at_utc,
    COALESCE(a.payload_json -> 'triggers', '[]'::jsonb) AS triggers,
    NULL::text AS line
  FROM data.automations a JOIN data.channels c ON c.channel_id = a.channel_id
  WHERE a.page_id IS NOT NULL AND NOT (a.payload_json ? 'source');

DO $$
DECLARE
  pending BIGINT;
BEGIN
  -- Refuse an unexpectedly large operation before any page is rewritten.
  SELECT count(*) INTO pending FROM schedule_line;
  IF pending > 10000 THEN RAISE EXCEPTION 'Schedule line backfill exceeds 10000 Automations'; END IF;
  IF EXISTS (SELECT 1 FROM schedule_line WHERE instruction = '') THEN
    RAISE EXCEPTION 'A page Automation has no instruction to write as its line';
  END IF;
END $$;

-- The line, exactly as the protocol's scheduleLine writes it.
UPDATE schedule_line s SET line = '- [' ||
  CASE WHEN s.running THEN ' ' WHEN s.once AND s.last_run_at IS NOT NULL THEN 'x' ELSE '-' END || '] ' ||
  s.instruction || ' ' ||
  CASE WHEN s.once THEN '⏳ ' || to_char(s.at_utc, 'YYYY-MM-DD HH24:MI') || ' Z' ||
      CASE WHEN NOT s.running AND s.last_run_at IS NOT NULL
        THEN ' ✅ ' || to_char(s.last_run_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') ELSE '' END
    ELSE '🔁 ' || array_to_string(ARRAY[
      CASE
        WHEN s.minutes % 10080 = 0 THEN CASE WHEN s.minutes = 10080 THEN 'every week' ELSE 'every ' || s.minutes / 10080 || ' weeks' END
        WHEN s.minutes % 1440 = 0 THEN CASE WHEN s.minutes = 1440 THEN 'every day' ELSE 'every ' || s.minutes / 1440 || ' days' END
        WHEN s.minutes % 60 = 0 THEN CASE WHEN s.minutes = 60 THEN 'every hour' ELSE 'every ' || s.minutes / 60 || ' hours' END
        ELSE 'every ' || s.minutes || ' minutes'
      END] || ARRAY(
      SELECT 'on ' || CASE t ->> 'kind'
        WHEN 'event' THEN (t ->> 'provider') || ':' || COALESCE(t ->> 'feature', '*') ||
          CASE WHEN t ->> 'source' = '*' THEN '' ELSE ':' || (t ->> 'source') END
        WHEN 'merged' THEN 'merged:' || (t ->> 'repository') || COALESCE('@' || (t ->> 'branch'), '') ||
          CASE WHEN jsonb_array_length(COALESCE(t -> 'paths', '[]'::jsonb)) > 0
            THEN ':' || (SELECT string_agg(p, ',' ORDER BY n) FROM jsonb_array_elements_text(t -> 'paths')
              WITH ORDINALITY AS e(p, n)) ELSE '' END
        ELSE 'ci-failed:' || (t ->> 'repository') || COALESCE('@' || (t ->> 'branch'), '') ||
          COALESCE(':' || (t ->> 'workflow'), '')
      END
      FROM jsonb_array_elements(s.triggers) WITH ORDINALITY AS e(t, n) ORDER BY n), ', ')
  END;

CREATE TEMP TABLE schedule_page ON COMMIT DROP AS
  SELECT p.space_id, p.page_id, p.head_revision, h.body,
    (SELECT max(revision) FROM data.page_revisions pr
      WHERE pr.space_id = p.space_id AND pr.page_id = p.page_id) + 1 AS revision
  FROM data.pages p
  JOIN data.page_revisions h ON h.space_id = p.space_id AND h.page_id = p.page_id AND h.revision = p.head_revision
  WHERE EXISTS (SELECT 1 FROM schedule_line s WHERE s.space_id = p.space_id AND s.page_id = p.page_id);

DO $$
DECLARE
  s RECORD;
  doc TEXT;
  reference TEXT;
  label TEXT;
  at INT;
  line_start INT;
  line_end INT;
  rest TEXT;
BEGIN
  FOR s IN SELECT * FROM schedule_line ORDER BY page_id, automation_id LOOP
    SELECT p.body INTO doc FROM schedule_page p WHERE p.space_id = s.space_id AND p.page_id = s.page_id;
    reference := (regexp_match(doc, '(\[(?:[^]\\]|\\.)*\]\(xmatrix:automation/' ||
      regexp_replace(s.automation_id, '([.])', '\\\1', 'g') || '\))'))[1];
    IF reference IS NULL THEN
      doc := rtrim(doc, E' \t\r\n') || E'\n\n' || s.line || E'\n';
    ELSE
      label := regexp_replace(substr(reference, 2, strpos(reference, '](xmatrix:automation/') - 2), '\\(.)', '\1', 'g');
      at := strpos(doc, reference);
      line_start := strpos(reverse(substr(doc, 1, at - 1)), E'\n');
      line_start := CASE WHEN line_start = 0 THEN 1 ELSE at - line_start + 1 END;
      line_end := strpos(substr(doc, at), E'\n');
      line_end := CASE WHEN line_end = 0 THEN length(doc) + 1 ELSE at + line_end - 1 END;
      rest := substr(doc, line_start, at - line_start) || label || substr(doc, at + length(reference), line_end - at - length(reference));
      IF btrim(regexp_replace(rest, '^\s*([-*+]|\d+[.)])\s+', '')) IN ('', label) THEN
        doc := substr(doc, 1, line_start - 1) || s.line || substr(doc, line_end);
      ELSE
        doc := substr(doc, 1, line_start - 1) || rest || E'\n' || s.line || substr(doc, line_end);
      END IF;
    END IF;
    UPDATE schedule_page p SET body = doc WHERE p.space_id = s.space_id AND p.page_id = s.page_id;
  END LOOP;
END $$;

INSERT INTO data.page_revisions (space_id, page_id, revision, body, authors_json, conversation_ids, kind,
  based_on_revision, created_at)
SELECT p.space_id, p.page_id, p.revision, p.body,
  '[{"kind":"agent","id":"xmatrix","label":"xMatrix"}]'::jsonb, '{}', 'edit', p.head_revision, now()
FROM schedule_page p;

UPDATE data.pages p SET head_revision = s.revision, version = p.version + 1
FROM schedule_page s WHERE p.space_id = s.space_id AND p.page_id = s.page_id;

UPDATE data.automations a SET
  payload_json = jsonb_set(
    a.payload_json || jsonb_build_object('source', s.line) ||
      CASE WHEN s.once THEN jsonb_build_object('at', to_char(s.at_utc, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
        ELSE '{}'::jsonb END,
    '{input,datum,text}', to_jsonb(s.instruction), false),
  detached_at = NULL, enabled = s.running, version = a.version + 1, updated_at = now()
FROM schedule_line s WHERE a.automation_id = s.automation_id;
