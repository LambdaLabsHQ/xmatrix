# Space agent routing

Status: the selection contract below is being implemented on
`feat/summon-observability`; integration and production acceptance remain open.
Earlier implementation and evaluation notes are retained as historical evidence,
not as validation of this revision or release authority.

## Current selection contract (2026-09-22)

The registration primary key is `(owner, machine, harness)`. Jev chooses one
whole key from the finite authorized registration list. These three fields are
not independent choice dimensions: combining an owner from one registration
with a machine or harness from another must never manufacture a registration.
Profile configuration and live Instance state remain separate from this key.

Concurrency counts are observations, never admission limits. Registration grants,
Space policies, environment edits and launch bindings no longer expose a
concurrency maximum. Execution allocations retain identity, replay and terminal
fences; they do not reserve finite slots. Configuration readers report unknown field names, discard their values, and
continue validating the supported fields. There is no named concurrency-field
compatibility branch and no data migration is needed solely to ignore an old
configuration key. Diagnostics omit field values and bound field names. A historical
machine-row foreign key still requires compatibility storage; its numeric value
is neither exposed nor read for selection or admission. New launch commands
require daemon capability `registration_launch_v2`; execution bindings remain strict and no longer decode the retired resource
field. Release acceptance must account for queued older commands instead of
claiming that the new binding decodes them.

The registered launch path supplies Jev with a bounded Channel context for both
identity and parameter choices. History is authorized as the caller and bounded
strictly before the durable source message sequence (at most 20 messages).
Current Channel name, topic, summary and authorized ancestor metadata are read
through the catalog authority, with at most five hierarchy entries. The JSON
context is capped at 12,000 UTF-8 bytes, includes source message IDs and the
observation time, and marks truncation. Raw metadata, sender identities and
participants are not forwarded. This is current authorized context, not a claim
that metadata or edited history was frozen at send time. Explicit current tags
continue to restrict the choice domains. Context lookup fails visibly when the
current Channel cannot be read; durable launch replay does not rerun selection.
The legacy Auto path and complete persisted decision-input evidence still need
integration and end-to-end verification.

A registration launch does not need a source message. Any input — a Human
message, a management instruction — is enough: Jev chooses among every authorized
registration in the Channel's Space, of any harness. Only a message-invoked
launch is fenced by its message (body hash, revision, explicit tags); other
input launches on registration authority and the resource fence alone, and the
launch intent stores no source message. A repository comes first: while the
chosen registration lists an authorized repository, Jev chooses its workspace
among the repositories only, and the launch evidence names the chosen
repository. Only when no repository is listed are registered directories and,
for input that needs no repository, a private managed directory offered. An
explicit `pwd:` still names its own directory. A Space management
Run (the @xMatrix delegate) is only ever offered that directory, which the daemon opens
as the Space management workspace; its Run metadata carries the management
Space and configuration generation, and authorization binds the Run's own
Instance rather than a configured Agent Profile.

No Space configures a management Agent. Each Space has its own management
prompt, written like a summon: a leading `@auto` or `@<harness>` with
`machine:`, `harness:`, `model:` and `effort:` conditions constrains which
registration Jev may choose for the @xMatrix delegate and Channel About. A
management Run always works in its Space management directory, so
`repo:` and `pwd:` are refused when the prompt is saved.

Registered workspace references may also name a canonical repository as
`repo:<repository-reference>`. Such a reference must be present in the Space
configuration, owner grant and Space policy. Jev selects that exact reference;
Hub emits `remoteRepo` plus `runWorktree`, and the daemon verifies those fields
against the admitted reference before materializing its managed worktree.
Directory grants cannot be converted into repository grants by a model choice.
Connector repository discovery and Channel context enrichment are separate,
unfinished inputs to this catalog; a stored reference is not proof of a completed
repository clone or a successful Agent turn.

After that identity choice, launch parameters form a separate choice space.
Model, reasoning effort and workspace values come from their own
real catalogs. Their Cartesian product describes possible parameter
configurations for the selected registration, not additional Agent identities.
Explicit tags constrain the appropriate dimension. Repository and local
directory are mutually exclusive workspace alternatives; model/effort support
can constrain combinations. Independent choices may be asked in parallel;
dependent choices need the selected value or a finite list of valid combinations.
The server validates support and authority but does not substitute a preferred
parameter after an unsuccessful Jev decision.

An `@auto` message reaches the newly allocated Run through ordinary Channel
delivery. Existing live Instances receive that Channel message as context and
do not execute it as a second addressed message. Stop commands finish their control-plane dispatch before the
message response; an exact stop may remain queued for an offline daemon.

A Human's stop command is atomic with its message. The PostgreSQL message
append that commits it also moves the Runs it addresses to `stopping`. For
`/kill all` or `/stop all`, those are every `starting` or `running` Run in the
Channel (up to 200). For `@<agent>:<N>:stop` or `/stop <agent>:<N>`, it is the
one Run that the message's own exact-address resolver resolves; an ambiguous
or unknown address fences nothing. For `@xMatrix:stop`, it is the Channel's
management delegate. About Runs are never addressed. The append
records `stopRequest` on each Run, cancels its unfinished launch, and expires its
one-shot trace grants, provided the Human holds `runtime_terminalize`.
`stopping` is not an active Run, so from that commit on the Run cannot append a
message, take live delivery, or finish starting; a late spawn success leaves it
`stopping`. Agent appends hold their Run
row in share mode, so no Agent message commits after the stop. The Hub then
posts the stop result immediately and delivers the host stops afterwards. Only
host confirmation moves a Run to `stopped`, and a later notice reports any host
cleanup that is still pending or has failed. A fenced Run stays a stop target
even while its Instance is offline, so a Run caught mid-spawn is still stopped
on its host. An Agent-authored stop command is not fenced; its `/kill all` waits for
host confirmation and reports confirmed, pending, and failed stops together.
Machine completion spells a UUID identity as `machine:<uuid>` once. The Hub
resolves that value to the exact durable `machine:<uuid>` ID; the previously
emitted `machine:machine:<uuid>` text remains accepted. Non-UUID machine IDs
retain their existing spelling and never gain a name-based identity fallback.

Harness selection lists each harness's declared models. The parameter decision then
offers the real model/effort domain of the chosen harness's environments, including
owner-declared versus observed provenance and observation time. Model names and harness names are unrelated values: no code
compares, filters, aliases or derives one from the other, and no `models` list
carries a harness name. An empty declared model list allows no model override,
so Jev skips model/effort selection and the launch leaves the runtime defaults
untouched. No synthetic default option or model tag is emitted. A non-empty
list is the complete set of allowed models, compared literally; without a
matching observed catalog entry, the declared models themselves are offered.
An explicit `model:` or `effort:` tag still requires a matching allowed option.
The runtime reports the actual model after startup. The environment that runs
the work offers the model/effort (when chosen) and location Jev chose. When
environments of one harness mix empty and non-empty model lists, only declared
models enter the model decision; the selected environment must offer that model.

Runtime model reports must persist both the sanitized `models` catalog and its
Hub-stamped `modelsObservedAt` on the Instance row. The routing reader consumes
that durable observation across Runs of the same owner/machine/harness tuple.
Message headers omit the catalog; their compact presentation is not a sufficient
persistence projection. Catalog-only changes invalidate the persistence digest,
an explicit empty report clears the observation, and unrelated heartbeats do not
refresh its timestamp. A missing catalog remains missing rather than becoming a
fabricated model named after the harness.
The database preserves the last catalog when a compact or legacy presentation
omits `models`; hibernation can omit large catalogs to stay within its attachment
budget. Only an explicit `models` field replaces that observation. The presence
writer carries an explicit empty report as `models: []`, clearing both the
catalog and its observation timestamp without changing hibernation limits.

