-- What chat lists show of a message: its one-line body and its sender as it
-- was, written with the payload it is derived from. Catalog and page reads
-- return it instead of the whole payload bundle (3.3 KB on average) for each
-- Channel's newest message. Messages written before this column read their
-- payload as before.
ALTER TABLE data.messages ADD COLUMN preview_json JSONB;
