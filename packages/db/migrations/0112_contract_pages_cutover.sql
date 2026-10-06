-- Phase 5 of docs/design/pages-and-conversations-migration.md: the Channel
-- tree, archive state and tree views go. Every Space is moved to pages first,
-- in this same transaction, so nothing they held is lost with them:
--
-- * A Space whose move is drafted has that draft published.
-- * Any other Space has a page tree built from its own Channel tree: a page for
--   the Space, and one for each Channel that kept memory or had Channels under
--   it, holding its summary, its memory and the closing lines of its archived
--   conversations. Every other conversation is linked to the page it sat under.
--
-- A page written from a closed conversation is readable only by those who read
-- all of its closed sources, as when an owner applies a move. Memory entries,
-- messages and conversations themselves are never rewritten or deleted, and the
-- dropped tree and archive facts are kept in each Space's move record.

CREATE FUNCTION pg_temp.migrated_page_id(space_id text, key text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  -- The same id the Hub gives a draft page (page-migration.ts, migratedPageId).
  SELECT (substring(encode(set_byte(set_byte(digest, 6, (get_byte(digest, 6) & 15) | 80),
      8, (get_byte(digest, 8) & 63) | 128), 'hex') FROM 1 FOR 32))::uuid::text
  FROM (SELECT sha256(convert_to('xmatrix-page-migration:' || space_id || ':' || key, 'UTF8')) AS digest) d
$$;

CREATE FUNCTION pg_temp.sibling_position(ordinal bigint) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  -- Three base-62 digits from "100", in the alphabet and order of pagePositionBetween.
  SELECT substr(alphabet, ((ordinal + 3843) / 3844)::int + 1, 1) ||
    substr(alphabet, (((ordinal + 3843) / 62) % 62)::int + 1, 1) ||
    substr(alphabet, ((ordinal + 3843) % 62)::int + 1, 1)
  FROM (SELECT '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'::text AS alphabet) a
$$;

CREATE TEMP TABLE unmoved ON COMMIT DROP AS
  SELECT s.space_id, s.name, s.owner_user_id, m.plan_json,
    COALESCE(m.plan_json ? 'draft', FALSE) AS drafted
  FROM data.spaces s LEFT JOIN data.page_migrations m ON m.space_id = s.space_id
  WHERE m.state IS DISTINCT FROM 'applied';

CREATE TEMP TABLE draft_page (
  space_id text, key text, parent_key text, title text, body text, sources text[],
  ordinal bigint, author jsonb
) ON COMMIT DROP;

-- Drafted moves, as their drafting Agent wrote them.
INSERT INTO draft_page
SELECT u.space_id, page->>'key', page->>'parentKey', left(page->>'title', 200), COALESCE(page->>'body', ''),
  ARRAY(SELECT jsonb_array_elements_text(COALESCE(page->'sources', '[]'::jsonb))), ordinal,
  COALESCE(u.plan_json->'drafter', '{"kind":"agent","id":"xmatrix","label":"xMatrix"}'::jsonb)
FROM unmoved u CROSS JOIN LATERAL jsonb_array_elements(u.plan_json->'draft'->'pages')
  WITH ORDINALITY AS drafted(page, ordinal)
WHERE u.drafted;

-- Every other Space: its conversations as they sat in the Channel tree.
CREATE TEMP TABLE legacy_channel ON COMMIT DROP AS
  SELECT c.space_id, c.channel_id, c.name, c.mode, c.archived_at, c.metadata_json,
    c.parent_channel_id AS parent_id
  FROM data.channels c JOIN unmoved u ON u.space_id = c.space_id AND NOT u.drafted
  WHERE COALESCE(c.metadata_json->>'kind', '') NOT IN ('direct', 'thread');
UPDATE legacy_channel child SET parent_id = NULL
  WHERE NOT EXISTS (SELECT 1 FROM legacy_channel parent
    WHERE parent.space_id = child.space_id AND parent.channel_id = child.parent_id);

CREATE TEMP TABLE legacy_memory ON COMMIT DROP AS
  SELECT a.space_id, a.channel_id, a.payload_json->>'name' AS name,
    NULLIF(btrim(a.payload_json->>'description'), '') AS description, a.payload_json->>'body' AS body
  FROM data.message_annotations a
  JOIN legacy_channel c ON c.space_id = a.space_id AND c.channel_id = a.channel_id
  WHERE a.target_kind = 'channel' AND a.namespace = 'xmem.canonical.v1'
    AND a.payload_json->>'name' IS NOT NULL AND a.payload_json->>'body' IS NOT NULL;

-- A Channel becomes a page when it kept memory or had Channels under it.
CREATE TEMP TABLE legacy_page ON COMMIT DROP AS
  SELECT c.* FROM legacy_channel c
  WHERE EXISTS (SELECT 1 FROM legacy_memory m WHERE m.space_id = c.space_id AND m.channel_id = c.channel_id)
    OR EXISTS (SELECT 1 FROM legacy_channel child
      WHERE child.space_id = c.space_id AND child.parent_id = c.channel_id);

INSERT INTO draft_page
SELECT u.space_id, 'space', NULL, left(u.name, 200), E'## Needs attention\n',
  ARRAY(SELECT c.channel_id FROM legacy_channel c
    WHERE c.space_id = u.space_id AND c.parent_id IS NULL AND c.mode = 'open'
      AND NOT EXISTS (SELECT 1 FROM legacy_page p WHERE p.space_id = c.space_id AND p.channel_id = c.channel_id)
    ORDER BY c.name, c.channel_id),
  0, '{"kind":"agent","id":"xmatrix","label":"xMatrix"}'::jsonb
FROM unmoved u WHERE NOT u.drafted;

WITH RECURSIVE depth AS (
  SELECT p.space_id, p.channel_id, 1 AS level FROM legacy_page p WHERE p.parent_id IS NULL
  UNION ALL
  SELECT p.space_id, p.channel_id, depth.level + 1 FROM legacy_page p
  JOIN depth ON depth.space_id = p.space_id AND depth.channel_id = p.parent_id
  WHERE depth.level < 100
)
INSERT INTO draft_page
SELECT p.space_id, 'channel:' || p.channel_id,
  CASE WHEN p.parent_id IS NULL THEN 'space' ELSE 'channel:' || p.parent_id END,
  left(p.name, 200),
  concat_ws(E'\n\n',
    NULLIF(btrim(p.metadata_json->>'summary'), ''),
    CASE WHEN p.archived_at IS NOT NULL THEN
      'Closed' || COALESCE(': ' || NULLIF(btrim(p.metadata_json->>'archiveReason'), ''), '') END,
    (SELECT string_agg('## ' || CASE WHEN m.name = 'goals' THEN 'Goals' ELSE m.name END || E'\n\n' ||
        COALESCE(m.description || E'\n\n', '') || m.body, E'\n\n' ORDER BY m.name <> 'goals', m.name)
      FROM legacy_memory m WHERE m.space_id = p.space_id AND m.channel_id = p.channel_id),
    (SELECT E'## Closed conversations\n\n' || string_agg('- ' || c.name ||
        COALESCE(': ' || NULLIF(btrim(c.metadata_json->>'archiveReason'), ''), ''), E'\n'
        ORDER BY c.archived_at DESC, c.channel_id)
      FROM legacy_channel c WHERE c.space_id = p.space_id AND c.parent_id = p.channel_id
        AND c.archived_at IS NOT NULL AND c.mode = 'open')),
  ARRAY[p.channel_id] || ARRAY(SELECT c.channel_id FROM legacy_channel c
    WHERE c.space_id = p.space_id AND c.parent_id = p.channel_id AND c.mode = 'open'
      AND NOT EXISTS (SELECT 1 FROM legacy_page child WHERE child.space_id = c.space_id AND child.channel_id = c.channel_id)
    ORDER BY c.name, c.channel_id),
  depth.level, '{"kind":"agent","id":"xmatrix","label":"xMatrix"}'::jsonb
FROM legacy_page p JOIN depth ON depth.space_id = p.space_id AND depth.channel_id = p.channel_id;

-- Publish every draft page. Sources are the Space's own conversations, never a
-- direct one; a parent that is not in the draft makes the page top-level.
CREATE TEMP TABLE published ON COMMIT DROP AS
  SELECT d.space_id, d.key, pg_temp.migrated_page_id(d.space_id, d.key) AS page_id,
    CASE WHEN parent.key IS NULL THEN NULL ELSE pg_temp.migrated_page_id(d.space_id, parent.key) END AS parent_page_id,
    COALESCE(NULLIF(btrim(d.title), ''), 'Untitled') AS title,
    CASE WHEN octet_length(d.body) > 262144 THEN left(d.body, 60000) || E'\n\n[truncated]' ELSE d.body END AS body,
    ARRAY(SELECT source FROM unnest(d.sources) WITH ORDINALITY AS s(source, n)
      JOIN data.channels c ON c.space_id = d.space_id AND c.channel_id = s.source
        AND c.metadata_json->>'kind' IS DISTINCT FROM 'direct'
      GROUP BY source ORDER BY min(n)) AS sources,
    d.author, d.ordinal
  FROM draft_page d LEFT JOIN draft_page parent
    ON parent.space_id = d.space_id AND parent.key = d.parent_key AND parent.key <> d.key;

WITH last_root AS (
  SELECT space_id, max(position) AS position FROM data.pages WHERE parent_page_id IS NULL GROUP BY space_id
), placed AS (
  SELECT p.*, CASE WHEN p.parent_page_id IS NULL THEN COALESCE(r.position, '') ELSE '' END ||
      pg_temp.sibling_position(row_number() OVER (
        PARTITION BY p.space_id, p.parent_page_id ORDER BY p.ordinal, p.title, p.key)) AS position
  FROM published p LEFT JOIN last_root r ON r.space_id = p.space_id
)
INSERT INTO data.pages (space_id, page_id, parent_page_id, title, position, access_mode, head_revision,
  agent_suggest_only, version, created_by_user_id, created_at, updated_at)
SELECT placed.space_id, placed.page_id, placed.parent_page_id, placed.title, placed.position,
  CASE WHEN EXISTS (SELECT 1 FROM data.channels c WHERE c.space_id = placed.space_id
    AND c.channel_id = ANY(placed.sources) AND c.mode = 'closed') THEN 'restricted' ELSE 'open' END,
  1, FALSE, 1, s.owner_user_id, now(), now()
FROM placed JOIN data.spaces s ON s.space_id = placed.space_id;

INSERT INTO data.page_revisions (space_id, page_id, revision, body, authors_json, conversation_ids, kind,
  based_on_revision, created_at)
SELECT space_id, page_id, 1, body, jsonb_build_array(author), sources[1:64], 'edit', NULL, now()
FROM published;

-- Readers of a restricted page: whoever reads every one of its closed sources now.
INSERT INTO data.page_access (space_id, page_id, subject_kind, subject_id, access, created_at)
SELECT p.space_id, p.page_id, 'user', grant_row.subject_id, 'edit', now()
FROM published p
JOIN LATERAL (
  SELECT a.subject_id FROM data.channel_access a
  JOIN data.channels c ON c.space_id = a.space_id AND c.channel_id = a.channel_id AND c.mode = 'closed'
  WHERE a.space_id = p.space_id AND a.channel_id = ANY(p.sources) AND a.subject_kind = 'user'
  GROUP BY a.subject_id
  HAVING count(DISTINCT a.channel_id) = (SELECT count(*) FROM data.channels closed
    WHERE closed.space_id = p.space_id AND closed.channel_id = ANY(p.sources) AND closed.mode = 'closed')
) grant_row ON TRUE;

INSERT INTO data.page_links (space_id, link_id, conversation_id, page_id, block_id, source,
  created_by_kind, created_by_id, created_at, last_seen_at)
SELECT p.space_id, 'migration:' || p.page_id || ':' || source, source, p.page_id, '', 'migration',
  CASE WHEN p.author->>'id' = 'xmatrix' THEN 'system' ELSE p.author->>'kind' END, p.author->>'id', now(), now()
FROM published p CROSS JOIN LATERAL unnest(p.sources) AS source
ON CONFLICT DO NOTHING;

INSERT INTO data.page_migrations (space_id, state, plan_json, proposed_at, confirmed_by_user_id,
  confirmed_at, applied_at, report_json, version)
SELECT u.space_id, 'applied',
  jsonb_build_object(
    'drafter', COALESCE(u.plan_json->'drafter', '{"kind":"agent","id":"xmatrix","label":"xMatrix"}'::jsonb),
    'pages', COALESCE((SELECT jsonb_agg(jsonb_build_object('key', p.key, 'pageId', p.page_id) ORDER BY p.ordinal, p.key)
      FROM published p WHERE p.space_id = u.space_id), '[]'::jsonb),
    'applied', jsonb_build_object('by', '{"kind":"agent","id":"xmatrix","label":"xMatrix"}'::jsonb,
      'authorization', NULL)),
  now(), NULL, now(), now(),
  jsonb_build_object(
    'pages', (SELECT count(*) FROM published p WHERE p.space_id = u.space_id),
    'links', (SELECT COALESCE(sum(cardinality(p.sources)), 0) FROM published p WHERE p.space_id = u.space_id),
    'restrictedPages', (SELECT count(*) FROM data.pages page JOIN published p
      ON p.space_id = page.space_id AND p.page_id = page.page_id
      WHERE p.space_id = u.space_id AND page.access_mode = 'restricted')),
  1
FROM unmoved u
ON CONFLICT (space_id) DO UPDATE SET state = 'applied', plan_json = EXCLUDED.plan_json,
  confirmed_by_user_id = NULL, confirmed_at = EXCLUDED.confirmed_at, applied_at = EXCLUDED.applied_at,
  report_json = EXCLUDED.report_json, version = data.page_migrations.version + 1;

-- Every Space's move record keeps what the Channel tree and archive said when
-- they were retired, so dropping them loses no fact: the parent of each Channel
-- that had one, and when and why each archived Channel was closed. Nothing reads
-- it; it is the record of what the move to pages replaced.
UPDATE data.page_migrations m
SET plan_json = m.plan_json || jsonb_build_object('retiredChannelTree', retired.channels)
FROM (
  SELECT space_id, jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'channelId', channel_id,
      'parentChannelId', parent_channel_id,
      'archivedAt', archived_at,
      'archiveReason', NULLIF(btrim(metadata_json->>'archiveReason'), '')))
    ORDER BY channel_id) AS channels
  FROM data.channels
  WHERE parent_channel_id IS NOT NULL OR archived_at IS NOT NULL
  GROUP BY space_id
) retired
WHERE m.space_id = retired.space_id;

