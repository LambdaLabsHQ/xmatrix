-- Pages have no claims and no owed updates, and Spaces no action claims
-- (#996): coordination is lock-free. Since that release nothing reads or
-- writes these tables, and the Space and Conversation purges no longer list
-- them. Production never held a competition or an action claim; the page
-- claims were leases with nothing left to settle. No Automation keeps an
-- `owed` trigger: the one that had it was edited before the release.

SET LOCAL lock_timeout = '5s';

DROP TABLE data.page_claims;
DROP TABLE data.page_block_competitions;
DROP TABLE data.space_action_claims;
