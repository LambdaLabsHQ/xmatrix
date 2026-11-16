-- How far a person has read a page is the newest revision they have had open
-- (#1522): nothing times which blocks were on screen or keeps the page as its
-- reader saw it. Since that release nothing reads or writes
-- data.page_reads.seen_body (0206), and the Hub it served no longer runs.
-- Apply after the Hub of #1522 is verified.

SET LOCAL lock_timeout = '5s';

ALTER TABLE data.page_reads DROP COLUMN seen_body;
