-- A page's name is the top-level heading its document opens with
-- (docs/design/pages-live-document.md §4.1): one datum, kept in the document.
-- Renaming a page edits that line; lists, search and links read the name from
-- the head revision with data.page_name, which reads it as the Hub's
-- pageNameFrom does. data.pages.title stops being written; 0193 writes each
-- page's title into a document that does not open with one, and a later
-- contract migration drops the column.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION data.page_name(body TEXT) RETURNS TEXT
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(btrim(substring(ltrim(left(body, 4096), E' \t\r\n')
    FROM '^#[[:blank:]]+([^\n]*[^[:space:]])')), '') $$;

ALTER TABLE data.pages ALTER COLUMN title DROP NOT NULL;
