SET LOCAL lock_timeout = '5s';
-- Gmail notifications reach Channels through `@gmail:subscribe` relations, not a
-- Channel fixed on the notification. New rows leave channel_id empty; a later
-- contract migration drops the column.
ALTER TABLE data.app_gmail_routes ALTER COLUMN channel_id DROP NOT NULL;
