# MCP server for outside AI apps

Outside AI apps (ChatGPT apps, Grok custom connectors, Cursor, Codex and
other MCP clients) reach a person's xMatrix through one remote MCP server on
the Hub. The app acts as that person, with exactly the access they have in
xMatrix, and only for what they allowed.

## Endpoints

| Path (Hub origin) | What |
|---|---|
| `POST /mcp` | MCP over streamable HTTP, JSON responses only (no server-sent stream; `GET /mcp` is 405). |
| `GET /.well-known/oauth-protected-resource[/mcp]` | Protected resource metadata (RFC 9728): the resource, its authorization server and scopes. |
| `GET /.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` | Authorization server metadata (RFC 8414), served by Better Auth at the issuer root. |
| `/api/auth/oauth2/*` | Register (RFC 7591, unauthenticated, public clients), authorize, consent, token, revoke, userinfo. |

An unauthenticated `POST /mcp` answers 401 with
`WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`,
which is how clients discover where to sign in.

## Authorization

- **The Hub is the OAuth 2.1 authorization server** (Better Auth
  `@better-auth/oauth-provider`, PostgreSQL authority only; tables
  `control.auth_oauth_*`). Authorization code with PKCE (S256), refresh
  tokens with rotation and replay revocation; tokens and client secrets are
  stored hashed.
- **Sign-in and consent are Web pages.** Without a session the Hub sends the
  person to `/oauth/authorize`, which signs them in as usual and resumes the
  request; consent is `/oauth/consent`. The consent page shows the app's
  self-declared name and, as the trustworthy part, the host the grant returns
  to.
- **Access tokens are short-lived ES256 JWTs whose audience is `…/mcp`.**
  The Hub's own API requires its own audience, so an MCP token never works
  there and a session token never works on `/mcp`. A token request that
  names no `resource` gets the MCP resource: it is the Hub's only protected
  resource.
- **Scopes**: `xmatrix:read` (reading tools), `xmatrix:write` (writing
  tools, offered with reading); plus `openid`, `profile`, `email`,
  `offline_access`.
- **Removing an app** (profile → AI apps) deletes its consent and every
  refresh token it holds; its last access token expires within 15 minutes.
  A revoked account identity is refused on every call.

## Tools

Reading (`xmatrix:read`, all `readOnlyHint`): `list_spaces`, `list_pages`,
`search_pages`, `read_page`, `list_channels`, `read_channel`. Each calls the
same authority as the Web app with the person as principal, so a page or
channel they cannot read is a tool error the model sees, never data.

Writing (`xmatrix:write` as well): `create_page`, `edit_page` (on the
revision read; an overlapping edit is refused with the current text),
`send_message`. Each runs through the Hub's own route in-process as the
person (`internal-caller.ts`: a single-use key plus a secret only the isolate
holds, no minted credential), so an app's message or edit is the same act,
with the same checks and effects (mentions summon Agents), as one made in
xMatrix.

## Not yet

- Showing which app wrote a message or revision ("via ChatGPT").
- A ChatGPT page-card widget (Apps SDK output template).
- The ChatGPT app directory (submitted from the OpenAI dashboard by a
  person). Grok and Cursor connect by entering the URL. The Claude connector
  directory is not a target.

## Listing

The official MCP Registry lists the server as `io.github.LambdaLabsHQ/xmatrix`
from `deploy/mcp-registry/server.json`; `mcp-registry-publish.yml` publishes
it with this repository's GitHub OIDC identity when that file changes on
main, so a new listing is a new `version` there.