-- A direct conversation is found again by its participants. An archived one
-- that shares them with another yields the key to the newest, since archive
-- no longer tells them apart.
UPDATE data.channels c SET metadata_json = c.metadata_json - 'participantKey'
WHERE c.metadata_json->>'kind' = 'direct' AND c.metadata_json ? 'participantKey'
  AND EXISTS (SELECT 1 FROM data.channels other
    WHERE other.space_id = c.space_id AND other.channel_id <> c.channel_id
      AND other.metadata_json->>'kind' = 'direct'
      AND other.metadata_json->>'participantKey' = c.metadata_json->>'participantKey'
      AND (other.archived_at IS NULL AND c.archived_at IS NOT NULL
        OR (other.archived_at IS NULL) = (c.archived_at IS NULL)
          AND (other.created_at, other.channel_id) > (c.created_at, c.channel_id)));

UPDATE data.channels SET metadata_json = metadata_json - 'archiveReason' - 'archivedAt'
WHERE metadata_json ?| ARRAY['archiveReason', 'archivedAt'];

ALTER TABLE data.channels DROP COLUMN parent_channel_id, DROP COLUMN archived_at;

CREATE INDEX channels_space_activity_idx
  ON data.channels (space_id, activity_at DESC, channel_id);

CREATE INDEX channels_space_direct_activity_idx
  ON data.channels (space_id, activity_at DESC, channel_id)
  WHERE metadata_json->>'kind' = 'direct';

CREATE UNIQUE INDEX channels_direct_participant_key_idx
  ON data.channels (space_id, (metadata_json->>'participantKey'))
  WHERE metadata_json->>'kind' = 'direct' AND metadata_json->>'participantKey' IS NOT NULL;

ALTER TABLE data.user_space_channel_view_preferences DROP COLUMN child_views_json;
