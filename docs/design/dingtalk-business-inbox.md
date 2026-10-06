# DingTalk business messages and durable inbox

Status: checked 2026-10-05 UTC. Dormant primary storage, bounded drain and strictly
colocated actual-effect integration are implemented. No native message ingress,
subscription feature, cross-shard effect authority or native acceptance is implemented.
The released [company application](dingtalk-company-suite.md) remains gated by
actual suite-ticket/SyncHTTP configuration. Its selected-member grants authorize
contact reads and approved-template notifications; they do not establish consent
to forward native conversations into Channels or Automations.

## Dormant primary implementation

Migration0156 adds independent inbound attempts/scopes and receipts/jobs. Only
the original Human of a current company grant may start inbound consent. Its
encrypted selection, one-use state and confirmation bind parent generation,
membership birth/version, connection birth and exact signed visibility version.
State is spent before a mandatory server-owned conversation verifier; there is
no default verifier, unsigned proof flag, public route or caller-supplied verifier.
The capability has a ten-second deadline and must prove current native company/app
administrator, selected member and exact conversation. Missing real evidence
still prevents constructing a production verifier. Confirmation rechecks primary
authority, cannot widen the selection and creates a new inbound generation.

The inbox accepts only a narrow internal candidate from a future authenticated
adapter. Claim returns opaque handles, not private content. Current primary parent
and inbound scope checks precede decryption. Ciphertext AAD binds the original
Human, company/app/connection, both generations, scope, payload/content digests and
expiry. Receipts contain only digests; each selected target gets encrypted private
work. Equal replay creates no jobs; conflicting content cannot replace a receipt.
Reinstall does not adopt accepted messages. Local quotas and bounded cleanup use
an app advisory lock; company retirement and acceptance share the company lock.
Before begin/accept, cleanup commits in a separate transaction, so its FK child
locks never survive into a company-lock wait. Effect/current reads take the company
lock before parent or consent rows. Receipt cleanup precedes job cleanup to match
the current-source receipt/job order. Retirement takes terminal precedence over
retry exhaustion when both cleanup causes apply.

There are at most eight active 30-second leases per app, five attempts, durable
backoff and fenced completion. Terminal work erases its private payload, including
obsolete source grants. A bounded transport-neutral drain checks source authority,
requires native verification and passes a current-source fence plus AbortSignal
to separate append/Automation capabilities. Stable event/source IDs survive
partial effects; a twenty-second attempt budget suppresses effects after delayed
verification. Contract tests use explicit test sinks; they are not native or
actual product delivery receipts.
Every asynchronous current check rechecks cancellation after its database await;
late native/current/effect responses cannot reopen an aborted fence. The actual
effect owner must enforce cancellation and current authority at its final write
boundary; a deadline alone does not terminate an underlying provider operation.

No native verifier, production effect dispatcher, wake, cron, configuration value,
route or feature advertisement is registered. The explicit dormant Hub adapter
requires a native verifier supplied by trusted server code; it has no default
verifier or generic-ingress fallback. It uses bounded primary destination discovery
and the actual Channel append/Automation owners described below.
Existing0155/native/release receipts remain unchanged. Inbound attempts/scopes are
Space movement blockers; App-owned receipt/jobs remain global primary facts.

## Colocated effect authority

An opaque server-owned capability binds the app, connection, parent/inbound
generation, source job/lease, original Human, exact target and cancellation signal.
JSON command metadata cannot construct or copy it. Its stable effect ID hashes
the complete app, connection, inbound generation, event, effect kind and target
kind/ID; neither truncation nor destination-version changes alias different effects.
Candidate discovery returns labels, not grants. The actual owner rechecks current
source authority before interpreting target facts or historical success.

The initial implementation requires source and effect owner in the same physical
database with active, unmoving Space placement. Inside that owner's transaction it
takes the source company lock before source rows, then member locks before the
Channel lifecycle lock. Fresh statements after those waits read current role and
ACL. The original inbound Human and target relation creator/Automation authority
root and owner are independent principals: each must retain current target access.
App relation mutation follows Channel-before-relation order. The owner checks
relation birth/version/features/connection/source or locked Automation
birth/version/owner/root/enabled/page association/triggers before any effect/replay.
An Automation event is derived from current decrypted source content, not a
caller-supplied summary. App messages use the existing canonical Hub codec and
connector author rather than impersonating the native staff member.

Source and target locks remain held until the actual effect COMMIT. Retirement
committing first refuses the effect; an effect holding the locks first may commit
before a waiting retirement finishes. Source lease, payload expiry and abort are
checked again after writes and before each replay early return. Pre-COMMIT
cancellation rolls back that transaction. Once COMMIT was sent, a lost response
or later abort does not prove rollback: recovery reuses the same stable identity,
rechecks current source/target authority and reads the owner's committed replay.
It never claims to undo an already committed message or trigger.

