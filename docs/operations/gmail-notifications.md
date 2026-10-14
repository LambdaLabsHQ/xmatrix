# Native Gmail notifications

This optional feature supplies mailbox-change signals, then queries new inbox
message IDs. Existing Composio search/read/reply remain installed. It requires
neither forwarding nor periodic inbox searches. It remains unavailable until
its six configuration fields are installed together through the normal release.

## Provisioning

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

## User flow and acceptance

In Apps → Gmail, choose an owned mailbox and conversation, then Enable
notifications. Google consent requests metadata notification access separately
from the existing content connection. The callback verifies the same Human,
Space, mailbox, PKCE proof and single-use attempt; no forwarding setup is needed.
The Hub renews watch daily. Copy the notification ID to configure an event Page
Automation with `--on gmail:message.received:<notification-id>`.

Before public activation, verify a dedicated test mailbox end to end: authorize,
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
replaying older messages as new notifications. Stop clears the local encrypted grant;
removing or changing mailbox credentials also retires watchers. Gmail sending
retains its existing per-message approval policy.

Sources: [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push),
[watch API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch),
[authenticated Pub/Sub push](https://cloud.google.com/pubsub/docs/authenticate-push-subscriptions).
