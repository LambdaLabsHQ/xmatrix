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
  self-declared name, explicitly says that xMatrix has not verified the app's
  identity, and prominently shows the host the grant returns to. Users should
  approve only a connection they started from an app they trust. Approval is
  unavailable when the app lookup fails or the return address is missing.
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

### Open registration and phishing

Open registration is an intentional compatibility choice for outside MCP
clients ([RFC 7591 Appendix A.1.1](https://www.rfc-editor.org/rfc/rfc7591.html#appendix-A.1.1)).
A registered client id is not a verified application identity or an account
grant. A caller can supply another app's name and its own callback, so a
phishing link can still persuade a person to authorize an untrusted app.
The consent warning and return host help the person make that decision;
they do not verify a provider's identity.

Registration is limited to ten requests per client IP per minute, always
enforced and counted exactly in the device login broker's Durable Object
(`request-rate-limit.ts` `AUTH_ROUTE_ATTEMPTS`). Better Auth's own limiter
counts per isolate and is off; the Workers Rate Limiting binding was tried
and refused nothing in production, so neither is relied on. A registered name is at most 100
characters of visible text, so it cannot push the consent warning out of view.
Anonymous registration creates public clients;
it cannot request `client_credentials` or `skip_consent`. Authorization requires
a signed-in person, approval for a new grant, a registered redirect URI
(exact matching except OAuth's loopback-port exception), and S256 PKCE. The
Hub signs the query passed to the consent page and rejects altered or unsigned
queries when the person answers. The existing PostgreSQL OAuth owner tests
exercise these refusals as well as denial, audience isolation and revocation.

Requiring an initial access token or a curated redirect allowlist would change
the documented client onboarding contract. Clients currently using open DCR
would need another supported registration path before that policy could ship.

## Tools

Reading (`xmatrix:read`, all `readOnlyHint`): `list_spaces`, `list_pages`,
`search_pages`, `read_page`, `show_page`, `list_channels`, `read_channel`. Each calls the
same authority as the Web app with the person as principal, so a page or
channel they cannot read is a tool error the model sees, never data.

Writing (`xmatrix:write` as well): `create_page`, `edit_page` (on the
revision read; an overlapping edit is refused with the current text),
`send_message`. Each runs through the Hub's own route in-process as the
person (`internal-caller.ts`: a single-use key plus a secret only the isolate
holds, no minted credential), so an app's message or edit is the same act,
with the same checks and effects (mentions summon Agents), as one made in
xMatrix.

Both page replacement and message sends are marked `destructiveHint: true`:
a sent message may already have been read or have summoned an Agent before
it can be recalled. All tools stay within the caller's bounded private
Spaces, so `openWorldHint` is false.

Writes carry optional application attribution alongside the human author:
the signed token's OAuth client id and its registration's self-declared name.
Hub sets it on the internal caller, Page revision author JSON, and reserved
`xmatrixMcpApplication` message metadata. Public callers cannot provide it.
Web history and message headers show "via …"; the name is identified as
self-declared, not proof of a verified provider. Older clients ignore these
optional fields and keep showing the same human author. No schema migration
or additional acting identity is needed.

## Page cards and directory submission

`show_page` returns the same authorized current page as `read_page` and names
`ui://xmatrix/page-card-v1.html` through MCP Apps `_meta.ui.resourceUri` (and
the ChatGPT output-template compatibility key). `resources/list` and
`resources/read` expose only that static view to callers with a read grant.
The view uses the MCP Apps initialization handshake and tool-result
notifications; it renders text safely and opens canonical xMatrix page links
through the host. It needs no external scripts, network access, or credentials.
Its sandbox-domain metadata names the xMatrix Web origin, unique to this plugin.
Existing data tools stay text-first; clients without UI still get the page.

The ChatGPT/Codex directory package is in `deploy/chatgpt-plugin`.
Its README describes the ZIP builder and the remaining portal steps, including
publishing identity, domain verification, reviewer access, and a real demo.

## Not yet

- The ChatGPT app directory (submitted from the OpenAI dashboard by a
  person). Grok and Cursor connect by entering the URL. The Claude connector
  directory is not a target.

## Listing

The official MCP Registry lists the server as `io.github.LambdaLabsHQ/xmatrix`
from `deploy/mcp-registry/server.json`; `mcp-registry-publish.yml` publishes
it with this repository's GitHub OIDC identity when that file changes on
main, so a new listing is a new `version` there.
