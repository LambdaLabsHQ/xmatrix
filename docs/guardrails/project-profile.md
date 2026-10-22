# Project Profile

This file is a descriptive snapshot, not policy. The only canonical project rules are the ten P0/P1/P2 guardrails in `project-guardrails.md`; statements here and in the linked snapshots document the current implementation and cannot add or override a guardrail.

## Overview

This repository implements xMatrix, the multi-agent coordination/runtime layer. xMatrix is a multi-agent coordination system for AI coding agents and humans. It connects agents such as Codex, Claude Code, Kimi, Cursor, Aider, and Windsurf through shared channels backed by a relay hub. The same repository ships the Web dashboard, Cloudflare Hub, Rust CLI/daemon, protocol package, native shells, release automation, and deployment scripts.

Agents run on the subscriptions and credentials their users supply; Space
billing is independent of compute.

## Default Documentation Language

English is the default language for repository documentation, guardrails, release docs, and tool instructions. Chinese may be used for existing Chinese design notes or when maintainers explicitly ask for Chinese output.

## Release notes

Release notes are published with each successful train and readable at
`/releases/<version>` through Desktop, Machine versions, CLI updates and downloads.
The stable release Agent authors a versioned document in the verified beta's
source; intent and train refuse missing or mismatched stable notes. Betas use
their exact tag's generated change list. iOS stable submissions also populate
App Store What's New. See [release notes](../release-updates.md#release-notes).

## Current behavior

GitHub repository subscriptions include `code-scanning`: signed alert lifecycle
events reach a subscribed private-content Channel and wake its resting Agent,
without periodic polling. The exact installation's effective Code scanning alerts
read grant is checked on subscription and again before every delivery; see
[App connectors](../operations/app-connectors.md).

