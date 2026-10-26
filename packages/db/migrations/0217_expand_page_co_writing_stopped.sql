-- A person stopping co-writing is sticky (`stopped`). Leaving the page is not
-- an end: rows ended before this column cannot be told apart, and the page
-- wakes a recent one when people type again (page-control.ts).

-- Fail fast instead of queueing Runtime traffic behind this transaction.
SET LOCAL lock_timeout = '5s';

ALTER TABLE data.page_co_writing
  ADD COLUMN stopped BOOLEAN;