Jev judges only semantic fit:
1. Whether the author asks for work.
2. Which harness suits the work. Each harness is listed once, with its owners'
   descriptions and its models.
3. Which model, effort and location to use, among the chosen harness's environments.

Jev never sees machine load, provider quota or allocation counts. A named harness
with no intent to read skips the first Jev call. Explicit machine, workspace and
parameter constraints still narrow the candidates first, and a measured exhausted
quota still excludes an environment.

An owner can keep a Machine out of automatic assignment (`data.machines.auto_assign`
false; the Machine page switch or `xmatrix machine auto-assign off`). Its
environments are removed before Jev reads anything unless the launch names the
Machine: a `machine:` condition, a `pwd:` registered on it, or a summon addressed to
one of its registrations. When nothing else remains the launch is refused with
`registration_machine_not_auto_assigned`. That refusal, and a machine name that
matches more than one person (`registration_machine_ambiguous`), is a hint on
the mention's card: the Channel is not told. Running Instances there are unaffected.

Which environment runs the work is measured, not judged
(`leastLoadedEnvironment`). Among the chosen harness's environments that offer the
chosen model/effort and location, the one with the most headroom wins. Headroom is
the scarcest of three shares:

- **CPU:** `1 − 1-minute load ÷ logical CPUs` or `1 − CPU usage`, whichever is
  smaller. Windows reports no load average. An overloaded machine goes below zero.
- **Memory:** available ÷ total.
- **Provider quota:** the remaining percentage. The provider's own verdict on
  the account, read with the windows (Codex `rate_limit.allowed`), outranks
  them: a refused account has none, and one still served past a used-up window
  on credits keeps 1%, eligible but after every account with window headroom.
  Whether to spend credits is the provider account's setting, not xMatrix's.

A machine without a current sample has unknown headroom and ranks after every
measured one. Ties go to the fewest outstanding Runs on the machine, whose load
may not show yet, and then to candidate order. Evidence from
`registration-parameters-v6` on records Jev's harness distribution by harness name
in place of the earlier per-environment choice.

A daemon on a host with a built-in battery reports `formFactor: "laptop"` in its
machine resources. That is a property of the machine, not a choice about the
work, so Jev's parameter request does not ask it. Headroom picks among every
environment that offers the chosen model, effort and location, laptop or not.
An owner who does not want that machine to take automatic work turns its
auto-assign switch off; naming the machine, or a directory registered on it,
still selects it. Evidence from `registration-parameters-v7` may record a
`placement` choice. `registration-parameters-v8` does not ask one.

The Hub also refuses Channel About text that arrived already destroyed. A
PATCH from the Channel's About session whose `summary` or `name` contains
U+FFFD, consists only of `?` (two or more), or has a run of three or more `?`
that is at least 30% of its non-space characters answers 422
`channel_about_text_mangled` naming the field. Nothing is saved and the session
keeps running, so it can write the text again from a UTF-8 shell.

Machine resources, concurrency, observed usage and provider quota are numerical
decision facts. They do not impose a Profile capacity ceiling or Profile
online/offline status. Daemon reachability, current authorization and explicit
user constraints retain their own meaning. Missing resource and latency observations
remain unknown. Quota without a current usable reading is treated as 100% remaining
(0% used) for selection, explicitly marked `policy-default`. The UI labels that
reading as unknown and retains unknown/stale observation provenance. This is a policy
assumption, not a provider measurement: it does not refresh timestamps, write a
synthetic provider observation, or replace a valid measured zero. The headroom
ranking reads this default like any other quota reading.

The daemon samples machine resources about every 30 seconds with its run
snapshot: logical CPU count and usage, memory, swap, the 1/5/15-minute load
average (not on Windows, where none exists), and total/available space on the
filesystem holding the daemon user's home directory. The Hub keeps the newest
valid sample in the daemon's `metadata.machineResources`; the shared protocol
parser drops samples older than 90 seconds, future samples and incoherent values.
The Web Machines page shows the same parsed sample as the Machine's load and polls
the owner's daemon list every 30 seconds while it is open, because relay push does
not carry resource samples. An online Machine without a current sample is shown as
having no recent sample, never as idle.

The daemon also reports a sample at least once a minute when nothing moved, so the
Hub keeps the Machine's load history: each sample accepted from the live connection
becomes one row per minute in `data.machine_resource_samples` (kept 7 days), and the
Worker's scheduled tick rolls completed hours into `data.machine_resource_hourly`
(kept 90 days) and prunes both at minute 7 of every hour. Only the Machine's owner,
signed in as a Human, reads it through `GET /api/machines/:machineId/resource-history`
(`range` 1h or 24h per minute, 7d, 30d or 90d per hour); the Web Machines page charts
it below the current load. History is an observation, never routing input.
The original message is immutable input, not a generated request form.

Record identity selection separately from parameter selection, including the
finite candidates, relevant observation timestamps, selected values and the
execution binding. A replay restores the committed selection before consulting
Jev again. Composite launch preparation stores the exact selected request in
`registration_launch_intents.launch_request_json` (expand migration 0073), without
copying the message body. Recovery validates the original message hash and revision
before restoring that request. A preparation interrupted before Run creation
continues with the same identities and parameters; a committed launch is reused.
Historical intents without a stored request are reported as recovery unavailable
rather than reconstructed from current configuration. Adding a new tag requires an explicit information source, option
domain, validation and execution binding; only transport and decision-recording
machinery are shared. There is no automatic future-tag inference framework.

The older sections below describe previous implementations. Their capacity
gates and semantic prerequisite stages are superseded by this contract, and the
headroom ranking above replaces their deterministic ranking. Historical passing tests do not prove the new contract complete.

## Summon intent (2026-09-26)

A launch mention is language, so Jev reads whether its author is asking an
Agent to start before any allocation. Every message-invoked launch — composite
registration dispatch, legacy `@auto` and legacy harness shouts, from a Human or
an Agent — adds one `intent` choice question to the same Jev request that picks
the environment, so the check adds no model round trip. The request state
carries the mention's text and UTF-16 offsets in the message Jev reads and the
author kind (`user` or `agent`), never a sender identity. The answer is one of
`summon`, `reference`, `explanation` or `example`
(`SUMMON_INTENT_CATEGORIES` in `@xmatrix/protocol`). Only `summon` continues;
any other answer discards the environment choice and records the bounded
rejection `summon_intent_<category>`, so the mention's chip explains why no
Agent started. A failed or unconfigured Jev starts nothing, as before.

`launch:force` after the mention is the author's own answer: the intent
question is not asked and the launch evidence records `intent.source =
"author"`. Environment choice, parameter choice and every authority check are
unchanged. Existing-Instance lifecycle addresses (`:stop`, `:reborn`,
`:handoff`, `name:N`) never reach Jev.

The labeled case set in `packages/hub/scripts/summon-intent-eval.mjs` holds the
2026-09-26 kill-all stray summons as negatives and real requests as positives;
run it with `--live` (or `--hub` from a live Agent Run, through the deployed
`/api/ai/jev/evaluate`) before changing the intent rubric. On 2026-09-26 the
`--hub` run passed 12/12: every negative read as `explanation` or `reference`
(lowest margin 0.56, the English syntax warning) and every positive as
`summon` (0.94–1.0).

## Product contract

Message-invoked terminal preparation rejections, including provider-measured
`registration_quota_exhausted`, publish a system failure receipt in the source
Channel replying to the original summon. The existing rejection record remains
the diagnosis authority. Receipts use bounded public reasons and deterministic
source/body notice IDs, so retries do not duplicate them; a failed receipt append
fails the request for idempotent recovery. A mixed batch reports rejected
allocations without claiming that its prepared launches failed. Exceptions after
an uncertain commit retain the separate unconfirmed-launch wording.