This is deliberately not a distributed atomic authorization claim. A physical
shard mismatch refuses the effect; a remote current callback cannot bridge the
check-to-commit window. Cross-primary/shard delivery is still unfinished and must
have its own explicit owning-boundary protocol and tests before activation. Native
mode-specific proof, ingress, wake and UI remain unavailable independently of this
colocated implementation. Real-PG codec/readback/recovery tests use implementation
fixtures and do not establish provider identity or native delivery acceptance.

The proposed [cross-database coordination contract](dingtalk-cross-database-effects.md)
defines separate source/target participants, an irreversible primary decision,
target-before-source commit resolution and recovery/retirement interleavings.
It is not implemented; prepared-transaction support and the production recovery
owner remain unverified, so physical shard mismatch continues to fail closed.

## Provider contract and unresolved mode

Official [application robot reception](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/)
distinguishes HTTP and Stream reception. Direct messages and group mentions are
robot messages. Suite SyncHTTP authorization, visibility and contact records
are a different event family. A contact change cannot be normalized as chat.
The company's actual application/robot capability and reception mode are unknown.
Stream remains separate from the current HTTP server implementation.

The current official [third-party HTTP reception](https://open.dingtalk.com/document/isvapp/receive-message-3)
and [development reception](https://open.dingtalk.com/document/development/receive-message)
describe `timestamp` and `sign` headers. The documented signature is
`Base64(HMAC-SHA256(appSecret, timestamp + "\n" + appSecret))`. It authenticates
the timestamp with the robot secret, **not the message body**. The documented
maximum timestamp difference is one hour. Do not reuse the suite callback token,
AES key or ciphertext signature verifier for this protocol.

HTTP fields include `msgId`, `createAt`, `conversationId`, `conversationType`,
`chatbotUserId`, `senderStaffId`, `senderCorpId`, `chatbotCorpId`, and text content.
Company fields and staff identity are optional; `senderStaffId` requires the
published robot. Missing identity cannot be repaired with `senderId`, a nickname,
`isAdmin`, mentions or application `adminList`. HTTP signature verification is
not evidence that any of those fields are independently body-signed. Stream
provenance must be specified separately from its authenticated connection and
callback envelope; HTTP headers do not validate a Stream frame.

Before implementing a live adapter, the existing Laptop/company owner must
establish these public facts without sharing credentials:

1. The same third-party application has an enabled, published robot; its exact
   reception mode and the current official contract applicable to that mode.
2. The robot/application identity and company identity used by an actual message,
   including whether an internal staff ID and both company fields are available.
3. The native means to verify and select one conversation in that company and
   bind it to this application. A callback-provided conversation ID is not proof
   for a new authorization. If no such means exists, that scenario stays closed.
4. Actual callback deadline, acknowledgement format and redelivery behavior.
   SyncHTTP's encrypted acknowledgement and timing cannot be copied to robots.

For HTTP, document the trust assumption of secret-authenticated requests over
HTTPS and the lack of cryptographic body binding. Never describe body mutation
as a signature failure. A receipt hash can reject a conflicting redelivery after
the first commit; it cannot prove that the first body was authentic. If the
required source assurance cannot be established for the actual mode, leave its
adapter unavailable rather than silently weakening the boundary.

## First business-message scope

The first proposed feature is `message.received`: bounded plain text from one
explicitly selected internal company member in one explicitly selected native
conversation. Both direct and group scenarios require separate evidence and
explicit consent; implementing one does not enable the other. Group input also
requires the native robot mention condition. External groups, media, cards,
download codes and automatic conversation discovery are outside this contract.

Extend original-Human consent with the inbound purpose and verified conversation
selection. Bind that consent to the existing company/app/member selection plus
robot identity, conversation identity/type and a new inbound grant generation.
Store private native identifiers encrypted on the primary. Do not expand an old
read/send grant, infer consent from subscription creation, or auto-bind the
first message. Native publisher/administrator proof and the complete signed
visible-member snapshot remain required.

The mode-specific adapter produces a narrow internal candidate:

| Field | Meaning and boundary |
| --- | --- |
| App identity and mode | Deployment-selected application and verifier; never body-selected credentials |
| Company and member IDs | Exact native identifiers; compared with current encrypted grants |
| Robot and conversation IDs/type | Exact identifiers matched to the separate confirmed inbound scope |
| Provider message ID and creation time | Stable provider identity and validated timestamp; never a local retry ID |
| Text | Plain untrusted content with an explicit size limit; no executable commands or embedded authority |
| Provenance | Exact verifier/transport used, including its authentication limits |

This is not a public API. It contains no caller-selected Space, Channel, Human,
connection, generation or destination URL. Normalization alone grants no access.
Resolve all destinations from primary current consent. Opaque source references
must include the inbound generation and conversation scope without exposing raw
company/member identifiers. Subscription features and Automation triggers remain
unadvertised until the adapter, consent and delivery path are implemented.

## Primary durable receipt and delivery

Independent storage work can follow the established Sentry primary inbox pattern
once the internal candidate and scope contracts are fixed. It must satisfy:

- A bounded transaction rechecks current company, original Human membership,
  connection birth, app identity, signed visibility, selected member and inbound
  conversation generation before persisting a job. Queue pressure fails closed.
  A provider success response means the receipt committed, not that delivery ran.
- Encrypt only the minimal normalized text and private routing identifiers. AAD
  binds the app/company/connection, inbound generation, provider event digest,
  payload version and expiry. No raw request, native token, signing secret,
  `sessionWebhook`, download code or user profile enters messages or diagnostics.
- Use a digest of exact app/robot/company/conversation/provider message identity
  as the receipt key; keep a separate canonical content digest. An identical
  redelivery is idempotent. A conflicting body for an existing identity is denied
  and cannot replace the committed job. Authentication remains mode-specific.
- Persist pending/leased/done/obsolete/retry states, finite retention, per-app and
  per-connection capacity, bounded claim batches, attempt ceilings and backoff.
  Lease tokens and expiry fence late completion and two competing drainers.
  A bounded scheduled recovery uses the same primary owner as post-commit wake.
- Resolve primary current grants again at claim and immediately before each
  Channel append and Automation effect. Revoke, member removal, visibility change,
  administrator demotion, secret rotation or reinstall makes old work obsolete;
  reinstall must not adopt its generation. Never deliver using a captured grant.
- Deliver through existing product Channel append and Automation authorities.
  Stable, bounded effect IDs distinguish connection, generation, message and
  destination. Retry after partial effects reuses those IDs; it does not create
  a second message or occurrence. Claim completion follows both durable effects.

Proposed initial limits are a 64 KiB request, 8 KiB UTF-8 text, 256 pending jobs
per connection, 10,000 per application, batches of eight, 30-second leases and
five attempts with 30-second exponential backoff capped at five minutes. Payload
expiry is 24 hours; retain only dedupe/conflict digests for seven days. Reject
reception older than the payload window before inserting a new identity; clean
expired payloads and receipts in bounded batches. These are local design limits,
not provider timing guarantees. Confirm them against the actual mode's retry
window before implementation. Quota checks and inserts must share a transaction
so concurrent arrivals cannot exceed the bound.

Live native administrator and selected-member checks occur outside database
transactions, followed by a primary generation recheck before effects. Any
changed proof, network failure or deadline leaves retry/obsolete work rather than
dispatching from stale results. Channel messages retain the connector app author;
they must not impersonate the native sender as an xMatrix Human or Agent.

`deliverEvent` currently has no DingTalk inbound binding. Calling it with only a
connection ID would omit this scope. Add a typed primary inbound-scope check at
route lookup and the last effect boundary before integrating it; do not copy or
bypass generic ingress. `currentConnectorAppend` provides a reusable last check
but is not a transaction spanning a remote append. An adapter must identify and
test the actual linearization boundary rather than claim atomic revocation from
a preflight alone. Automation dispatch similarly needs current authorization at
its owning effect boundary, not merely before enumerating candidates.

Existing SyncHTTP contact/lifecycle processing retires selected grants. An event
that caused retirement cannot use those retired grants to notify Channels or
Automations. A separate administrative audit subscription would require its own
explicit current authority; it is not implicitly part of this chat contract.

## Implementation order and acceptance

1. Fix the actual mode, provenance and native conversation proof from primary
   evidence and company facts. Preserve unavailable routes where facts are absent.
2. Implement encrypted primary inbound consent and scope, then the bounded inbox
   repository and drain against that scope. Allocate a migration from actual main;
   do not reserve a sequence with a placeholder or overwrite another task's work.
3. Integrate exactly that mode's verifier/parser, commit-before-ack ingress,
   recovery wake, typed route fences and idempotent Channel/Automation effects.
4. Add the shared feature/source contract and Web consent/subscription controls
   only when the complete server path is usable. Keep template notification send,
   robot reply and group webhook actions distinct.

Fresh real PostgreSQL verification must cover receipt conflicts, capacity rollback,
concurrent claims, crash after partial effects, expired leases, retry exhaustion,
expiry cleanup and revoke/reinstall races. Route tests must reject cross-company,
wrong robot/conversation, missing staff identity, unselected member, changed
membership/visibility/generation, duplicate JSON keys and changed replay content.
HTTP tests must demonstrate that changed body bytes do not change the documented
header signature; they must not claim otherwise. Stream requires its own tests.

Exact required CI plus aggregate, the official release path, actual production
schema/runtime/component receipts and actual native acceptance remain separate
gates. The native minimum is one real selected-member message committing once to
the selected Channel and Automation, identical replay creating no extra effects,
and revoked/unselected/cross-company input producing none. Neither a queue insert
nor notification `task_id` proves a delivered message. Official
[reply methods](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)
include temporary session webhooks and OpenAPI; replying is separate work and must
not persist or fetch an arbitrary callback URL.
