-- A Norn program can ask a connected app to do something by itself (Norn spec
-- §6.3, docs/architecture/norn-host.md "Asking a connected app"). The host
-- holds such a request, and nothing else reports on it: this is when the host
-- looks at it again without being told, for an approval nobody answered or an
-- action whose executor never reported. The Channel's coordinator sets its
-- alarm to it. Nullable and unread by old writers; no row is rewritten.
SET LOCAL lock_timeout = '5s';
ALTER TABLE data.norn_requests ADD COLUMN host_due_at TIMESTAMPTZ;
