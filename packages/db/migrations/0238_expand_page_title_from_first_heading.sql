-- A page's title is its document's first top-level heading (`# Title`) outside
-- fenced code, wherever it stands (docs/design/pages-live-document.md §4.1):
-- a note, an image or a stray line above it no longer leaves the page
-- "Untitled". A document with no such heading, or whose first one is empty, has
-- no title. data.page_title reads the line the protocol's pageTitleLine reads,
-- with markdownLines' fences. data.page_name (0192), which read only a heading
-- the document opens with, stays for the Hub this release replaces; a contract
-- migration drops it once nothing calls it.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION data.page_title(body TEXT) RETURNS TEXT
  LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
  AS $$
DECLARE
  line TEXT;
  marker TEXT;
  rest TEXT;
  fence TEXT;
BEGIN
  -- Most documents open with their title: read it from their start alone.
  line := substring(left(body, 4096) FROM '^(?:[ \t]*\n)*( {0,3}#(?:[ \t][^\n]*)?)\n');
  IF line IS NOT NULL THEN
    RETURN NULLIF(rtrim(ltrim(substring(line FROM '^ {0,3}#(.*)$'), E' \t'), E' \t\r'), '');
  END IF;
  -- Otherwise only fence lines and top-level heading lines matter, in order.
  FOR line IN SELECT m[1] FROM regexp_matches(body,
      '^( {0,3}(?:`{3,}|~{3,})[^\r\n  ]*| {0,3}#(?:[ \t][^\n]*)?)$', 'gn') AS m LOOP
    marker := substring(line FROM '^ {0,3}(`{3,}|~{3,})');
    IF marker IS NULL THEN
      IF fence IS NULL THEN
        RETURN NULLIF(rtrim(ltrim(substring(line FROM '^ {0,3}#(.*)$'), E' \t'), E' \t\r'), '');
      END IF;
    ELSE
      rest := substr(ltrim(line, ' '), length(marker) + 1);
      IF fence IS NULL THEN
        -- A backtick fence's info string cannot hold a backtick.
        IF left(marker, 1) = '~' OR strpos(rest, '`') = 0 THEN
          fence := marker;
        END IF;
      ELSIF left(marker, 1) = left(fence, 1) AND length(marker) >= length(fence)
          AND rest ~ '^[ \t\v\f   -   　﻿]*$' THEN
        fence := NULL;
      END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END
$$;
