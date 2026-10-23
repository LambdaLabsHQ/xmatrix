# OAuth callback recovery

Google and GitHub sign-in, plus GitHub account linking, use Better Auth's database-backed
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
The `xmatrix_auth_metric` callback outcome marks these as errors. Each provider's
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

The login page offers GitHub alongside Google and email. Both social providers
use the same validated return path, including the CLI/native device context;
a successful browser sign-in still requires explicit device approval. Cleanup
removes provider callback parameters only from login return pages. A return to
`/oauth/authorize` retains the outside app's own `state` and authorization query;
otherwise the resumed consent flow loses its browser binding. Return origins
still must match the app origin. A refused or cancelled provider sign-in
returns to the sign-in page it started from, with that page's own query (the
device request, `next`) and without the provider's callback leftovers, so a
device waiting for approval is not lost with the attempt. The page words the
refusal by its code (cancelled, no verified email, an existing account to link,
an expired or foreign-browser state) and offers email recovery. Both providers
ask with `prompt=select_account`, so a browser signed in to one Google or
GitHub account can still choose another.
GitHub uses the existing `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET`
and `/api/auth/callback/github`; the App needs Email addresses: read permission.
No repository installation or Space connector grant is created by signing in.
A linked GitHub identity signs into its existing Human account. Better Auth
reads private addresses from `/user/emails`; implicit email matching requires
GitHub to report the address as verified. GitHub is not a trusted-provider
exception to that check. Different-email explicit linking remains available
from the signed-in profile.

Sign-in starts share the `social_sign_in` metric route group; successful
callbacks record `google_callback` or `github_callback` only when a fresh
session cookie is issued. PostgreSQL regressions cover both providers' state
refusal/replay/expiry and GitHub private-email sign-up, stable returning identity,
and refusal to link an unverified matching email. Browser regressions exercise
the actual provider buttons, return contexts, pending state and error recovery.
Provider API responses are fixtures in these tests; they do not establish a
human's live GitHub consent.
