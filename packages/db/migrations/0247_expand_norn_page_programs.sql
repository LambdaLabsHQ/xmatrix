-- A program that lives on a Page: the Page and the block's name are its identity across edits.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_programs ADD COLUMN page_id TEXT;
ALTER TABLE data.norn_programs ADD COLUMN page_name TEXT;
