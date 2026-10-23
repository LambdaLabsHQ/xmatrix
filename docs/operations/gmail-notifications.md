# Gmail notifications

## Inbox count polling

The default notification setup uses the existing company Google connector client
(`CONNECTOR_GOOGLE_CLIENT_ID` and `CONNECTOR_GOOGLE_CLIENT_SECRET`) and its already
registered `/api/connectors/oauth/callback` redirect. Gmail API must be enabled
in that client's project. Existing Composio Gmail content connections remain in
place. No Pub/Sub resources, new OAuth client or `GMAIL_WATCH_*` configuration
are needed for polling.

In Apps → Gmail, the mailbox owner turns notifications on for the mailbox. A
Channel receives them by subscribing, as with any connector event:
`@gmail:subscribe:<mailbox>` (or `*` for all of the owner's mailboxes); only the
owner and their Agents may subscribe a mailbox.
Consent requests `gmail.labels`, `openid` and `userinfo.email`. The Gmail scope
is non-sensitive; basic identity access confirms that the Google grant belongs
to the selected mailbox without calling Gmail profile with a restricted scope.
The labels scope permits label editing, but this implementation only reads
`labels/INBOX`. It does not request Gmail metadata, read or modify permission
for our Google client. Ordinary Google app publication requirements still apply.

Setup checks Human/Space/mailbox ownership, current credentials, signed state,
PKCE and a single-use attempt. Google userinfo must return the selected verified
email; the selected Composio account's Gmail profile independently supplies the
initial history cursor. These grants are separate from Drive connector tokens.
The callback opens the Gmail detail in Apps. Space URL normalization preserves
its completion parameters until that view loads; the view removes the code and
state from the address before submitting the single-use completion request.
Declined consent returns to Gmail with a retry notice, without exchanging a code.
Access and refresh tokens remain encrypted in the notification authority; the
access token is reused until shortly before expiry and refreshed as needed.

The existing minute cron checks four INBOX counts. A change durably marks work
pending before a query, then the same Composio account reads Gmail's incremental
`messageAdded` IDs. Label moves of old mail cannot become new-mail events.
An independent check is due 15 minutes after the last completed incremental
scan, even when the counts stay unchanged. Confirmation reads opaque IDs and
labels, never bodies. Existing ID deduplication and Automation delivery are
shared with native watches. Sending retains its existing approval policy.

The product target is useful notification for most ordinary inbox arrivals,
with minute-level detection under normal scheduling. Simultaneous count changes
can cancel, and the periodic check reduces these misses. These are scheduling
intervals, not delivery deadlines. A pass claims at most 20 mailboxes, processes
four concurrently and retains bounded leases, retry delays and durable paging.
Larger fleets require capacity measurement before promising minute-level coverage.
Composio confirmation and periodic checks use its existing metered proxy;
an idle mailbox normally adds four proxy calls per hour, plus setup/recovery.

Failures retain the consumed history cursor and pending wake. Polling retries
after transient failures, including Gmail throttling. Expired history establishes
a new baseline and posts a visible gap warning rather than replaying old mail.
Revoked grants require reauthorization and erase stored Google tokens. Stop,
mailbox reconnection, ownership changes and deletion fence in-flight work using
the existing notification lifecycle; gap and reauthorization notices go to the
mailbox's subscribed Channels. Multiple owned mailboxes can listen concurrently,
each with its own subscriptions, cursor, ID receipts and Stop control. Adding or changing another mailbox preserves a listener only when its
Composio account, address, owner and shared credentials are identical before and
after the authoritative credential update. The update advances its credential
version atomically and clears the old lease, so an old worker cannot finish or
disable it. Changed mailboxes, pending attempts and shared credential changes
retire their grants; notification authorization is never transferred to a new
account or owner. Adding a content connection leaves an existing configured
Gmail connection active while the new mailbox is checked. Stopping does not
revoke the shared Google app globally or affect other Spaces.

If consent completion fails, the error distinguishes an invalid token response,
missing offline refresh permission and mismatched scopes. Scope diagnostics contain
only bounded public scope identifiers; tokens and arbitrary provider strings are
never included. A returned scope set that differs from labels and basic identity
remains rejected, including a combined grant from the shared Google application.

Acceptance covers labels-only Gmail scopes plus basic identity, wrong-mailbox
and broad-grant rejection, unchanged counts, changed counts, independent periodic
checks, failed confirmation, cursor paging, duplicate IDs, stop and lease loss.
Live acceptance requires the mailbox owner to complete Google consent, receive
a dedicated test message, observe one notification/Automation, and stop. Never
copy tokens or real mail content into evidence.

Sources: [labels.get](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/get),
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Google identity](https://developers.google.com/identity/openid-connect/openid-connect).

## Optional native watch

This optional feature supplies mailbox-change signals, then queries new inbox
message IDs. Existing Composio search/read/reply remain installed. It requires
neither forwarding nor periodic inbox searches. It remains unavailable until
its six configuration fields are installed together through the normal release.

### Provisioning

Use a dedicated Google project; do not add restricted Gmail permissions to the
shared Drive client without reviewing its verification scope. Enable Gmail API
and Pub/Sub. Create a Web OAuth client with the exact Hub redirect URI
`https://<hub-host>/api/connectors/gmail-watch/callback`. Request only
`https://www.googleapis.com/auth/gmail.metadata`; this is still a restricted
scope. Develop and record the demonstration before submitting the appropriate
Google verification and applicable security assessment. An unverified application's
100-user limit does not authorize public commercial rollout. Assessment expenses
require a separate human budget decision.

Create a Pub/Sub topic in the same project as the OAuth client, and grant
`gmail-api-push@system.gserviceaccount.com` publisher access to that topic.
Create an authenticated HTTPS push subscription to
`https://<hub-host>/api/connectors/gmail-watch/events`. Its service account must
belong to this project; configure token-creator and service-account-use rights as
required by Google's authenticated push setup. Set its OIDC audience to the exact
push endpoint. Configure a dead-letter topic and operational alert for deliveries
that repeatedly fail; malformed authenticated envelopes are rejected rather than
recorded as successful work. Keep Google credentials out of chat and logs.

Install these repository/environment secrets together for the Hub release:

- `GMAIL_WATCH_CLIENT_ID`: the dedicated Google OAuth client ID.
- `GMAIL_WATCH_CLIENT_SECRET`: its client secret.
- `GMAIL_WATCH_TOPIC`: `projects/<project>/topics/<topic>`.
- `GMAIL_WATCH_PUSH_EMAIL`: the push service account's verified email.
- `GMAIL_WATCH_PUSH_AUDIENCE`: the exact HTTPS push endpoint above.
- `GMAIL_WATCH_SUBSCRIPTION`: `projects/<project>/subscriptions/<subscription>`.

All absent means the feature is unavailable. A partial or inconsistent group
fails release configuration validation. Configuration changes invalidate previous
notification grants; users authorize again. Deploy only through Production Release
Intent. This runbook does not authorize provisioning paid resources.

### User flow and acceptance

In Apps → Gmail, Turn on an owned mailbox's notifications, then run
`@gmail:subscribe:<mailbox>` in each conversation that should receive them.
Google consent requests metadata notification access separately
from the existing content connection. The callback verifies the same Human,
Space, mailbox, PKCE proof and single-use attempt; no forwarding setup is needed.
The Hub renews watch daily. An event Page Automation uses
`--on gmail:message.received:<mailbox>`.

Before public activation, probe the deployed push endpoint: no native configuration
returns 503; configured ingress without a Bearer token returns 401. A generic
connector 404 means the native handler is shadowed and must be fixed before use.
Then verify a dedicated test mailbox end to end: authorize,
receive a new inbox message, see exactly one ID notification, read via the existing
private Gmail tool, verify a duplicate push cannot duplicate the message, and
stop. Verify a foreign service account, wrong audience, malformed payload,
revoked owner access and expired authorization cannot deliver work. Verify automatic
renewal leaves the consumed history cursor intact. Do not copy real email content,
OAuth codes or tokens into acceptance evidence.

No event means no history query. Scheduled work only renews watch or recovers
accepted unfinished events. Notifications can be delayed or dropped by Google;
this design does not promise lossless delivery or a maximum delay. An expired
history cursor establishes a fresh baseline and posts a gap warning, without
replaying older messages as new notifications. Google throttling retries rather than revoking the watcher. A revoked native grant
retains a visible reauthorization state after clearing its refresh token; expired
workers cannot finalize or disable a watcher. Stop clears the local encrypted grant;
removing or changing mailbox credentials also retires watchers. Gmail sending
retains its existing per-message approval policy.

Sources: [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push),
[watch API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch),
[authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
