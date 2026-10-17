# OAuth callback recovery

Google sign-in and GitHub account linking use Better Auth's database-backed
OAuth state in `control.auth_verifications`. A callback must pass its stored
state and signed browser cookie checks before the provider code is exchanged.
Keep these checks enabled; never retry a consumed callback as a new sign-in.

The signed state cookie lasts ten minutes, matching Better Auth 1.6.33's
database state and PKCE lifetime. Its upstream five-minute cookie default
otherwise refuses a browser returning between five and ten minutes even
though the server state is still valid. This changes only the cookie lifetime;
the signed browser binding, stored state expiry and single consumption still
apply. Missing or overwritten cookies still refuse the callback.

A parsed state carries its validated per-flow error return URL. When state is
missing, already consumed, or unparseable, that URL is unavailable. The Hub's
deployment-owned fallback is `${APP_URL}/login`, whose existing error banner
lets the person start a fresh sign-in or request a login code. No callback
query parameter can choose this fallback.

Better Auth returns OAuth refusals as HTTP 302 redirects containing `error`.
The `xmatrix_auth_metric` callback outcome marks these as errors. Google's
`session_created` metric also requires a nonempty newly issued session-token
cookie; a redirect or an expired cookie alone does not establish a session.
Metrics never include the redirect URL, error text, state, code or cookie value.
The original Better Auth exception remains reported.

`State mismatch: verification not found` identifies the missing-row branch
before token exchange. It does not distinguish a replay, expired-state cleanup
or a failed/misdirected state write. Correlate the original callback with its
state creation/consumption and provider outcome before resolving the issue.
If the original logs are unavailable, retain that uncertainty and leave the
issue open; successful unrelated sessions do not prove this flow recovered.

`State mismatch: State not persisted correctly` is a later branch: the
database record was found and parsed, but the signed browser state cookie was
missing, invalid or different from the callback state. The message alone does
not prove the five-minute expiry defect: cookie blocking, parallel flows or
another cause can reach the same branch. Preserve that distinction when
assessing a production event.

`packages/hub/test/oauth-callback-postgres.test.mjs` exercises missing state,
provider denial followed by replay, the per-flow return URL, session refusal
and metric accounting against isolated PostgreSQL. A simulated browser clock
also checks a six-minute return and refusals for missing, mismatched, replayed
and expired state. It does not perform a live provider login.
