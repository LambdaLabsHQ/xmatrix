-- Pages (docs/design/pages-and-conversations.md): the Space's hierarchy of
-- markdown documents that describe the current state. Every page's content is
-- an immutable, linear revision history; the page row points at its head.
-- Live co-editing is session state in the page's Durable Object and is
-- committed here as revisions, so these tables are the only authority.
CREATE TABLE data.pages (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  parent_page_id TEXT,
  title TEXT NOT NULL,
  -- Sibling order: a fractional key compared bytewise, so it is collated "C".
  position TEXT COLLATE "C" NOT NULL,
  -- 'open' inherits access from the parent (a root page: every Space member);
  -- 'restricted' is readable only by its page_access subjects and Space
  -- owners/admins, and its descendants inherit that.
  access_mode TEXT NOT NULL CHECK (access_mode IN ('open', 'restricted')),
  head_revision BIGINT NOT NULL CHECK (head_revision >= 1),
  -- Agent edits land as suggestions for a human to accept.
  agent_suggest_only BOOLEAN NOT NULL DEFAULT FALSE,
  version BIGINT NOT NULL CHECK (version >= 1),
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id),
  CHECK (length(space_id) BETWEEN 1 AND 300),
  CHECK (length(page_id) BETWEEN 1 AND 300),
  CHECK (parent_page_id IS NULL OR length(parent_page_id) BETWEEN 1 AND 300),
  CHECK (parent_page_id IS DISTINCT FROM page_id),
  CHECK (char_length(title) BETWEEN 1 AND 200),
  CHECK (length(position) BETWEEN 1 AND 100),
  CHECK (updated_at >= created_at)
);

CREATE INDEX pages_children_idx
  ON data.pages (space_id, parent_page_id, position, page_id);

CREATE TABLE data.page_access (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user')),
  subject_id TEXT NOT NULL,
  access TEXT NOT NULL CHECK (access IN ('read', 'edit')),
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id, subject_kind, subject_id),
  CHECK (length(subject_id) BETWEEN 1 AND 300)
);

CREATE TABLE data.page_revisions (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  body TEXT NOT NULL,
  -- [{kind:'user'|'agent', id, label, ownerUserId?}] of everyone whose edits
  -- this revision commits.
  authors_json JSONB NOT NULL,
  -- The conversations those edits came from.
  conversation_ids TEXT[] NOT NULL DEFAULT '{}',
  -- 'edit' commits directly; 'suggestion' awaits acceptance and never becomes
  -- the head until accepted.
  kind TEXT NOT NULL CHECK (kind IN ('edit', 'suggestion', 'accepted', 'restore', 'purge')),
  based_on_revision BIGINT,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, page_id, revision),
  CHECK (octet_length(body) <= 262144),
  CHECK (jsonb_typeof(authors_json) = 'array'),
  CHECK (cardinality(conversation_ids) <= 64)
);

-- A conversation (a Channel) relates to a page, one of its blocks, or a
-- section of a mounted repository document.
CREATE TABLE data.page_links (
  space_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  -- The heading slug of a block; empty links the whole page.
  block_id TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('jev', 'read', 'edit', 'reference', 'manual', 'migration')),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent', 'system')),
  created_by_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, link_id),
  CHECK (length(conversation_id) BETWEEN 1 AND 300),
  CHECK (length(block_id) <= 200)
);

CREATE UNIQUE INDEX page_links_target_idx
  ON data.page_links (space_id, conversation_id, page_id, block_id);

CREATE INDEX page_links_page_idx
  ON data.page_links (space_id, page_id, block_id, last_seen_at DESC);

-- A page shows a repository's documentation directory read-through from its
-- default branch; the page store never copies it.
CREATE TABLE data.page_repository_mounts (
  space_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  mount_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  path TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (space_id, mount_id),
  CHECK (repository ~ '^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$'),
  CHECK (length(path) <= 500)
);

CREATE UNIQUE INDEX page_repository_mounts_target_idx
  ON data.page_repository_mounts (space_id, page_id, repository, path);
