# WeCom company suite

Status: website installation, scoped member Check/send, notification callbacks and
authorization retirement are implemented. Company registration, actual credential
injection and native acceptance remain unverified. The existing outbound-only
per-Space group robot remains an explicit independent connection mode.

## Registration callback

`GET /api/connectors/wecom/suite` verifies the native encrypted URL challenge.
`POST` accepts authenticated `suite_ticket` pushes. The shared Hub endpoint has
no caller-selected Space. It authenticates the SHA-1 signature over sorted
callback token, timestamp, nonce and ciphertext, decrypts AES-256-CBC with the
provider's 32-byte PKCS#7 padding, and checks the encrypted receiver and inner
`SuiteId` against the configured suite. Duplicate query parameters, invalid
UTF-8, oversized bodies, ambiguous XML and stale timestamps fail closed.
The XML reader supports only bounded flat fields and CDATA, without DTD,
external or numeric entities, nesting or attributes.

The primary PostgreSQL table `data.app_wecom_suite_tickets` stores the ticket in
a version-bound secret envelope. Updates are serialized per exact app identity
and monotonic in provider event time. Conflicting same-second tickets clear the
private envelope and remain unusable until a strictly newer push; arrival order
is not authority. Reads require a ticket younger than
30 minutes. Rotation of any suite credential changes the identity and prevents
reuse of old tickets. The shared ticket repository also preserves the existing
Feishu encryption owner/ref format and its independent two-hour freshness bound.
Tickets are not Space credentials, installation grants, recipient evidence or
Agent capabilities. URL challenge responses make no database mutation; ticket
pushes return `success` only after the authoritative transaction commits.

Authenticated `change_auth` and `cancel_auth` callbacks close prior company grants
and pending prepared installations before acknowledgment. Both require a fresh
Human website installation; a visibility change never silently widens recipients.
`create_auth` still returns 503: Marketplace installation is a separate contract.

