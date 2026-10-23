-- Gmail notifications reach Channels through `@gmail:subscribe` source
-- relations (#760, 0208): nothing reads or writes
-- data.app_gmail_routes.channel_id any more.

SET LOCAL lock_timeout = '5s';

ALTER TABLE data.app_gmail_routes DROP COLUMN channel_id;
