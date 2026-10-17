-- Who handed each linked GitHub installation to its Space. Only the Hub's
-- GitHub Connect completion writes a row, after GitHub's own `/user` named the
-- person and showed they administer the installation; connection metadata,
-- which Space admins edit, never supplies one. Using a repository through the
-- installation requires that this GitHub user still administers it, so a link
-- made before this table existed has no row and is refused until an
-- administrator connects again. No backfill guesses who linked it.
SET LOCAL lock_timeout = '5s';

CREATE TABLE data.app_github_installation_links (
  connection_id TEXT NOT NULL REFERENCES data.app_connector_connections(connection_id) ON DELETE CASCADE,
  space_id TEXT NOT NULL,
  installation_id TEXT NOT NULL CHECK (installation_id ~ '^[1-9][0-9]{0,19}$'),
  github_user_id BIGINT NOT NULL CHECK (github_user_id >= 1),
  linked_by TEXT NOT NULL CHECK (length(linked_by) BETWEEN 1 AND 300),
  linked_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (connection_id, installation_id),
  CHECK (connection_id = space_id || ':github')
);