Sources: [callback protocol](https://developer.work.weixin.qq.com/document/path/91116),
[suite ticket](https://developer.work.weixin.qq.com/document/path/90628),
[Tencent callback library](https://github.com/sbzhu/weworkapi_python/tree/master/callback_python3).

## Human website installation

A Human Space admin starts from Apps → WeCom, choosing test or formal application
mode. A random 256-bit hexadecimal state is stored only as a digest and expires
in ten minutes. It binds the original Human, Space, connection/credential versions,
connection generation and exact suite identity. Starting again preserves the old
connection until the final confirmation. The native fixed website install URL
returns `auth_code` to `/connect/wecom`; only the original current Space admin may
spend the state, and state is spent before the one-use provider HTTP exchange.
An ambiguous exchange must start a fresh authorization; no automatic replay.

The current `service/v2/get_permanent_code` response does not contain agent scope
evidence. The Hub separately verifies `service/v2/get_auth_info`. This initial
contract supports one direct modern application in administrator authorization
mode, basic contact reads and explicit `privilege.allow_user` members. Shared,
customized and member-authorized applications fail closed. Department/tag-only
visibility is not expanded into implicit recipient grants.

The callback removes query parameters immediately and keeps its code only in
page memory, outside login redirects and query caches. The Human explicitly
confirms the original company, application, Space and one to twenty selected
members. Live provider checks precede the final primary CAS; encrypted private
permanent authorization replaces manual credentials only at that commit.
Agent code receives a typed send capability and opaque hashed recipient refs,
not codes, tokens, native profiles or arbitrary company/member selectors.

Migration 0151 adds primary encrypted installation attempts and grants, a
company lifecycle barrier and a private suite-token lease/cache. Attempt encryption
binds state, actor, app and connection snapshot; installed encryption binds exact
company, app, connection generation and version. Concurrent callbacks cannot
restore stale grants. Signed retirement purges permanent codes and all matching
prepared attempts in the same bounded transaction (at most fifty each). Same-second
retirement wins; fresh reinstall never revives captured work. No company token
is persisted. Suite-token renewal uses a fifteen-second primary lease and actual
fresh pushed tickets; key rotation invalidates the cache identity.

Expired attempts are inaccessible immediately and deleted in bounded primary
cleanup or the existing scheduled PostgreSQL lifecycle maintenance. Lifecycle
barriers have a global 10,000-row ceiling and retire after eleven minutes only
without an older installed grant; install attempts expire after ten minutes.
Connections, attempt and grant facts block shard moves; connection/Space deletion
purges the private installation by foreign-key cascade. These facts are not
projections and cannot be restored through a cached connection label.

Sources: [website installation](https://developer.work.weixin.qq.com/document/path/90597),
[v2 permanent code](https://developer.work.weixin.qq.com/document/path/100776),
[v2 authorization info](https://developer.work.weixin.qq.com/document/path/100779),
[authorization callbacks](https://developer.work.weixin.qq.com/document/path/100964).

## Scoped work and operational prerequisites

Use only provider-verified opaque company, agent and member ids. Company app
messages are addressed to explicit visible members; they are not the current
group-robot webhook flow. A Space must grant exact recipients, and Channel policy
must be checked again immediately before dispatch. A native app must not inherit
manual webhook authority or broadcast to `@all`, departments or tags by default.
A Check reads live application/scope and recipient evidence without sending a
message. Native message receipts must reject nonempty `invaliduser`,
`invalidparty`, `invalidtag` or `unlicenseduser`; a successful HTTP response alone
does not prove delivery. Text is bounded to 2048 UTF-8 bytes before dispatch.
Do not retry an ambiguous write automatically.

`GET /api/connectors/wecom/events` verifies the same suite challenge. Configure
both instruction and data callback settings with the same actual token/AES pair;
no second key pair is inferred. Signed text callbacks verify outer SuiteId,
inner company/agent/member identity, ten-minute freshness and message creation
time strictly after confirmation. At most fifty company installations and thirty-two
Channel routes per installation are accepted. Only notification identity is
published: native Content, member profiles, CorpID and permanent codes never
enter Channel bodies or Automation event payloads. Unsupported business message
types are acknowledged without effects. Message IDs provide deterministic Channel
and Automation deduplication. Delivery failure is not acknowledged as success;
the handler stops starting new work after its four-second effect budget. There is
no durable business-event queue and no claim of guaranteed callback delivery;
native callbacks are best effort and slow primary operations may exceed the
provider's five-second budget. Native testing must establish actual latency.

Suite token renewal requires the latest pushed ticket and validation of the
API caller's source IP. Production egress must be proven acceptable in the actual
service-provider configuration; neither a sampled Worker address nor an inbound
DNS address proves stable authorized egress. Keep this prerequisite unverified
until tested. Do not broaden provider allowlists or add an external credential
proxy as a compatibility fallback.

Member interface licenses also affect app delivery. The official test-company
flow uses zero-price test orders and has its own activation/expiration rules;
paid plans, paid orders and automatic purchases require separate authorization.
No license or trusted-IP configuration has been created by this implementation.

Sources: [suite token](https://developer.work.weixin.qq.com/document/path/90600),
[permissions](https://developer.work.weixin.qq.com/document/path/99052),
[application messages](https://developer.work.weixin.qq.com/document/path/90372),
[interface licenses](https://developer.work.weixin.qq.com/document/path/95652).

## Native acceptance remains mandatory

Verify company registration and saved callback configuration, native URL
challenge, real ticket push, Human installation and live Check separately.
Prove a selected member produces a real notification in the bound Space and
receive one policy-authorized Agent message. Exercise an unselected member,
other Space, invalid license, changed scope, uninstall, stale callback and
reinstallation. Confirm cancellation removes private authorization material and
that replay cannot restore the old grant. Inspect native UI and delivery receipts.
Local crypto/SQL fixtures prove boundaries; they do not satisfy this acceptance.
