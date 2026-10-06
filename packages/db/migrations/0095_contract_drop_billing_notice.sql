-- The Free allowance is enforced when a message is written: the append
-- statement advances free_message_count only below 500, and the next write is
-- rejected with payment_required. Reaching the limit queues no notice
-- (#2913), so nothing reads or writes the notice queue or the usage notice
-- columns any more.
--
-- Apply only after every serving Hub runs #2913 or later; an older Hub still
-- writes these columns. Notices still pending in the queue are discarded.
--
-- Idempotent: a second run finds nothing to drop.

SET LOCAL lock_timeout = '5s';

DROP TABLE IF EXISTS data.space_billing_notice_deliveries;

ALTER TABLE data.space_billing_usage
  DROP COLUMN IF EXISTS free_limit_notice_state,
  DROP COLUMN IF EXISTS free_limit_notice_channel_id;
