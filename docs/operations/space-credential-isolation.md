# Space credential isolation

OAuth company application credentials stay in Hub deployment secrets. A Space's
provider grants live in `data.app_connector_credentials`; user-supplied secrets
live in `data.space_secrets`. Sharing a company OAuth client does not select a
shared user grant.

| Boundary | Current authority |
| --- | --- |
| OAuth start | Current owner/admin membership in the requested Space, before signed state or a Composio connect request |
| OAuth completion | Signed provider/Space/initiator state, the same signed-in Human, and current owner/admin membership before exchange; the write rechecks membership |
| Connector execution | The authorized Channel determines its Space connection; credentials resolve by that connection, without an owner/global fallback |
| Composio | A connect attempt uses `xmatrix:<space>:<nonce>`; calls name the saved connected account |
| GitHub repository token | The live admitted Run, Machine, execution and repository bind the request; the Channel determines the Space's linked installations |
| Run secret read | The exact live Run/Instance/execution, registration admission, token Space and current owner membership; `ask` approvals also join on Space |
| New ciphertext | AES-GCM additional data binds connector values to connection/version and Space secrets to Space/alias/value version |

## Historical owner-secret migration

Migration `0123_expand_space_secrets.sql` intentionally copied the retired
personal secret catalog into Space-owned rows. A secret referenced by an Agent
registration/access grant went to the referenced Spaces as `auto`. If there
were no such references anywhere, it went to **each** Space where its creator
was an owner/admin, as `ask`. Internal OAuth sessions and expired values were
excluded. Migration `0126` subsequently removed the owner catalog.

These are independent saved copies, not a runtime fallback. A same-alias secret
in multiple Spaces can therefore originate from migration rather than a later
unauthorized read. Copied legacy envelopes retain their creator binding
(`secret-authority:v1`) until a Human sets the value again; those envelopes do
not yet have the newer Space cryptographic binding. Current read authorization
still uses the Space-owned row and exact Run.

Determining whether particular production copies were unwanted requires an
authorized metadata review of the affected Spaces. Source inspection and
synthetic tests do not establish production disclosure or exclude historical
misuse. Do not remove copies or rotate existing secrets as part of a read-only
audit; those actions belong to the Human admins.

## Local execution boundary

Space scoping applies to Hub capabilities and credential selection. Agents run
as their owner's OS user; Spaces do not isolate that user's local filesystem,
process environment or provider login. A value deliberately injected through
`secret exec` is available to that child process. Local same-user execution is
not a tenant sandbox. See [Agent Run permissions](agent-run-permissions.md).

## Regression evidence

`connector-oauth-authorization-postgres.test.mjs` exercises the OAuth routes
against real membership rows: admin in one Space/member in another, absent
Space, revoked membership, viewer and scheduled deletion. It observes that
refused starts and completions make no external provider call. Both OAuth
regressions fail before the authorization fix.

The two-Space cases in `space-secret-postgres.test.mjs` and
`app-credential-postgres.test.mjs` exercise independent same-alias values,
approval separation, a forged Run Space and ciphertext transplantation against
real PostgreSQL. Existing OAuth, callback, Discord and Gmail tests cover state
tampering, initiator mismatch and per-attempt Composio account selection.
