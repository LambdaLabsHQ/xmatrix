-- The Hub as an OAuth 2.1 authorization server for outside AI apps
-- (ChatGPT, Grok, Cursor) that reach a person's pages and channels through
-- the Hub's MCP endpoint. These are Better Auth's oauth-provider models;
-- list-valued fields are JSON text, as its adapter writes them, and tokens
-- are stored hashed.

CREATE TABLE control.auth_oauth_clients (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  client_secret TEXT,
  disabled BOOLEAN,
  skip_consent BOOLEAN,
  enable_end_session BOOLEAN,
  subject_type TEXT,
  scopes TEXT,
  user_id TEXT REFERENCES control.auth_users (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  name TEXT,
  uri TEXT,
  icon TEXT,
  contacts TEXT,
  tos TEXT,
  policy TEXT,
  software_id TEXT,
  software_version TEXT,
  software_statement TEXT,
  redirect_uris TEXT NOT NULL,
  post_logout_redirect_uris TEXT,
  token_endpoint_auth_method TEXT,
  grant_types TEXT,
  response_types TEXT,
  public BOOLEAN,
  type TEXT,
  require_pkce BOOLEAN,
  reference_id TEXT,
  metadata JSONB,
  CHECK (length(id) BETWEEN 1 AND 300),
  CHECK (length(client_id) BETWEEN 1 AND 300),
  CHECK (length(redirect_uris) <= 20000)
);

CREATE INDEX auth_oauth_clients_user_idx ON control.auth_oauth_clients (user_id) WHERE user_id IS NOT NULL;

CREATE TABLE control.auth_oauth_refresh_tokens (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES control.auth_oauth_clients (client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES control.auth_sessions (id) ON DELETE SET NULL,
  user_id TEXT NOT NULL REFERENCES control.auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  revoked TIMESTAMPTZ,
  auth_time TIMESTAMPTZ,
  scopes TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_oauth_refresh_tokens_user_idx ON control.auth_oauth_refresh_tokens (user_id, client_id);

CREATE TABLE control.auth_oauth_access_tokens (
  id TEXT PRIMARY KEY,
  token TEXT UNIQUE,
  client_id TEXT NOT NULL REFERENCES control.auth_oauth_clients (client_id) ON DELETE CASCADE,
  session_id TEXT REFERENCES control.auth_sessions (id) ON DELETE SET NULL,
  user_id TEXT REFERENCES control.auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  refresh_id TEXT REFERENCES control.auth_oauth_refresh_tokens (id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  scopes TEXT NOT NULL,
  CHECK (length(id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_oauth_access_tokens_user_idx ON control.auth_oauth_access_tokens (user_id, client_id);

CREATE TABLE control.auth_oauth_consents (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES control.auth_oauth_clients (client_id) ON DELETE CASCADE,
  user_id TEXT REFERENCES control.auth_users (id) ON DELETE CASCADE,
  reference_id TEXT,
  scopes TEXT NOT NULL,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  CHECK (length(id) BETWEEN 1 AND 300)
);

CREATE INDEX auth_oauth_consents_user_idx ON control.auth_oauth_consents (user_id, client_id);
