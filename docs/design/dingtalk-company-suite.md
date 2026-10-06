# DingTalk company application

The target is the company's third-party enterprise application. Internal apps,
group webhooks, native robot messages, Stream and Marketplace publication are
separate modes. Registration callback support alone is not a company install.

## Explicit protocol selection

Official developerpedia documents both suite-ticket
`/v1.0/oauth2/corpAccessToken` (camelCase request/response, latest suiteTicket)
and `/v1.0/oauth2/{corpId}/token` (client_credentials, snake_case, no ticket).
ClientId labels cannot select between them. This implementation supports only
an explicitly configured suite-ticket application with SyncHTTP; it has no
fallback, WeCom permanent-code exchange or company proof parser.

`CONNECTOR_DINGTALK_COMPANY_CONFIG` is deployment-owned JSON with exactly:
`protocol` = `suite-ticket`, `delivery` = `sync-http`, numeric-string `suiteId`,
`developerCorpId`, positive integer `appId`, approved `templateId` and its
`templateField`. These values require actual company-console evidence. The four
native suite key/secret/callback-token/AES-key settings must also be complete.
Absent metadata leaves company installation, Check and actions unavailable;
registration-only configuration never activates company authorization.
Deployment rejects incomplete, duplicate or noncanonical JSON before emitting
its secret payload. Fixtures must not populate a real registration.

As checked on 2026-10-04 UTC, the current authorized-company token reference
lists third-party enterprise support. Newer developerpedia says old documentation
will gradually go offline, without a dated API shutdown. No product/sign-up
retirement date was established. The actual company-console mode remains
unverified, so production metadata stays unset. Company registration, login,
contacts, support and test identities use `hello@xmatrix.sh`; attribution is
`Made by Robot`.

## Registration and signed SyncHTTP receipts

`POST /api/connectors/dingtalk/suite` is the flat encrypted registration
handler. It verifies SHA-1 over token, timestamp, nonce and ciphertext before
AES-256-CBC decryption; validates padding, UTF-8, receiver and bounded flat JSON;
and rejects duplicate/escaped keys, conflicting query aliases and unsafe numbers.
It answers supported native challenges and persists suite_ticket pushes before
returning encrypted success. Unsupported flat authorization/business events
receive 503. A ticket authenticates the app; it grants no Space or company access.

`POST /api/connectors/dingtalk/events` is the separate configured SyncHTTP
handler. The business URL also answers native registration challenges through
the same authenticated receiver validation, without persisting any company grant.
The authenticated ciphertext contains a bounded structured wrapper
and JSON-string business records. Exact numeric `suiteId_0`, company and app
binding is checked before any primary write. Supported receipts are:

- High-priority biz2 suite tickets, bound to the developer company and suite ID.
- High-priority biz7 complete `org_micro_app_scope_update` snapshots. Explicit
  user and department scopes are JSON-encoded strings; missing scope is rejected.
- High-priority biz4 authorization/change/relieve and biz7 stop/restore/remove,
  which retire captured company consent. Restore never revives an old grant.
- Medium-priority biz13 member changes/removal, which conservatively retire the
  company's selected grants and pending attempts. Contact records cannot create
  visibility or authorize department expansion.

All typed receipts commit to primary PostgreSQL before encrypted success.
Receipt transactions use bounded connection/statement/transaction/lock limits;
a 900ms processing budget stops a batch between writes and refuses success when
exceeded. Partial batches return 503 and retry through idempotent version/fence
logic. There is no acknowledged in-memory background queue. Unknown business
records fail closed. A durable asynchronous inbox, general contact/company event
routing to Channels/Automations, and Stream/native robot message handling remain
separate work; this change does not advertise received-chat-message features.

The follow-up [business-message and durable inbox contract](dingtalk-business-inbox.md)
records the mode, inbound consent, provenance and current-generation delivery
boundaries. Dormant primary inbound grant/inbox storage, bounded drain and strictly
colocated actual append/Automation owner integration are implemented separately.
Actual native verification, registered ingress/dispatch and cross-shard effect
authority remain unavailable; this is not an implemented native message route.

Freshness is ten minutes before and thirty seconds after server time. Equal-time
conflicts erase ambiguous tickets/scope; stale or duplicate records cannot
restore authority. Provider sequence strings are opaque, never ordered by an
invented numeric or lexical rule. Retirement adds a conservative one-second
fence, closes pending consent and clears older private grants/visibility.

## Human consent and current grants

A current Human Space admin starts with one company ID and 1–20 explicit,
case-sensitive member IDs. The one-use state expires in ten minutes and is stored
only as a digest. Primary attempts bind the original Human membership birth,
Space, app/company, exact member selection, connection birth/version and
credential version. State is spent before private provider operations. A primary
signed full visible snapshot must include every selected member before contact
reads; authorizing admins, contact scopes and root departments are not visibility.

The fixed native management login URL (`login.dingtalk.com/oauth2/auth`) binds
SuiteKey, the selected corpId, registered `/connect/dingtalk` callback, unpredictable
state and `openid corpid` scope. Its `org_type=management` UI filter is not proof.
This connects an already activated company application; it does not activate a
new provider application. Native activation/distribution and administrator
permission consent remain console prerequisites. The older adminConsent flow
also requires an already activated application (official error70003), and its
unsigned success flag cannot prove this Human's administrator identity.