Users invoke a model/capability without choosing a machine. The first version
routes the same requested model across different harnesses and machines in the
current Space. Existing Space permissions remain authoritative. Owners explicitly
register the local environments they offer. Registration does not require an
invented name; owner, machine and harness are separate identity labels. Owners
may explicitly click to install a missing supported harness; discovery and
scheduling never silently install or register software.

Each registration is bound to its own machine, harness and configuration. An
abstract invocation is distinct from that identity and from each live Instance.
Selection considers request/environment compatibility before usage, latency and
congestion. A MacBook with a necessary browser session can handle work needing
that session but is not automatically eligible for unattended overnight work.
If no environment satisfies both requirements, report no eligible candidate.

Startup failure can select another eligible environment within a bounded retry
budget. A late predecessor must be rejected before initial-message delivery and exit. A
logical invocation has one current attempt; each attempt has a fresh target,
Run, Instance and execution binding. Checking only a machine id is insufficient
when a later attempt returns to the same machine. Receipt acceptance and fallback
must serialize on the invocation authority. Once execution is accepted, startup
fallback stops; execution migration is a separate future capability.

## Evidence and Jev boundary

### v7 integration verification (2026-09-21)

The real main-path 21-case Jev evaluation passed 20 cases and failed the implicit
Windows case with HTTP 502. A separate rerun of that case passed; this does not
turn the original run into 21/21. The isolated Hub/PostgreSQL/daemon fixture also
passed reply, exit, exhausted-profile exclusion and unavailable-machine checks;
its model responses are fixtures, not evidence of production model quality.

The first full Hub run recorded 1,624 passes, four failures and six skips.
Failures included an obsolete single-stage routing API model fixture, timing
history coverage below 90%, and an Automation-test Worker restart with a leaked
workerd process. The hung test process and its exact leaked child were stopped
after all other 342 files completed. The routing fixture was made stage-aware
(six focused tests passed), and four measured timing entries were added (four
resource tests passed). The Automation test file passed all nine tests in a
separate run without source edits during execution. The initial full-run failure
is retained; a clean full rerun is still required. Hub typecheck and version
consistency passed. None of this constitutes an immutable release or production
channel acceptance.

Primary sources checked on 2026-09-19:

