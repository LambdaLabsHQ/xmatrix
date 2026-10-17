# X connector

The `x` connector uses one company-owned X application and independent user
authorizations for company and personal accounts. A Space is not limited to a
fixed number of accounts. Connecting accounts does not combine their grants: each has its
own stable X user ID, connecting Human owner and authorization generation.
Only that member and their Agents can use the account; being a Space admin or
sharing its Channel does not confer account access.

This document defines the implementation and acceptance contract. A released
connector is separate from an authorized company application and successful
native acceptance with both actual accounts. Keep those prerequisites open
until separately verified.

## Company application and consent

Create one company-owned Web App in the X Developer Console. Enable OAuth 2.0
and register exactly
`https://xmatrix-hub.xmatrix.sh/api/connectors/oauth/callback` as its callback.
The Hub is a confidential client using Authorization Code with S256 PKCE and
signed, expiring state bound to the original Space and signed-in admin. The
authenticated completion step must be performed by the same admin who started
the flow. An App-only bearer token cannot replace these user grants.

The requested scope set is `tweet.read users.read tweet.write media.write
offline.access`. It supports the exposed read, publishing and media operations
without private-message, follow or like access. X issues short-lived access
tokens; `offline.access` allows refresh without repeated consent. The official
[OAuth flow](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
documents scopes, confidential clients, expiry and exact callback matching.

Save the company's canonical `CONNECTOR_X_CLIENT_ID` and
`CONNECTOR_X_CLIENT_SECRET` through the designated secret-entry path and GitHub
`production` environment. Release their configuration through the normal
Production Release Intent workflow. Do not paste credentials, authorization
codes or tokens into Channels, Pages, screenshots or shell arguments.

In **Apps → X → X accounts**, use **Add X account** once while signed in to the
company account and again while signed in to the personal account. Check X's
consent screen and the resulting connected handle each time. Each consent is
independent; reconnecting one account replaces only its own authorization.
The UI lists connected handles and their connecting member and allows a Space
admin to remove one account without removing another. Removal includes the
observed generation so a stale UI cannot delete a newer authorization.
Reconnect an account by using its **Reconnect** button and authorizing that
same X account again; confirm the handle on X's consent screen. The signed
flow binds the selected stable account ID and rejects another account. A
Connect that would not fit the 256 KiB `accounts` field asks to remove an
account first; reconnecting an existing account replaces only that grant.

## Credentials and refresh

Account tokens stay in the encrypted connector credential store, in an
`accounts` JSON field of at most 256 KiB. There is no fixed count of accounts.
The Space secret catalog, connection metadata, browser account list and Agent environment do
not contain account credentials. The account management API exposes only ID,
handle, generation, owner, access-token expiry and reconnect status.

Refresh runs on demand under a durable per-account lease with bounded waits.
Only the current lease holder exchanges the refresh token; the rotated access
and refresh tokens must be saved together before the grant is reused. Storage
compare-and-swap preserves concurrent changes to other accounts. Lease loss,
uncertain refresh completion or a failed persistence step cannot replay the
old refresh token or overwrite a newer authorization. An unrecoverable grant
requires fresh consent. No timer polls the accounts or provider timelines.
One account's failure must not grant access to another or prevent its removal.

Every X API call goes through the company app's account, which the operator
pays for. The Hub meters each one (token exchange and refresh included) to the
Space it serves, by API operation and Hub action, never by post, user or
account id; see [usage cost metering](../operations/usage-cost-metering.md).

## Credits

Paid X operations require Pro and use the Space's existing credit balance before
provider I/O, including actions approved or initiated by a Human. The company
application remains responsible for X's bill; users only connect their account.
Plain posts cost 30 credits; URL, quote and attached-media posts use the
400-credit tier (provisional for quotes and attached media). Post reads cost 10 per returned post (a timeline
reserves ten first), and profile lookups cost 20 each, including Connect and
Check. Media upload and status requests provisionally cost 30 each; this is
an explicit retail rate pending verification of X's actual media charges.
A video reserves its whole bounded chunk count before initialize and refunds
unused requests. OAuth token exchange/refresh and local account listing are free.

Rejected admission makes no paid request. Replays cannot repeat the charge or
public write. Pre-request failures and definite provider rejections are refunded;
uncertain outcomes retain the reservation. Results show credits charged/reserved
and remaining. The operator's configured platform admin Space is waived but
still metered. See [Agent credits](../design/agent-credits.md#paid-x-calls) for
the rates, permanent receipt authority, refund and reconciliation contract.

## Actions and publishing approval

`xmatrix connector list` is the runtime command reference. Actions start from
visible Channel commands and their results reply in that Channel; there is no
private connector result path. Channel members can read returned post content,
including content the authorizing account can access. Choose a personal Space
when those results should not be shared with company Channel members.

| Action | Target and text | Contract |
| --- | --- | --- |
| `accounts` | `*` | Lists the caller's usable connected accounts without tokens |
| `read_post` | `<account ID or @handle>/<post ID>` | Reads one selected post |
| `timeline` | `<account ID or @handle>` | Reads up to ten of the selected account's own recent posts |
| `upload_video` | `<account ID or @handle> <message ID>/<attachment ID>` | Uploads one current-Channel MP4 attachment under its own write approval |
| `media_status` | `<account ID or @handle> <media receipt>` | Reads processing status once for the scoped upload receipt |
| `post` | `<account ID or @handle> {"text":"…","mediaReceipt":"…"}` | Publishes the exact text with an optional ready video under Channel policy |
| `quote` | `<account ID or @handle>/<post ID> <text>` | Quotes the selected post with exact text; requires X Enterprise API access |

For example, after `@x:accounts:*` returns the intended stable account ID:

```text
@x:timeline:123456789
@x:read_post:123456789/987654321
@x:post:123456789 {"text":"Company update for review."}
```

Text must fit X's 280 weighted-character limit. The connector validates URL
and Unicode weighting rather than treating that as 280 code units. Post
reads and timeline results are bounded and identify truncation; they are not
complete exports. There is no implicit or most-recent default account.

Video upload accepts one nonempty MP4 attachment of at most 64 MiB from a
message in the calling Channel, with a filename of at most 255 UTF-8 bytes.
It does not accept a remote URL or a caller-supplied X media ID. The upload's
approval freezes the stable account and authorization generation along with
the source message, attachment ID, name, size, content hash and version.
Source access, immutable metadata and current Channel policy are checked again
while streaming the upload. Initialize, append and finalize use X's v2 media
API with at most 64 one-MiB chunks and no automatic replay of an uncertain
write. The transfer has a two-minute deadline, with each provider request
separately bounded. Both approved and allow-mode uploads first freeze their
input in the encrypted PostgreSQL action-request authority, then hand only a
request reference to a scoped Durable Object alarm executor. HTTP and CLI
requests acknowledge admission without waiting for the transfer. The executor
records a started marker before provider I/O and never repeats an uncertain
transfer after a restart. Its encrypted outcome remains in PostgreSQL until a
stable, idempotent Channel receipt is confirmed; delivery retries are bounded.
The executor stores only scheduling references, never tokens or private media.

The result includes an opaque media receipt scoped to the Space, Channel,
calling member, account and authorization generation. It expires within one
hour and no later than X's upload expiry. `media_status` performs one provider
status request and returns pending, in-progress, succeeded or failed with X's
check-after hint; it does not poll. After processing succeeds, include the
receipt in `post`'s optional `mediaReceipt` field. The post JSON is limited to
9,000 characters, including a receipt of at most 4,096 characters. Publishing
checks the receipt's scope, current source access and X's ready status again.
An upload approval does not approve the final public post. Quotes accept text
only.

Publishing defaults to **ask** for each request. A Human Space admin owns the
Channel's allow/ask/disallow policy. An approved write binds the stable X user
ID, its per-connect generation and exact publishing content. The Hub rechecks
the caller's current account ownership, Channel access and policy before
dispatch. A changed handle cannot retarget an approval, and reconnecting or
removing the account invalidates old approvals. Denied, expired or stale
approvals must not publish. A transport failure after submission is an
uncertain provider outcome, not authority for an automatic duplicate post.

X's current [Create Posts reference](https://docs.x.com/x-api/posts/create-post)
restricts `quote_tweet_id` to Enterprise plans; self-serve pay-per-use access
does not establish quote support. Upload success also does not prove a video
can be attached: X checks the posting user's media entitlement at publishing.
Keep native video and quote acceptance open until the actual account and API
plan pass those operations.

Follow X's [automation rules](https://help.x.com/en/rules-and-policies/x-automation),
including restrictions on coordinated duplicate content and unsolicited
automated interactions. API authorization and xMatrix approval do not exempt
the accounts from X's enforcement. Rate limits, plan access and billing remain
provider prerequisites; do not create a paid plan or buy credits implicitly.

## Native acceptance

After the formal Hub and Web release, record each actual account's result
separately:

1. Complete the native OAuth flow for company and personal accounts and
   confirm both distinct handles and owners in Apps. Run Check and `accounts`
   from an authorized Channel.
2. Read a post and a bounded timeline with each explicitly selected account.
   Confirm an unrelated member and their Agents cannot use either grant.
3. Request a test post per account and inspect the approval's account and exact
   text. Deny one request and approve another; confirm only the approved post
   appears on its selected account. Reconnect and confirm an older pending
   approval fails.
4. Verify token expiry, refresh rotation and concurrent requests retain both
   account authorizations. Remove or revoke one account and confirm it fails
   closed while the other remains usable.
5. Verify a real video through upload, processing and final attachment. Verify
   a quote only when the company application has Enterprise API access.

PR/CI/release receipts belong in the conversation and PR. The registration
Page records current prerequisites and the PR number. Unit tests or a generic
successful OAuth redirect do not establish that both accounts are connected.