Page discussions and conversations started from selected message passages use
the ordinary first-message automatic summon and author choice window. Passage
discussions are named after the first message's text rather than its quote;
section discussions keep the section name. See [automatic invocation](../architecture/auto-launch-completion.md#a-new-conversations-first-message).

Human Space owners/admins can confirm Channel deletion in its actions or
details. Active work prompts a second confirmation to stop the Channel's
Agents, then automatically retries deletion after daemon termination. Retirement
revokes access immediately; a durable job erases the exact
Channel closure in bounded, retryable passes that checkpoint a plan-bound cursor
before the transaction deadline, while keeping linked Pages and
other Channels. Account deletion remains separately available in Settings.
See [Channel deletion](../operations/channel-deletion.md) and
[account deletion](../operations/account-deletion.md) for recovery and retained-data limits.

Exact-tag expand migrations can build non-unique indexes concurrently while
ordinary production writes continue. Durable, checksum-bound reservations own
interrupted builds; the existing migration ledger records completion after
index verification. See [online index migrations](../operations/postgres-online-index-migrations.md).

Connector action receipts resume only the exact authenticated calling Instance,
queueing behind an active turn; subscribed App events reach existing Channel
Instances and resume sleeping/interrupted ones through the bounded wake
boundary. Stopped Instances remain stopped. See
[Connector delivery](../design/connector-platform.md).

Gmail notifications default to minute INBOX count polling with a separate
15-minute Composio incremental-ID check. Our Google grant uses labels plus
basic mailbox identity, while existing Composio content access stays separate.
Owned mailboxes listen independently; changes to another mailbox preserve an
unchanged notification grant while atomically advancing its credential fence.
Optional native watch configuration remains independent. See
[Gmail notifications](../operations/gmail-notifications.md).

The login page supports GitHub, Google and email. GitHub sign-in reuses the
existing linked Human identity and GitHub App OAuth credentials, independently
of Space connector installations. See [OAuth recovery](../operations/oauth-callback-recovery.md).

Automation message occurrences link to actual persisted Runs through their exact
canonical message and registration launches, including multiple Runs per message.
Unused reservations and unstarted launches do not count; missing historical
evidence stays unknown. See [Automation Run links](../operations/automation-run-links.md).

Pages type committed Agent edits in as people type: the structure goes in
first, then the words as small CRDT insertions, a few at a time. Several Agents
and people type at once, and every moment of the page reads back from Markdown
as itself. Stored typing lets a restarted session finish a committed edit while
keeping human typing. Choosing a page co-writer immediately acknowledges the
selection; desktop feedback offers its conversation and explains to continue
writing in the page. See [live documents](../design/pages-live-document.md).

Live co-writing records bounded, content-free diagnostics for first CRDT text
and turn outcomes, including quiet-turn timeouts. Hub clock timings distinguish
pending edits, runtime deltas and actual text changes; they do not measure browser
paint. See [co-writing measurements](../architecture/first-space.md#measuring-live-co-writing).
New human input can refresh a page answer that has not written text after four
seconds, once consecutively. A replacement gets to finish, and ongoing text is
not interrupted by this refresh. Full instructions travel again so queued
requests can be retired safely.


Channel presence uses the protocol's read-only Instance-ID map, separate from
Human devices. One reducer owns identity checks, lifecycle merges and removal;
messages and live reports cannot create residents. Required registrations
supply harness avatars. Legacy wire shapes are normalized at the boundary.
See [Agent status](../design/agent-status.md#instance-identity-in-presence).

Human message sender snapshots read the current account name and avatar, as the
Space catalog does, while Space membership still authorizes the append. This
includes Automation occurrences, which have no client-supplied sender snapshot;
renaming an account affects new messages and preserves historical authors.
Session exchange creates credentials for the existing account without replacing
its saved name or avatar with a retained token's older profile fields.

Official Agent launch prompts are compact repository Markdown delivered by the
Hub with each spawn. Supporting daemons validate and render the versioned text;
legacy daemons keep their compiled copy. Command details come from CLI help,
with connected app names retained at launch and usage read on demand. Full
Channel contracts are launch-only; Codex installs its compact native reply
reminder and trusted registration instructions at thread start and resume.
Grok's trusted rules exclude Channel history and task bodies. See
[Agent prompts](../../packages/cli-rs/crates/core/prompts/README.md).

Operator-paid calls are metered per Space: each Jev call (by feature, with its
reported tokens) and each Composio and X call (by connector, action and
operation) is one Analytics Engine datapoint of ids, enums and numbers, written
without awaiting and off when the binding is absent. See
[usage cost metering](../operations/usage-cost-metering.md).

OAuth callbacks whose state cannot recover a per-flow error URL return to the
deployment's login page. Error redirects are failed callback metrics, and Google
session creation requires an issued session cookie. See
[OAuth callback recovery](../operations/oauth-callback-recovery.md).
The signed OAuth state cookie shares the server state's ten-minute lifetime;
missing, mismatched, replayed and expired state still refuse the callback.

Connector OAuth checks current target-Space owner/admin authority both before
starting consent and before exchanging a retained signed state. The credential
write checks it again after the provider request; another Space's admin role
does not authorize the flow. See [connector platform](../design/connector-platform.md)
and [Space credential isolation](../operations/space-credential-isolation.md)
for historical secret copies and the local OS-user boundary.
The separate GitHub App callback also hands off to authenticated completion;
forwarded links cannot attach another person's installations, and earlier
installation-selection grants must be reauthorized under the new grant purpose.

Repository contributions use the Prompt request issue form: current behavior
and reproduction, the desired outcome, and acceptance checks are required;
implementation prompts and reference patches are optional. Maintainers triage
requests before their agents implement accepted changes through regular PRs
and CI, linking back to and crediting the request author. External fork PRs
are redirected to this form; maintainers and their agents use branches created
in the upstream repository by its branch workflow. See
[contributing](../../README.md#contributing-prompt-requests-not-pull-requests).

Machine placement uses bounded active HTTPS network measurements alongside
semantic fit, CPU/memory headroom and provider quota. Daemons measure latency,
jitter, request failures, loaded latency and adaptive download/upload goodput
against fixed Cloudflare Speed endpoints; ICMP probe loss to 1.1.1.1 stays a
separate direct-path diagnostic. The authenticated live daemon connection owns
the network fact in its existing machine resources. No model-call timing or
Agent token throughput influences placement. Unknown/expired measurements keep
the compatible fallback; no private URLs, proxy credentials or response headers
are reported. See [network measurement](../architecture/space-agent-routing.md#machine-network-measurement).

Parameter-control notices distinguish an unconfirmed local selection from the
provider's observed value. Codex turn-only Fast selections remain pending until
the provider confirms them; see [harness parameters](../architecture/harness-parameters.md).

Agent traces support host receive-order pages and live cursors across all trace
adapters. Stream positions preserve upstream order independently of wall clocks;
legacy hosts retain the timestamp compatibility path. See
[Agent trace visibility](../architecture/agent-trace-visibility.md).

Hub owns Codex model-capacity retry policy, persisted Run state, Channel-alarm
scheduling and visible outcomes. Hosts report terminal/execution observations
and execute the body of an exact Hub-written Channel retry message; private
retry input cannot start work and hosts have no autonomous capacity retry.
See [Codex capacity recovery](../operations/codex-capacity-retry.md).

Runtime delivery errors retain the sending cause chain and report the original
receiving exception before it crosses a Durable Object boundary. Reporting
preserves rejection and never replays a potentially partial broadcast. See
[Runtime delivery errors](../operations/runtime-delivery-errors.md).

Agent turn failures share one reconnect-safe lifecycle reporter across native,
ACP, stream and headless adapters. Channel notices retain credential-redacted
HTTP, upstream, WebSocket and process evidence when exposed, and explicitly mark
missing HTTP evidence. See [Agent turn failures](../operations/agent-turn-failures.md).
Daemon catch-up retires lost socket bindings and attempts to release all unsent
leases, preserving sent leases, successor connections and Authority epoch fences.
Orphan terminal reports recover exact identities only from a matching retained
registry sidecar. Once its receipt cleanup removes that sidecar, retained status
and log artifacts cannot replay the exit on reconnect. See
[daemon recovery](../daemon-service-model.md#invocation-progress-evidence).

Sentry issue reads retain bounded generated script locations alongside mapped
exception callers, plus issue occurrence totals and first/last-seen UTC times.
Generated locations exclude URL credentials, queries, fragments and inline code;
source context, locals and request data remain private. See
[connector operations](../operations/app-connectors.md).

Outside AI applications can read and write a person's Pages and Channels
through the remote OAuth MCP server, using the person's existing access.
Open client registration supports outside MCP apps; consent explicitly labels
their names as unverified, shows the return host, and blocks approval when
the app details or return address are unavailable.
The `show_page` tool supplies a sandboxed MCP Apps card and a source link;
text-only clients receive the same page data. The ChatGPT/Codex submission
package and remaining portal prerequisites live in `deploy/chatgpt-plugin`.
See [MCP server](../design/mcp-server.md).

Device pushes share a bounded outbound delivery profile across Web Push, APNs
and FCM, including OAuth refresh, response decoding and notification fan-out.
Delivery accounting and diagnostics share a finite outcome table; push logs
contain fixed reasons and device kinds, never raw exceptions or private inputs.
Registration lookup and retirement share one capacity; gone registrations are
deleted completely in bounded, atomic SQL chunks rather than silently truncated.
See [device push delivery](../operations/push-delivery.md).

The operational activation report reads registration cohorts across all currently
placed PostgreSQL shards and emits aggregate message, first-reply, Page and
second-week activity counts. External users require explicit classification;
unknown accounts stay separate from team/test accounts. See
[activation report](../operations/activation-report.md).

Ordinary Agent summons can start in a daemon-owned internal cwd before a new
user registers a local folder. The same registration admission and managed-cwd
capability fence applies as for other input launches. Explicit repository and
local-directory targets remain separately authorized; ordinary internal cwd
Runs carry no Space management projection. See
[Space agent routing](../architecture/space-agent-routing.md).

The public user guide includes a local-folder walkthrough for creating and
updating a first project wiki with Claude Code or Codex, linked from the homepage.
Its source is [the project wiki guide](../guide/project-wiki.md).

The Gmail connector preserves ordered inline mixed body segments, excludes
attachment subtrees, and marks incomplete MIME previews. Native availability
uses Composio's managed client with its approved full-mailbox grant; the Hub
limits calls to an endpoint list. `send`/`reply` ask for a Space admin's
approval of each email by default. Search/read post their results, including
mail content, to the calling Channel, where its members can read them;
execution history keeps a bounded excerpt. Every action starts as a visible
Channel command; the former connector MCP and caller-only result path are retired.
Gmail-to-Space-secret transfer is not implemented, so these reads cannot satisfy
a QA rule that login codes stay out of messages. The supported manual secret
card and process injection path is documented in
[connector operations](../operations/app-connectors.md#qa-login-codes).
Its Composio path is independent of runtime-provided Gmail plugins; see
[connector platform](../design/connector-platform.md).

The X connector holds independent company/personal OAuth grants in the
encrypted connector credential store. Each grant belongs to its connecting
member and their Agents; publishing requires an explicit stable account and
binds approvals to its authorization generation and exact content. Results
are visible in the calling Channel. Video transfers use durable alarm jobs
with PostgreSQL-owned encrypted inputs and outcomes, independent of HTTP/CLI
lifetimes. Native acceptance still requires the
company app configuration and separate tests with both real accounts; quote
posting requires Enterprise API access. See [X connector](../connectors/x.md).

The Google Cloud operations connector uses a separate GCP OAuth grant and
provides bounded resource, Cloud Run status, log, metric and alert-policy reads,
plus direct App Optimize gross-cost reports, billing/export discovery and
parameterized cost/credit analysis, public SKU attribution, bounded daily or credential/method API request counts, secret-free API key metadata and historical audit-principal summaries. Caller evidence distinguishes key IDs, key administrators and actual inference identities. Explicit quota project selection preserves Google IAM and the same OAuth grant. Temporary report creation and API enablement is a separate policy-controlled write; no IAM grants are changed.
Monitoring incident edges route by metrics-scope project through authenticated
per-connection ingress. See [GCP connector](../connectors/gcp.md).

The Web composer previews Jev's summon intent while typing, with mention bands
and a declined-mention explanation and Start anyway option at the address. Human-confirmed readings travel with the exact message;
launch authorization remains server-owned, and unread or unavailable previews
retain post-send checks. See [invocation status](../design/mention-invocation/README.md).

Windows Agent children enforce UTF-8 transport settings and use managed PowerShell
entrypoints that initialize console and pipeline encoding for each command.
Entrypoints are isolated by CLI executable digest so active commands do not
block Agent launches after upgrades. See
[Agent text encoding](../design/agent-text-encoding.md).

The component map is `docs/ARCHITECTURE.md`. The rest of this snapshot is split into the files below. They keep the previous text.

Automatic repository selection passes optional GitHub project descriptions
alongside repository names to Jev, bounded per choice. Names and current task
context remain semantic evidence; recent repository activity does not determine
relevance. Explicit repository constraints retain their existing launch path.
See [Space agent routing](../architecture/space-agent-routing.md).

- [Repository map](profile-repository-map.md)
- [Architecture boundaries](profile-architecture-boundaries.md)
- [Public interfaces and domain contracts](profile-public-interfaces.md)
- [Security-sensitive areas](profile-security.md)
- [SQL, clients, and local replicas](profile-clients.md)

Message syntax and execution selection use the [message interaction protocol](../design/message-interaction-protocol.md), with a shared TypeScript/Rust grammar and domain-owned authorization.

Cross-machine handoff stops the exact source Run and Instance even when it
has already exited, ending its rest before the successor can wake it with a
reply. The daemon exports the exact retained checkout or its eviction snapshot
without a live child registry row, preserving uncommitted work under the pool
guard. This requires the updated CLI; stale retained authority is refused.
Stop issuance failures refuse the handoff; a durable stop may still
await its daemon report. Carried conversations and legacy pointer snapshots
share a fresh, owner-only local bundle per attempt, using the existing private
journal writer; a failed materialization supplies no bundle. See
[instance handoff](../same-machine-instance-handoff.md#22-moving-to-another-machine).

Handoff stops execution while retaining the source Instance and provider session.
An explicit reborn may resume it while the successor runs in the same directory;
the product imposes no stop-first constraint. Shared repository-pool references
track each session's lifecycle and preserve every session through eviction and
rehydration. Only the final explicit abandon can reset the shared checkout.
See [handoff source reborn](../same-machine-instance-handoff.md#handoff-source-reborn-compatibility).

Machine startup failures preserve bounded, credential-redacted originating causes in
Channel notices and invocation details; Git retry classification does not replace stderr.
Machine startup failures remain visible as idempotent Channel notices even if
the Launch has already failed its Run. Public invocation details retain the originating
repository preparation error; subsequent stop cleanup
preserves the failed-startup outcome. See [invocation status](../design/mention-invocation/README.md).

Teams native integration uses a company home-tenant Bot, Human admin confirmation and primary PostgreSQL room grants, alongside explicit outbound-only manual webhooks. Its supported scope, canonical release configuration and evidence requirements are documented in [Teams native contract](../connectors/teams-native.md). Company identity and native acceptance remain external prerequisites.

New repository tasks confirm the remote default branch on every independent
launch, sharing only simultaneous checks. Invocation details retain actual
baseline evidence; continued tasks preserve their recorded checkout and warn
only on proven base divergence. Local shared Git objects are not purged by this
feature. See [repository preparation](../daemon-service-model.md#repository-snapshot-preparation).

A conversation's About is one text task: the Hub hands a fresh harness
execution that conversation's text alone and writes its answer as an immutable
metadata revision. See [Channel metadata revisions](../design/channel-metadata-revisions.md).
Its completion delivers catalog changes directly within the publishing Runtime
and routes notifications to other cells, without a self-RPC on the daemon frame.

Agent cards show the repository admitted for their Run instead of a managed
checkout path. The optional Instance `repository` display field comes from
Run metadata and survives live presence updates and sleep; directory launches
and older Hubs retain the registered-workspace/path fallback.

### Search Console ownership and management

The Search Console connector covers the Search Console and Site Verification API
methods through typed actions. New OAuth grants request webmasters plus
siteverification; existing webmasters grants remain usable and refreshable,
while verification requires a new consent. Verification records are public,
separate from OAuth credentials, and are published through the site's own DNS or
website workflow. Advanced analytics supports validated JSON, Pacific calendar
dates, filters, explicit offsets and fresh/hourly data within bounded calls.
See [app connectors](../operations/app-connectors.md) for onboarding and policy.

Platform admin user lists show Last message and default to the latest retained
message sent by the user or their Agents, with the exact UTC timestamp on hover
and the same field in user details. Agent ownership comes from the stored
send-time sender snapshot; messages predating previews use their persisted Run
registration when available. Missing or erased ownership stays unattributed.
Last access remains a separate session metric; daemon presence does not advance
Last message. Existing message counts and daily user charts remain user-authored
message counts.

Platform admin user details show the Space connections each user added, with
retained and 30-day execution counts, status totals, standard webhook/event
Channel deliveries, last activity and subscriptions. Activity includes every
caller in that Space; delivery counts are per Channel and do not claim raw
webhook HTTP attempts. Reads remain audited and metadata only. Older Hubs leave
usage unknown. See [platform admin](../operations/platform-admin-overview.md#connector-activity-in-user-details).
