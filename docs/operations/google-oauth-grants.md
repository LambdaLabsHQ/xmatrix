# Google OAuth grant expiration

Each Google connector owns an encrypted offline grant, even though it uses the
same company OAuth client. A one-hour access-token expiry normally needs no
user action: `connectionCredentials` refreshes near expiry, saves returned
fields with a credential-version check, and retains the old refresh token when
Google does not rotate it. A stored successful refresh is distinct from the
connection's last Check/configuration timestamp.

## Distinguish the refusal

Google refresh-token refusals now expose fixed, bounded categories without
copying arbitrary provider descriptions:

- `invalid_grant` with `invalid_rapt`: the Cloud session requires
  reauthentication. Reconnect; consult the organization's session policy.
- Other `invalid_grant`: the authorization expired or was revoked. Reconnect
  the affected app, then investigate issuance/consent timing, revocation and
  account policy. This code alone does not prove one cause.
- `invalid_client`: the company OAuth application credentials were rejected;
  an admin checks the application configuration rather than repeatedly
  reconnecting individual users.
- Other failures: a generic token-request failure, retaining the HTTP status.

There are no automatic retries or policy bypasses for these refusals. Failed
refreshes do not clear the encrypted grant or overwrite a newer credential.
The distinction comes from Google's token endpoint, not a guessed timeout.

## Testing and production

Google documents seven-day refresh tokens for External apps whose publishing
status is Testing, except basic identity-only scopes. Publishing as In
production is separate from OAuth verification. Do not assume it extends an
already-issued Testing grant: reconnect old app connections after publishing.
An unverified production app is not, merely because it is unverified, subject
to that Testing-only lifetime.

Other documented causes include revocation, six months without use,
time-limited consent, refresh-token limits (100 per account/client), and GCP
organization session policies. A successful refresh shortly before seven days
is consistent with Testing expiry but does not by itself prove it; neither
access-token expiry nor the last Check timestamp is a refresh-token issuance
record.

During the October 2026 investigation, preserved Page revisions place the
company application's move to In production on October 18, after the older
Google connections were configured. Read-only database metadata confirmed
successful automatic refresh writes for GCP, Analytics and AdSense on October
23, and for a more recently configured Search Console connection on October
28. This supports old Testing-grant expiry and excludes a completely inactive
refresh path, but the provider's original refusal subtype and exact old grant
issuance record were unavailable. Incident evidence and current native
configuration belong to the work conversation and PR; keep user grants out
of logs, Pages and diagnostics. Hub disconnect clears only that connection's
local grant and does not call Google's project-wide revoke endpoint.

When validating a newly consented grant, check the current Audience and exact
company client, record consent time, run a real read and verify the later
refresh result. Testing grants still require new consent; code cannot prolong
a refresh token Google has already rejected.

Sources: [Google refresh-token expiration and Cloud session policy](https://developers.google.com/identity/protocols/oauth2#expiration),
[Google publishing status and user caps](https://support.google.com/cloud/answer/15549945?hl=en).