- [TypeSafe introduction](https://docs.typesafe.ai/introduction): typed questions
  share state; questions are independent. Decompose multidimensional judgments
  and combine their answers in code.
- [Choice](https://docs.typesafe.ai/primitives/choice): finite candidates with
  descriptions, a selected key and a probability distribution. Descriptions can
  include positive and negative applicability examples.
- [Noul](https://docs.typesafe.ai/primitives/noul): probability of a proposition,
  with no separate confidence. Near 0.5 is uncertainty, not medium capability.
- [Confidence](https://docs.typesafe.ai/confidence): confidence summarizes a
  distribution; thresholds require domain evaluation. It is not evidence that
  a machine is online, authorized, authenticated or will remain available.
- [Gateway evaluation](https://vercel.com/docs/ai-gateway/modalities/evaluation):
  the repository's `@xmatrix/decision-model` client uses the AI SDK evaluation
  interface (Boolean uses `probability`, unlike native Noul).

Recommendation to validate: Jev identifies narrow request requirements and/or
semantic fit among already eligible candidates. Code enforces Space access,
explicit model support, capabilities, freshness, availability, capacity and
startup ownership. Compare this with a deterministic baseline and direct Jev
selection. No external benchmark quoted in earlier Channel research is accepted
as measured xMatrix performance. The small live synthetic evaluation below does
not establish production routing accuracy.

Do not ask Jev to discover machine facts, forecast battery life from a name,
authorize browser access, calculate scheduling arithmetic or provide a lease.
Do not send credentials, cookies, arbitrary local paths or full unrelated
conversation history. Bound request context and candidate descriptions. Record
rubric version, candidate snapshot references, distribution, abstention and
code overrides without logging private request payloads.

## Information infrastructure

### Prelaunch quota refresh (in development, not production acceptance)

Auto and bare harness shouts select from the persisted quota observation.
The quota probe runs after that read and writes the observation the next
selection will see; it does not delay this decision. Refresh targets come only
from an authorized Channel query.
The owning machine command authority issues a `quota_probe` lease to the exact
online daemon epoch advertising `machine_quota_probe_v1`; older daemons never
claim this command. Each command contains at most 32 Profile/configuration
bindings, expires after 15 seconds, and grants neither a Run nor filesystem
execution. The Hub refresh uses at most four concurrent batches and a 12-second
polling budget; database operations retain their separate bounded timeouts.

After completion, the Hub validates every result against its original target,
rechecks Channel access and current Profile/connection bindings, and writes only
usable provider observations to the existing directory quota observation table.
It does not create a second quota authority. A private pool is derived from the
Profile identity and version; an explicitly declared shared pool remains scoped
by owner. Configuration changes invalidate private-pool readings. Unknown,
expired, unavailable and timed-out readings never become an invented balance.
Provider observation time, not poll completion time, governs ordering/freshness.

Candidate selection, allocation and first Instance acceptance use the same
directory observations, through a separate directory database boundary rather
than assuming the Channel shard contains directory facts. Newer valid Instance
provider readings remain usable. Local PostgreSQL regressions cover cold
Profiles, exhaustion before acceptance, configuration changes and lease fencing.
The isolated cross-process fixture caught a missing daemon WebSocket parser
case: the authority leased the command but the client silently ignored its wire
type. Parser regression coverage and a real-daemon rerun now verify a completed
`unavailable` probe without borrowing credentials from unknown local Profiles.
The rerun also verifies two real child replies/exits and no extra launch for a
nonexistent machine. Evidence is retained in `/tmp/xmatrix-routing-repro-blgKFf`.
Its positive quota observation still enters through the production presence
writer, not a live provider probe. Positive provider-to-selection verification,
final protocol/timeout integration and immutable release acceptance remain
required; the fixture does not establish production completion.

| Information | Authority/source | Freshness and missing behavior | Jev input |
| --- | --- | --- | --- |
| Space, owner, machine, profile | Existing server identities and grants | Recheck at dispatch | Opaque candidate handle only |
| Harness, model and configuration | Owner registration plus adapter validation | Explicit model support; unknown is ineligible | Capability description |
| Browser/service capability | Explicit environment declaration and scoped verification | Expiry; unknown cannot satisfy a requirement | Capability label, never credentials |
| Unattended suitability | Owner declaration, optionally bounded by availability window | Current online is insufficient | Only when comparing semantic fit |
| Presence | Authenticated daemon connection/epoch | Expiring observations | Usually code only |
| Congestion | Active startup/running allocations plus daemon observations | Bound observation age; unknown is not zero | Usually code only |
| Usage/remaining quota | Provider-specific adapter or declared account pool | Unknown stays unknown; identify shared quota pools | Usually code only |
| Latency | Measured startup/response samples | Window, sample count and timestamp | Usually code only |
| Recent startup failure | Authenticated launch results | Bounded cooldown | Usually code only |

Declarations and observations are separate. Every observation needs provenance,
observation time and expiry. Distinguish machine, harness/configuration and
browser/account scope. An installed binary proves neither authentication nor
capability to use a particular website. Owners can inspect/correct declarations.
Unknown data must remain visible. Atomic allocation must prevent concurrent
selections from treating the same free slot as unused capacity.

## Existing integration points

- `packages/decision-model`: existing bounded server-only Jev client.
- `packages/db/src/agent-profile-control.ts`: Space-scoped registration and
  owner metadata; names currently have a unique key and exact mention meaning.
- `packages/db/src/runtime-control.ts`: transactional summon preparation and
  Instance connection. Current preparation resolves a specific Profile.
- `packages/hub/src/postgres-agent-launch-coordinator.ts`: durable launch
  publication and reconciliation, currently retries the same target.
- `packages/hub/src/index-routes-machine-daemon-admission.ts`: authenticated
  pre-spawn admission. Runtime connection must also fence a late predecessor.
- `packages/db/src/machine-control.ts`: authenticated daemon reports and epochs.
- `packages/protocol/src/agent-presets.json`: harness registry and install hints.
- Web local discovery/setup and native bridge: existing explicit registration
  entry points; installation must use typed, platform-specific operations.

## Implementation sequence and acceptance

1. Add validated candidate declarations, observations and request requirements;
   implement freshness-aware eligibility and deterministic ranking, plus bounded
   Jev request/response mapping. Test the MacBook/overnight example, unknown
   capabilities, shared quotas, same-model selection and abstention.
2. Persist declarations and authenticated observations through existing owning
   authorities; provide Space-scoped reads and owner editing. Surface provenance
   and freshness; never treat user metadata as live machine evidence.
3. Add abstract invocation and attempt authority, integrated with existing summon
   preparation. Revalidate candidate access and capacity transactionally. Keep
   old explicit Profile calls compatible.
4. Fence receipt acceptance against fallback; reject obsolete Run/Instance
   connections and ensure wrapper cleanup. Verify delayed start, timeout after
   acceptance, duplicate delivery, same-machine reselection, cancellation,
   permission revocation and exhaustion under concurrent calls.
5. Wire the user-facing abstract entry point, optional naming, identity labels,
   owner capability editor and explicit supported-harness installation flow.
6. Run focused protocol/Hub/DB/Web/Rust checks and PostgreSQL concurrency tests.
   Compare deterministic and Jev policies on identical labeled scenarios;
   report live measurements separately from mocked transport tests. Document
   migration order and compatibility. Production release remains separate.

Progress is recorded with evidence below; unchecked phases are not complete.

- [x] Requirements consolidated and primary Jev documentation checked.
- [x] Existing launch, registration and daemon authority paths identified.
- [x] Candidate contract and policy tests.
- [x] Durable candidate data and owner experience.
- [x] Abstract dispatch, receipt fencing and fallback integration.
- [x] Optional naming, labels and explicit supported-harness installation.
- [x] Local PostgreSQL concurrency, replay, cancellation and stale-receipt verification.
- [x] Live Jev evaluation through the authenticated production Hub.
- [ ] Multi-machine end-to-end canary before release.

## Implemented contract and rollout

### Display names and exact addresses

Agent Profile display names may repeat within a Space. Owners and machines are
shown separately as labels; creating or importing another `codex` does not add
a numeric suffix. The Profile ID remains the identity. When a completion list
contains repeated names, selecting an entry inserts its exact Profile address.
Typed ambiguous names do not select the first matching Profile or stop several
Instances accidentally.

PostgreSQL stores the human-facing override in nullable `display_name`, falling
back to the historical name for existing rows. Historical `name` and `name_key`
remain compatibility addresses; new Profiles use their ID for those unique
addresses. Migration 0057 only adds the display column and its search index.
It does not drop constraints, rewrite existing Profiles, opt environments into
routing, or change owner permissions. An authorized rename changes the display
label while old automation addresses continue resolving to the same identity.

The explicitly authorized Lambda Labs rename is a separate bounded maintenance
operation, not an expand migration. The reviewed manifest in
`packages/db/scripts/space-agent-display-name-plan.json` binds 25 Profile IDs,
their original name hashes, their harness labels, the Space, and the authorizing
message. It leaves owner, machine, routing declarations and legacy addresses
unchanged. All rows lock in one transaction; missing rows or intervening label
changes abort the entire operation. The ordinary Profile repository checks the
authorizing user's current permissions and emits its normal replay records.

After the containing version has a successful full Production Release, dispatch
`production-postgres-lifecycle-maintenance-request.yml` with
`operation=agent-display-names`, `dry_run=true`, and `max_rows=10000`. Review its
secret-free evidence for exactly 25 matches, then dispatch the same operation
with `dry_run=false`. The broker selects the latest successful immutable
production tag; direct executor dispatch is not authorized. Repeating apply
changes zero already-renamed rows. `operation=restore-agent-display-names`
supports the same dry-run/apply sequence to restore original labels. A subsequent
human label change blocks both operations rather than overwriting that change.
Read back the Space catalog and verify message headers and details before
running real route/rename acceptance summons.

Routing is invoked with mention syntax. A bare `@codex` shout is a harness
capability: the composer inserts the display name, and Hub routes the committed
message to an eligible machine. `@codex/mac` and other explicit locations bind a
registration key. New launches use `@auto repo:owner/repo` or
composer tags; retired `:new`/`:once` suffixes are rejected without execution,
while `:reborn` and `:handoff` remain existing-instance lifecycle commands.

The owner configures each Profile's structured routing declaration.
Non-repository summons require that owner's registered default working directory.
Routing starts from an authorized, unchanged, published Channel message. There
is no separately supplied message body or body-hash comparison. Command replay
recovers a lost response before checking today's candidate availability.

The former `POST /api/channels/:channelId/agent-routing/plan` and `dispatch`
endpoints return `410 routing_endpoint_retired`; send a Channel
message with `@auto` or a harness mention instead. Harness-shout dispatch runs
after message commit. Existing explicit Profile and
Instance invocation syntax remains supported. Agent identities are unchanged;
generated optional names do not encode machine or owner identity.
The CLI also accepts `xmatrix agent create --space <space> --preset <preset>`
without a name; omitting it does not bypass the registration confirmation.

Eligible runtime backends are Codex app-server, Claude print, and ACP (including
Grok ACP). A canonical model can have an owner-declared harness model alias
(for example a provider-prefixed ACP identifier). The resolved model passes through the durable spawn context and
the native adapter. Unsupported model changes fail rather than silently falling
back to the runtime default. Legacy daemons without `machine_routing_model_v1`
are excluded. ZCode and arbitrary PTY launchers are not eligible in this version.

Database authority records active Profile allocations and whole-machine Run
counts. Automatic allocations serialize within a Space and lock registration
rows while preparing. Explicit launches retain their existing manual admission
semantics; this is not a universal machine resource quota. Ranking prefers known
positive quota in descending remaining-percentage order, then Profile load ratio, machine Run count, fresh startup latency,
and stable Profile ID.
Known exhausted provider quota excludes a candidate. Unknown quotas are never
represented as zero or infinite remaining credit.

Presence expires after 90 seconds without an authenticated daemon observation.
Latency is the most recent successful prepared-to-connected sample, valid for
one hour; it is not token throughput or a percentile. Codex and Claude provider
reads carry their original `quotaObservedAt` through cached heartbeats. That
reading is a persisted snapshot, so an idle environment stays observable after
its Instance closes. Positive balances are bounded by a 15-minute maximum age.
Exhausted windows remain exclusion evidence until their own provider reset,
bounded to 31 days; a later provider reading can report recovery earlier.
The wire field is `resetAt` (Unix seconds or ISO time); historical `reset_at`
readings remain readable. Reset windows are evaluated independently: a short
window resetting cannot erase an exhausted weekly window. Missing resets retain
the 15-minute bound. Unknown remains unknown, not available credit. Among otherwise
eligible environments the deterministic scheduler prefers fresh positive quota
over unknown quota, then the highest remaining percentage, load and latency.
`deterministic-v2` identifies this exact-quota ordering; historical v1 plans stay
readable. Percentages outside 0–100 or non-finite observations cannot gain
scheduling preference. An observation is never
renewed by a later Instance heartbeat and never represented as zero or infinite
remaining credit. Profiles with no provider read at all remain unknown.
Shared account-pool discovery, polling idle Profiles independently of a runtime,
CPU/memory pressure, and response-token latency are not yet measured. Capability
descriptions are explicit owner declarations with expiry, not a credential probe
or an access grant. Credentials and cookies never enter the candidate contract.

One invocation admits at most three distinct Profile attempts. A startup failure
or 120-second startup timeout can choose another Profile on the same or another
machine. The exact Instance connection is the receipt boundary: it means the
authenticated wrapper connected, not that the provider completed its first
turn. Later model initialization or work failures are execution failures and do
not move an accepted invocation. Receipt and fallback lock the same PostgreSQL
invocation row; an obsolete wrapper is refused before it can consume its initial
message. User cancellation does not trigger fallback. Unaccepted startup expires
after ten minutes even if Jev is unavailable or the caller loses access.

Jev receives bounded request text, explicit requirements and opaque candidate handles
with harness, supported models, owner-declared suitability/limitations, unexpired
capability descriptions and de-identified scheduling facts. These include exact
remaining/used quota percentages with observation and expiry timestamps, load
ratio, whole-machine active Runs and startup latency. Missing, invalid, future or
expired quota/latency observations are reported as `unknown`. Quota bands are
only summaries; they must not erase differences between two positive readings.
Candidate handles and presentation order do not express a preference.
Scheduling signals may only break ties between environments that fit equally
well; an explicit requirement always outranks them. It receives neither
machine/owner IDs, working-directory paths nor credentials. A finite Choice
includes `abstain`. The rubric version is `environment-decision-v7`. Coding harnesses
are suitable for ordinary repository inspection, coding, testing and discussion
without an owner-written specialization description. Empty capabilities mean no
extra specialization; unknown declared availability is not an offline signal.
Brief requests can be routed for the Agent to clarify. Explicit unsupported special
requirements or declared incompatibilities still require abstention. Selection
never grants workspace access, which allocation authorizes separately. The AI SDK
Choice contract exposes `choice` and optional `probabilities`, but
does not expose native Jev `confidence`. The response must have a complete
normalized distribution and a maximum-probability candidate choice strictly
above `abstain`. Relative probabilities are not calibrated suitability confidence;
equally suitable candidates can split the probability mass. Provider failure or
abstention does not silently bypass semantic matching. Auto reports service
failure, semantic non-selection and no eligible environment separately.

Before selection, v7 assesses resource access, platform and continuity separately
against the same de-identified facts and explicit requirements. These prerequisite
questions omit quota/load so scheduling preference cannot establish suitability.
Inputs are byte-batched, with at most two model requests in flight and a shared
10-second deadline covering prerequisites and selection. Any batch error aborts
siblings; invalid, missing or out-of-set answers fail closed. The server still
owns authorization and rechecks current eligibility during allocation.

`not_evidenced` access and incompatible platform/continuity exclude a candidate.
An `evidenced` access claim additionally requires selected probability >=0.8;
`not_required` does not acquire that extra access-evidence requirement. This is
an explicit risk policy validated against the recorded synthetic cases, not
native confidence or a calibrated accuracy guarantee. If no candidate survives,
selection is skipped without manufacturing a probability distribution. Otherwise
only surviving candidates enter the final quota-aware Choice. A final response
cannot resurrect an excluded candidate. Both initial Auto selection and Jev
reconciliation use this same decision function; direct harness selection remains
deterministic and does not invoke Jev.
When multiple Instances have quota snapshots for one Profile, the newest valid
provider observation is authoritative for candidate scoring. Instance heartbeat
time cannot promote an older snapshot over a newer exhausted reading. Malformed
and future observation timestamps are ignored before ordering; offsets are
compared as instants, not lexicographic strings. The isolated PostgreSQL
[reproduction runner](../operations/auto-routing-local-reproduction.md) covers
this boundary without production data or provider calls.
Harness invocations also report candidate-query, eligibility and allocation
failures to the source Channel. A thrown dispatch or wake error is reported as
an unconfirmed launch, not proof that no Agent started: allocation or delivery
may already have committed. These notices are source-message-bound and use the
existing idempotent system-notice path. Reporting failure never retries the request
or falls through to a different launcher; launch authority remains the durable
invocation record, not the notice. If the notice service itself is unavailable,
the failure remains in server diagnostics rather than creating another request.
Each committed attempt saves the deterministic plan and available semantic
distribution, selected-option probability and rubric version. Failed semantic checks are bounded
by the invocation deadline; they do not create a second source of launch authority.

Native one-click installation currently supports Codex, OpenCode, Pi, GitHub
Copilot CLI, Gemini CLI, Qwen Code, Junie and OpenClaw via a native-owned npm
package allowlist. It requires installed Node.js/npm, runs as
the current user, has a bounded process-tree lifetime and never enrolls or signs
in the runtime automatically. Other presets retain their existing manual setup.
The [official Codex CLI documentation](https://developers.openai.com/codex/cli)
is the installation reference. Runtime sign-in and explicit Profile registration
remain separate owner actions.

Rollout order: apply migration 0056 on every relevant PostgreSQL shard, deploy
Hub, then deploy compatible CLI/daemon and Web/Desktop clients. Keep routing
disabled in owner declarations until the daemon advertises model forwarding.
The Worker-only `JEV_AI_GATEWAY_API_KEY` configures Jev access; no account
allowlist gates authenticated requests. No release/deployment was performed during
implementation. Space movement remains blocked for Spaces with routing facts,
consistent with the existing launch/profile movement restriction.
Channels with routed invocation history cannot transfer between Spaces until
that transfer path can migrate the complete routing ownership record.

## Local verification evidence

The final migration chain, including 0056, applied successfully to a fresh,
isolated PostgreSQL 17 database. No production database was modified.

- `XMATRIX_TEST_POSTGRES_URL=<isolated database> node --test
  packages/db/test/agent-launch-postgres.test.mjs`: 37 passed, none skipped.
  Coverage includes simultaneous duplicate dispatch, actual PostgreSQL lock
  contention between receipt and fallback, late predecessor rejection, receipt
  winning the race, model alias forwarding, declaration withdrawal, deadline
  expiry, original quota observation time, candidate exhaustion and manual stop.
- Protocol routing, Hub routing policy/API and presentation regression files:
  43 passed. One test exercises the actual Gateway SDK transport with a mocked
  provider response, verifying the Choice shape without a native confidence field.
- Native installer allowlist and unsupported-input boundaries: 2 passed.
- Two Playwright browser regressions passed against a full Web build: a lost
  dispatch response reuses the original source message, and a delayed successful
  dispatch preserves any newly edited draft. Requests use typed Query mutations
  with bounded timeouts and explicit user retry.
- An additional real PostgreSQL regression preserves the canonical model across
  Codex and OpenCode environments on different registered machines, accepts the
  replacement Instance and rejects the obsolete predecessor.
- DB migration, substrate/profile and Space-movement focused suites passed.
- Protocol and DB builds; Hub/Web TypeScript checks; Desktop build passed.
- Rust `cargo check --tests -p xmatrix-cli-runtime` passed. The
  `initial_spawn_context` and `combined_spawn_admission_carries_only_exact_authority`
  runtime tests passed, covering model context propagation and exact spawn admission.

These checks do not validate real browser sessions, macOS sleep, provider model
availability, actual npm installation, or deployed cross-machine execution.

## Reproducible evaluation

The synthetic evaluation of the Profile environment-choice ranking
(`scripts/agent-routing-eval.mjs`) and its prerequisite experiment were removed
with Profile routing: every Run now launches under a Space Agent Registration
(`docs/architecture/registration-only-runs.md`), and that ranking no longer
exists to evaluate. The historical results below describe that retired ranking.

### 2026-09-21 decision-input review (not release acceptance)

The v6 candidate input preserves exact fresh quota and explicit requirements;
the earlier coarse band mapped both 60% and 91% remaining to the same value.
A live 15-case evaluation with actual option-order reversal matched 14 labels.
The remaining counterexample selected a billing-browser environment for a request
requiring an already authenticated banking browser, which was not declared.
An experimental prompt requiring resource-specific access evidence did not fix
that error and additionally abstained on a valid billing-browser request. That
prompt change was reverted rather than accepted on the strength of unit tests.
One request in that experiment returned HTTP 502; transport failures and semantic
mistakes must be reported separately. Repeated evaluation also encountered
service-unavailable outcomes, so it does not establish stable model accuracy.

The next decision-design comparison must test separate prerequisite judgments,
not just expand the combined selection prompt. TypeSafe's
[building guide](https://docs.typesafe.ai/concepts/how-to-build-with-system-one)
and [composite scoring pattern](https://docs.typesafe.ai/patterns/composite-scoring)
recommend atomic questions with explicit criteria and code-owned composition.
That boundary is compatible with Jev as a general decision model; code-owned
authorization and deterministic comparisons are not themselves a design defect.

`--prerequisites` enables an evaluation-only two-stage comparison: independent
candidate prerequisite questions run in one request, without quota/load signals;
the selection request then sees only compatible candidates, with their full
scheduling facts. It does not modify the production path. Malformed prerequisite
answers fail closed, tied prerequisite answers do not admit a candidate, and the
second request cannot resurrect an excluded option. The reported abstention when
all candidates are excluded is code composition, not a model confidence claim.
The first 15-case live trial passed, including the banking counterexample; its
0.55 incompatible probability was close to the decision boundary. This is not
evidence of calibrated accuracy. The expanded 17-case set adds a banking-request
paraphrase and a brief ordinary coding request to probe generalization and false
rejection before considering production adoption.

The expanded two-trial evaluation disproved stability: 20/34 outcomes matched,
with two wrong banking selections in the first trial and twelve HTTP 429
failures in the second. The paraphrase received 0.91 compatibility probability
despite lacking matching access evidence. Raising a probability threshold alone
would therefore not establish correctness. The experiment remains unadopted;
prerequisite questions still combine several dimensions and need narrower
resource-evidence checks. Evaluation now stops at the first HTTP 429, reports
the incomplete matrix, and exits nonzero without automatic retries.

`--atomic-prerequisites` further separates access, platform and continuity
questions in the evaluation-only comparison. `--cases=id,id` selects a bounded
subset by exact scenario id. The first four-case probe matched the original
banking rejection, valid billing access and an ordinary short request, but still
misclassified the banking paraphrase (0.52 access-compatible probability).
It remains experimental, not a production fix. Separately, deterministic
exact-quota tests reproduced two failures before the v2 change: selecting 60%
remaining over 91%, and preferring an invalid 101% reading. Both comparisons
remain downstream of hard eligibility and capacity checks.

A subsequent evaluation-only access question distinguishes `not_required`,
`evidenced` and `not_evidenced` instead of conflating absent requirements with
present evidence. The same four-case probe still matched only 3/4: the banking
paraphrase received 0.56 `evidenced`, while the valid billing request received 0.83.
This experiment is also not production acceptance; changing labels alone did
not resolve the resource-grounding defect.

The full isolated Hub/daemon reproduction was rerun at commit `372b4d98b`:
two real child processes posted replies and exited, an exhausted predecessor
Profile was excluded, and a nonexistent machine produced no extra launch.
The cluster was stopped and evidence retained at
`/tmp/xmatrix-routing-repro-cgqrkG`. Both model boundaries were controlled fixtures,
so these results validate transport/lifecycle, not live model decision quality
or production acceptance. Post-exit stale-delivery rejections appeared in the
logs; the expected replies and terminal exits were asserted independently.

The v5 evaluation dataset adds a declared banking-session positive case,
bank-statement parser coding without real access, and matching/mismatching
GitHub organization access. `--access-floor=0.8` is an explicit experimental
selected-probability policy, not native confidence or calibrated accuracy. The
eight-case probe matched 7/8: it rejected the banking paraphrase but also rejected
valid billing access at 0.79. The policy is not adopted. The prerequisite
experiment now preserves explicit `requirements` from the parent input; omission
of those facts in the earlier split was another input-loss defect. This input
correction passed a three-case live probe (explicit billing, implicit billing,
banking paraphrase); unit coverage also verifies propagation.

The complete low-frequency run then matched only 13/21. All eight failures were
ordinary coding/platform requests whose access answer was `not_required`, wrongly
rejected by the same 0.8 evidence floor. The experiment now applies that floor
only to `evidenced`, not `not_required`; maximum-choice validation and rejection
of `not_evidenced` remain unchanged. This is a risk-policy distinction, not a
claim of calibrated accuracy. The corrected full live run matched 20/21; the
remaining implicit-billing case returned HTTP 502 and is recorded as a service
failure, not as correct abstention. No semantic mistakes were observed among the
completed model decisions in that run, which is not a production accuracy claim.
A separate rerun of the failed implicit-billing case passed; this does not turn
the original 20/21 run into a clean pass or establish provider reliability.
`--interval-ms=4000 --progress` bounds request frequency and emits per-case
progress without request text, secrets or provider bodies. The first HTTP 429 still
terminates the matrix without retries.

The production adapter now shares the atomic prerequisite input builder
with the experiment. It splits candidate questions at the existing 64 KiB UTF-8
request limit without dropping candidates or explicit requirements. A single
candidate that cannot fit fails explicitly. Tests cover 100 Unicode-rich
candidates, exact coverage across batches and oversized/malformed inputs. This
builder alone did not activate the stage. The subsequent v7 executor and Auto
integration add bounded execution and response validation; the main path is now
wired in this branch, not yet deployed. `--live-hub` evaluates that production
path by default. Explicit experimental flags preserve the older comparison
paths without applying prerequisites twice.


### Summon decision evidence (additive rollout)

A decision snapshot describes selection, not process startup. New snapshots carry
an evaluation timestamp, the number of considered candidates, stable Profile IDs,
and quota observation source and validity timestamps. An expired quota may retain
its provenance but never a usable remaining balance. The bounded view includes at
most twelve ranked and eight excluded candidates; the total makes truncation
visible. Jev fallback records distinguish unavailable evaluation from an unusable
selection without retaining provider error text. Older snapshots remain readable;
a missing evaluation timestamp must not be replaced with preparation time.

Auto preflight refusals (invalid parameters, missing selection configuration,
quota refresh failure, candidate-read failure, or no eligible candidate) also
commit a `routing_preflight_rejections_v1` outcome in the existing scoped command
replay store. It has the existing thirty-day retention and per-message idempotency.
This is historical evidence, not a Run, capacity reservation, or authorization
record. The first outcome stays immutable. Recording requires current launch
permission and an unchanged, author-bound source publication. History reads
require current Channel access and
omit outcomes whose source has changed, been deleted, or recalled. The existing
paginated invocation query returns these outcomes alongside preparation rejections;
the original summon text remains intact and only gains a status/detail view.

This initial coverage does not claim an exhaustive trace: prerequisite candidate
SQL filtering, in-progress probe/selection deadlines, and bare harness preflight
refusals still need structured evidence. Transport exceptions after allocation
remain unconfirmed, never misreported as "no Agent started". If the evidence store
is unavailable, the server reports that persistence failed; a notice alone does
not prove a durable diagnostic record. Invocation diagnostics authenticate the caller Run independently of the selected
target and retain current Channel authorization. The dedicated decision-payload
reader uses the collaboration capability described below.

### Channel context for legacy Auto decisions

The persisted-candidate Auto path and registered-key path both supply bounded,
caller-authorized channel context to Jev. The legacy candidate query binds the
unaltered source body to its published message before returning a sequence
boundary. Only messages preceding that sequence enter the context; recalled or
deleted messages are excluded. Topic and ancestor metadata describe the current
authorized view and carry an observation time, rather than claiming to be a
historical snapshot at message publication.

Environment choice v10 and launch parameters v2 share this context. Existing
explicit constraints still restrict their finite domains. Context projection is
limited to 20 prior messages, five channel ancestors and 12,000 UTF-8 JSON bytes;
truncation is labeled. Private metadata, sender identities and credentials do not
enter this projection. A source mismatch or failed authorization does not fall
back to unverified history. Committed launch replay avoids another model call.

### Environment-stage evidence

Successful registered-key and legacy Auto decisions now preserve the environment
request digest, selected opaque candidate handle and validated probability
distribution alongside the parameter-stage evidence. The Web decision panel
shows both stages. Older records without the environment field remain readable;
a malformed supplied field is rejected rather than presented as a verified
choice. Candidate descriptions, workspace paths and channel bodies do not enter
this public projection. A digest identifies the input but does not reconstruct
it: complete restricted input retention and failed-stage recording remain
separate requirements.

Pre-launch rejection records distinguish an empty candidate set
(`routing_no_eligible`) from a failed environment decision
(`routing_selection_failed`). A parameter-stage rejection retains the completed
environment's candidate rows and selection source. Safe typed codes distinguish
Jev timeout, invalid answer, authentication, permission, verification, rate limit
and other provider failure. Legacy `routing_parameter_selection_failed` records
can recover their safe reason from the restricted failed decision record. The
rejection code and public message share one protocol catalog across Hub, storage
and UI. An invalid answer records the actual question key from the decision
request and a bounded validation issue; the diagnostic does not enumerate
particular launch parameter names. A provider failure before an answer has no
question-specific cause to report. Raw provider error text is never retained.
The failure cause is shown before candidate observations, which remain
collapsed. None of these records asserts that a process was started.

Registered-key summons also persist sanitized pre-allocation failures through the
same source-bound rejection store. Context-read, environment-choice and
parameter-choice failures record `registration_context_unavailable`,
`registration_environment_selection_failed` and
`registration_parameter_selection_failed`, respectively. Context failure does
not invoke Jev; an environment failure never invokes parameter selection.
Unclassified chooser failures retain `registration_selection_failed`;
unavailable configuration or a rejected selection records
`registration_launch_rejected`. The invocation read projection
preserves these codes and the distinct Auto environment/parameter failure codes.
Provider exception text is never retained. Current channel permission and the
unchanged source publication are checked again when recording the outcome;
failed or edited-source persistence is not reported as a recorded diagnosis.


### Composer discovery

Summon completion uses the authorized registration catalog for machine, harness,
model, and reasoning-effort choices. Model efforts come from the most recent
valid provider catalog for that tuple and Space (at most 24 hours old), restricted
to the registration's authorized models. Missing observations do not imply a
supported effort. An authoritative empty registration catalog does not restore
legacy Profile candidates. Legacy suggestions are retained only for environments
without the registration catalog.

### Where a registration stands (Agents list)

Each catalog entry carries `live`, which is read at the same time as the catalog and used only for display. Routing, launch
and access never read it back. It has three parts, each taken from the source that owns that fact:

- `machine.online` and `machine.lastSeenAt` come from the owner's `data.machine_daemons` rows for that machine. The
  directory read that already names the machine returns them.
- `running` lists the registration's Instances whose Run is live (`starting`, `running` or `stopping`) and bound to it
  in this Space. The owner/machine partial index on live Runs keeps the read proportional to what is running. Only
  Channels the reader may read are listed (`runtime_history_read`), and at most 32 per registration.
- `quota` is the current `control.registration_quota_observations` reading for the registration's quota pool, the same
  row a launch reads. It is absent once the reading expires. Only the owner and the Space's owners and admins receive it.
  `quota.windows` are the provider windows behind `remainingPercent` (`windows_json`: label such as `5h` or `1w`, share
  used, reset time), without any window that has reset since the reading. A reading written before windows were kept
  has none.

The web Agents list groups locations under their runtime. A row is named by what differs between them: the machine, or
the name the Space gave the agent. Its second line says what the location is doing: running in which conversations,
ready, offline since when, or why it cannot take work. Low quota is added to that line. Rows are ordered by that same
state, with working locations first and absent ones last.

The chosen agent's Usage section shows each window as a meter with its reset countdown. While the Agents page is open
it reads the catalog every 15 seconds with `?quota=refresh`; after answering, the Hub issues the
`agent-registration-refresh-quota` command to the Space's registration authority, which checks that the reader is a
Space member and probes the Space's registrations like a routing refresh, except that a daemon asked for its quota in the
last minute is skipped. Readers watching the page therefore share one provider read per daemon per minute. Probes the
Hub issues set `windowLabels: true`; a daemon then names each window, and the Hub accepts a window `label` (at most 24
bytes) only on a probe that asked for it. Older daemons ignore the flag and answer unnamed windows.

Repository and directory discovery does not require a legacy Profile. The
Channel launch-target endpoint first verifies Channel access, then reads the
Space's repository connector and the caller's own registered directories. An
optional legacy Profile filter narrows directories to those Profiles' machines;
it never reveals another owner's paths. Discovery does not grant launch rights.

Typing a summon followed by whitespace opens tag choices, as does typing a tag
directly. Suggestions do not change the source message: only an explicit choice
replaces the active fragment. Enter at the whitespace boundary sends the original
message unless the user has explicitly navigated the suggestions.

### Restricted input content boundary (foundation)

The content authority supports an additive `channel-user:<encoded-channel>:<encoded-user>`
scope for decision inputs. Both components use canonical URI encoding. Every read
requires the named Human and current Channel content access; Agent principals and
other Channel members cannot read it. New-scope mutation replays recheck current
access. Existing space/channel scopes keep their current behavior.

Restricted blobs use a scope-qualified immutable object key and object identity,
so possession of a checksum cannot create a reference to the same bytes from a
public or different-user upload intent. The existing private upload gateway
validates the scope-derived key. No schema migration or copying of existing
payloads is required. Deploy supporting server readers before producing these
new scopes; older readers reject them.

The capture and authorized retrieval integrations below use this boundary.
Capture, retrieval and bounded expiry cleanup share this content boundary.
No raw input is added to public notices or Run metadata.

### Decision capture integration

Registered summons and legacy Auto attach a content recorder at the shared choice
execution boundary. The serialized input is cloned and committed before calling
Jev. Validated distributions or a bounded failure category are committed as a
separate immutable record with the same decision ID. Provider error text and
unvalidated answers are never retained. A model ignoring cancellation still
produces a timeout record. Missing or failed input storage prevents a model call;
failed terminal storage prevents allocation from that decision.

Records use `summon_decision` ownership bound to the original message and include
the invocation ID. The public upload API cannot mint this server-authored owner
kind. Both production paths use the existing PostgreSQL content authority and
private payload bucket. Injected test evaluators can supply their own recorder.
Original source text and execution parameters are unchanged. Actual Hub/PostgreSQL
coverage asserts four restricted refs (input/result for both stages) before spawn.

Storage failures have a dedicated public rejection code, distinct from provider
and invalid-answer failures. Input storage failure prevents evaluation; terminal
storage failure prevents allocation. Neither exposes storage error text.
Storage and retention failures remain visible through their own diagnostics; production rollout still requires the release gates.


### Authorized decision record retrieval

`GET /api/channels/:channelId/messages/:messageId/decision-evidence` lists at most
50 records per page (`after` continues from the returned cursor); `refId` downloads
one verified JSON record. Reads require the summoning Human, current Channel
access and an unchanged, non-recalled source publication. Agent principals are
not admitted to full private inputs. Records older than thirty days are excluded
from both listing and download. Generic blob-ref reads reject this owner kind,
so callers cannot bypass source and expiry checks via another content reader.
Listing exposes no object keys or raw inputs;
download checks the stored size and SHA-256 before returning private/no-store
content. Expiry filtering is not physical deletion; cleanup remains separate.

The invocation and rejection popovers offer an on-demand record list with download
links. Requests use the identity-scoped query layer, and account changes reset the
view. Public routing summaries and source text remain unchanged. Real Hub/PG tests
cover input downloads, access revocation and expiry; browser tests cover authorized
links and denial without exposing a download.

### Decision reference expiry

The internal content repository expires decision references in Space-scoped
transactions of at most 100 rows. Only generation-zero `summon_decision` references
older than thirty days qualify. Row/object locks and `SKIP LOCKED` allow bounded
concurrent batches. Each nonempty batch writes content audit/outbox evidence and
retires its reference routes; rerunning an empty batch performs no deletion.
Other owner kinds and unexpired decision references remain intact. Objects still
referenced anywhere in the Space are not nominated for collection.

Unreferenced objects enter the existing content GC table with its 31-day safety
window. This is reference retirement, not physical payload deletion. The expiry
method is internal and has no public command endpoint; the Space clock below schedules it.
The Space-scoped collector uses PostgreSQL leases and object fences before R2
deletion. Upload-intent creation and reference commits take the same object lock
and reject keys whose collection has started, including idempotent retries.
Collectors check all remaining references and upload intents, including expired
intents: expiry alone cannot prove an upload has stopped. Such objects are deferred
until the upload intent is safely retired.

Each pass retires up to 50 refs and considers up to 10 objects. Each R2 deletion
has a five-second observation deadline. Failed or timed-out deletion leaves the
five-minute lease fenced and resumable; completion uses the exact lease version.
A deleted GC row remains as a tombstone preventing resurrection of that immutable
key. Physical deletion can repeat safely after a crash. Audit records carry object
IDs and lease versions, never payloads. The Space clock below schedules collection and orphan-intent retirement.

### Space retention clock

`RelaySummonDecisionClock` is a per-Space alarm, introduced by additive DO
migration `v32`. It stores only the bound Space ID and alarm; content facts,
expiry selection, leases and deletion authority remain in PostgreSQL. Capture
arms it before and after each persisted event. It runs a bounded cleanup pass,
then sleeps until PostgreSQL's earliest expiry/collection deadline, or stops if
there is no work. Errors retain a five-minute recovery alarm. A concurrent
capture can arm without waiting for R2 cleanup, and cleanup cannot erase that
new wake. No global Worker cron or retired authority is reactivated.

Deploy the binding and class together through the normal immutable release.
Missing clock/storage prevents an unobservable decision. After migration,
recovery must retain the clock export and binding and use a forward fix; do not
remove a class that may hold pending cleanup alarms. A request interrupted after
arming is recovered by the alarm. Orphan upload retirement uses the explicit server-owned purpose below.


### Abandoned decision uploads

Expand migration `0075` adds a nullable upload-purpose field and bounded expiry
query indexes. Existing/general uploads retain NULL and remain outside this
collector. Only the internal recorder sets `summon_decision`; public APIs cannot
supply that marker or resume an internal decision upload through the generic
upload gateway. The marker is written in the same transaction as its intent.

After an internal intent has been expired for 31 days, maintenance retires it in
batches of at most 50, under the same object fence as commit/collection. An
unreferenced key is nominated for collection with another 31-day safety window,
including when upload never produced a committed content-object row. A remaining
reference or any other upload intent prevents deletion. Corrupt checksum/object
identity is rejected before collection. Normal decision refs still become
unreadable after 30 days and enter the existing GC safety window when retired.

Deploy the expand migration before the capture/clock code via the normal release
workflow. No existing upload is reclassified and no backfill deletes data. These
new restricted scopes were not produced before this feature, so the migration
does not infer ownership from legacy upload names.

Parameter preflight diagnostics distinguish unavailable catalogs, empty
model/effort domains, empty workspace domains, conflicting explicit constraints,
and invalid or oversized catalogs from a failed Jev parameter decision. These
codes are persisted against the source message before a Run exists. They reveal
no provider response, private path or raw exception, and do not authorize a
fallback selection or launch. Earlier generic failures cannot be retroactively
classified from these newer codes.

Model catalogs are observations of an owner/machine/harness execution tuple within a Space. Candidate reads share an actual Instance catalog across legacy Profiles for that same tuple, using the canonical Run registration binding when present and otherwise the Run’s recorded machine/runtime. Profile edits do not relocate an observation. The original observation time and expiry remain unchanged; an unrelated owner, machine, harness, or Space does not supply model options.

### Agent collaboration and decision evidence access

The September 23 maintainer authorization extends ordinary active Runs beyond
birth-Channel message writes. The dedicated `requireAgentChannelAccess` boundary
requires the exact Run/Instance/execution credential, unchanged current owner,
current registration admission, and current Channel access for **both** the Agent
and its owner. Source and destination must belong to the Run's Space. Terminal,
fenced, transferred, revoked or unauthorized Runs cannot use a remembered join.
Restricted About/Focus management Runs retain their separate contracts.

Joining checks existing access; it does not grant access or move an Instance.
PostgreSQL message preparation and commit revalidate the broader capability.
Messages retain their actual Agent/Run/Instance attribution. A message written
outside the Run's own Channel is a cross-Channel link: the append stamps
`data.messages.origin_channel_id`, `origin_run_id` and, when the Run is handling a
turn, `origin_message_id` (the source of its newest unfinished execution) from the
Run's own records, and the sender snapshot carries `originChannelId` /
`originMessageId`. Caller-built snapshots cannot claim an origin. A reply to a link
is relayed into the origin Channel under the link Run owner's authority as an
ordinary message (`xmatrixProvenance: "cross_channel_reply"`), so it is work there,
not a system fact. See `docs/design/evolving-system-zh.md` §5. Archived Channels
permit historical reads but reject new messages. Attachment writes retain their
separately scoped permission.

The dedicated decision-evidence reader allows such a Run to read immutable
summon decision inputs and results in an authorized Channel, including Human-authored
summons. This is an intentional extension of the former Human-only reader: its
payload can contain routing descriptions and catalog context supplied by the source
actor. The server derives that actor's restricted root from the persisted source;
callers cannot select a user or object key. Unchanged-publication checks, 30-day
retention, bounded pages, length/checksum verification and no-store responses remain.
Generic private blob reads do not inherit this capability. Human reads keep their
existing author scope.

Use `xmatrix diagnose CHANNEL --message MESSAGE --decision-evidence` to list records,
and append the returned record ID to `--decision-evidence` to inspect its payload.
Neither command launches or retries work. The existing invocation-diagnostics
endpoint retains its separate authorization; this change does not grant administrative
mutation, registration-management or unrelated private-content access.
