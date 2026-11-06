-- A page's name is read by data.page_title (0238, #1438): its document's
-- first top-level heading, wherever it stands. data.page_name (0192) read only
-- a heading the document opens with; since that release nothing calls it, and
-- the Hub it served no longer runs. Apply after the Hub of #1438 is verified.

SET LOCAL lock_timeout = '5s';

DROP FUNCTION data.page_name(TEXT);