The Web form removes query data, accepts only exact `authCode` and state, rejects
provider errors/duplicates/old success flags, and waits for the original xMatrix
Human. No later member picker can widen the original selection. Session changes
abort pending work. The server spends original primary state before any outbound
code exchange, checks the primary full visible snapshot and SDK app mapping, then
exchanges the confidential user code with SuiteKey/SuiteSecret at
`/v1.0/oauth2/userAccessToken`. Returned corpId must exactly match the selected
company. The personal token reads only the caller's unionId via `/contact/users/me`;
the company token maps that identity to an internal company userid. Fresh company
`/topapi/user/listadmin` and separate app `adminAccess.result === true` prove
current administrator authority before selected contact reads. Neither historical
authUserInfo nor app adminList identifies the current Human or visible members.

Personal access/refresh tokens and unionId remain ephemeral. Only the verified
native administrator userid enters the encrypted grant bound to the original
Human. Final explicit confirmation repeats current primary and provider checks,
then atomically consumes the attempt and replaces the Space's company grant and
saved robot credentials. The confirmation response excludes the native admin
userid. Unsigned redirect parameters never serve as a provider grant.

Grants are encrypted with AAD binding their Human/Space/app/company/connection,
consent phase, membership and grant generations, plus signed visibility version.
Each effect resolves primary current rights and live native company/app administrator permissions again. Check repeats native administrator evidence after member reads, before any confirmation or write. Demotion/removal/readdition,
connection replacement, credential edits, visibility changes or lifecycle
retirement prevent captured effects. Recipient hashes bind Space, connection,
company, app, original Human and grant generation; they cannot be moved to another
Space or replayed after reinstall. Primary fan-out and maintenance are bounded.

## Check, reads, notifications and token refresh

The SDK adapter uses suiteAccessToken/corpAccessToken and suite-token authInfo.
authCorpInfo does not declare corpId; the server-bound requested company is used.
agentList maps appId to agentId; adminList is not member visibility. Contact scopes
must explicitly include selected users and userid/name fields. Typed reads expose
only memberId/name/active, never other contact metadata.

The primary encrypted token cache isolates app identity, company and token type.
It uses provider-confirmed expireIn with a 30-second margin, and binds the latest
primary ticket version, token generation and expiry in AAD. A bounded 15-second
refresh lease admits one caller, rejects contention without automatic retries,
and rejects expired leases or late writes after ticket rotation. The cache does
not invent a suite-ticket lifetime from the approximate five-hour push cadence.
App-level cache rows stay on the primary and are excluded from Space shard moves.

Check, `@dingtalk:read:<member-recipient>` and
`@dingtalk:send:<member-recipient> <text>` verify current company/app/active members.
Read and send repeat current Channel access and action policy throughout provider
work. Agents require explicit write allow; current deny blocks all callers.
Notifications use only the approved configured template and one explicit user.
No broad department/all-user send, arbitrary free-text substitute or automatic
retry is used. A returned task ID means asynchronous acceptance, not delivery.

A shared 45-second deadline covers current authority, credentials, token refresh,
contact reads and submission. Provider calls receive a 12-second limit (the common
HTTP helper further caps at ten seconds); expired operations suppress late calls.
The existing manual robot action remains independent and outbound-only.

## Remaining real prerequisites and acceptance

The company administrator has not established console evidence for actual
application/auth mode, selected SyncHTTP subscription, numeric suite identity,
current signed initial visible scope, or approved template/parameters. No
supported third-party visible-scope query or guaranteed initial full snapshot was
established from primary evidence. Until a real complete snapshot exists, even
successful authInfo cannot make the installation usable. The four canonical
registration fields remain empty as of this implementation's evidence review.

Fixtures, isolated PostgreSQL, Hono and browser tests are implementation evidence;
they do not prove native authorization, installation, provider permission,
notification delivery, signed live receipt/replay/removal, or production release. The actual login callback and Contact.User.Read/qyapi_get_member permission consent are also unverified.
Required exact CI and aggregate must pass before merge, followed by the official
Production Release Intent and independent immutable tag/production PG/component
receipts. Real native acceptance remains separately recorded by the existing
Laptop/company owner; do not repeat their registration or browser work.

## Primary references

- [Company administrator consent and suite-ticket token](https://open-dingtalk.github.io/developerpedia/docs/develop/permission/token/browser/get_app_only_token_browser/)
- [New company token protocol/documentation transition](https://open-dingtalk.github.io/developerpedia/docs/develop/permission/single_to_multi/new_get_app_token/)
- [SDK 2.2.48](https://www.npmjs.com/package/@alicloud/dingtalk/v/2.2.48)
- [Official callback crypto SDK](https://github.com/open-dingtalk/DingTalk-Callback-Crypto)
- [Current authorized-company token](https://open.dingtalk.com/document/isvapp/obtain-the-access_token-of-the-authorized-enterprise)
- [Full visible-scope change](https://open.dingtalk.com/document/development/enterprise-micro-application-visible-range-change)
- [SyncHTTP configuration](https://open.dingtalk.com/document/isvapp/configure-synchttp-push)
- [Suite/application authorization business records](https://open.dingtalk.com/document/development/authorization-event-1)
- [Contact events](https://open.dingtalk.com/document/development/address-book-events)
- [Approved-template notification](https://open.dingtalk.com/document/development/work-notification-templating-send-notification-interface)

- [Suite user login and exact authCode callback](https://open.dingtalk.com/document/isvapp/obtain-identity-credentials)
- [Confidential user token with selected corpId](https://open.dingtalk.com/document/isvapp/obtain-user-token)
- [Own personal identity](https://open.dingtalk.com/document/development/dingtalk-retrieve-user-information)
- [Company userid mapping](https://open.dingtalk.com/document/development/query-a-user-by-the-union-id)
- [Current company administrators](https://open.dingtalk.com/document/development/query-the-administrator-list)
- [Current app management permission](https://open.dingtalk.com/document/development/check-whether-the-administrator-has-application-management-permissions)
