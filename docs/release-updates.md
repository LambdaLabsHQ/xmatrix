# Release Updates

## Unreleased: Co-writing starts with the document

A newly launched page co-writer receives the current document and its writing
protocol in the same first model turn as the invitation. Its words stream
straight into that page, avoiding a separate ordinary task that could spend
minutes reading commands or waiting for the person to stop typing while the
live request queued behind it. The original message and execution attribution
remain. A ten-second startup deadline preserves late requests through the
ordinary run loop. This is a CLI update for every harness; the Hub protocol
and older runtime behavior are unchanged.

## Unreleased: Pages have no claims and no owed updates

Coordination on pages is lock-free, so nothing on a page is claimed and no
section owes an update. `xmatrix page claim`, `claims`, `release` and `done`
are gone, with the Hub routes behind them, the competition setting, the notice
that names others on the same section, the GitHub write-back request on a
merge and the `owed` Automation trigger. `xmatrix page read` shows who is on
each section and which Agents work in its conversations, and the Run whose
work changes a page writes it back. A member's pull request that names a
section is still pre-reviewed there, and a merged one still makes its
participant author a contributor. The unused Space action claims API
(`/api/spaces/:spaceId/claims`) is removed as well.

Compatibility: the stable Web reads a section's `owed` only when it is present
and never reads `claims`, so it keeps working against this Hub. A CLI released
before this change reads page awareness without `claims` and `owed`, which
default when missing. Its `page claim`, `claims`, `release` and `done` reach
routes that answer 410 `page_claims_removed`, saying there is nothing to claim,
release or settle. Those routes stay until the stable CLI carries this change.
The GitHub App publishes no `xmatrix/claim` check; a repository that still
lists it among its required checks should drop it, or its pull requests wait
on a check that never arrives.

Migration evidence: contract migration `0215_contract_drop_page_claims` drops
`data.page_claims`, `data.page_block_competitions` and
`data.space_action_claims`, once the deployed Hub no longer names them (the
contract-readers gate checks it). Between that deploy and the drop the Space
and Conversation purges leave their rows, and the drop takes them. The one
Automation with an `owed` trigger was edited before the release, so no stored
trigger names it.

## Unreleased: Releases deploy concurrently by component dependency

Production Releases deploy side by side unless one has to wait for another
(`scripts/release-dependencies.mjs`). This replaces the two fixed lanes (service
and clients) of the previous change. A release waits for an active one when it
ships a component that release also ships, or when that release ships a
component it depends on. One component deploys in version order, because a later
deploy that finished first would be overwritten and channel pointers only move
forward. The dependencies are:

- the Web, CLI, Desktop, Android and iOS depend on the Hub: the Web is built for
  its train's Hub, and a client is admitted by that Hub and published against it;
- the Desktop, Android and iOS apps also depend on the Web: they are shells
  around the live Web of their channel and publish after it, as they do inside
  one release (client-readiness);
- Desktop also depends on the CLI, which it bundles.

Everything else runs at once: a Web beside a CLI, Android beside iOS, a Hub
beside any client. From 2026-10-22 to 2026-10-24, 17 of 92 Hub- or Web-only
release requests waited behind a 13–16 minute client release, 231 minutes in
total.

- **Dispatch.** A train still runs one at a time and still waits before tagging,
  but only for the active releases its scope waits for, and for any PostgreSQL
  contract migration or lifecycle cleanup, as before. Each release's scope is
  read from its tag annotation, and one that cannot be read waits and is waited
  for. GitHub can keep serving one response for one URL, even across trains, so
  every read of the run lists now names a new URL. A list frozen before the
  previous train dispatched would otherwise show no earlier release, and this
  release would deploy beside it.
- **Planning.** A beta train that ships an intent waiting for an active release
  holds the train until that release finishes: its gates run meanwhile, but no
  later train can plan. It does so only when that release is expected to finish
  within eight minutes, judged from each component's recent p90 duration and how
  long the release has run. An intent behind a longer release stays open, and
  that release wakes the train when it finishes (Release Train Next). Planning
  reads each run the list shows running again by its ID. A stale "running"
  would leave such intents open after the release that would wake the train had
  already finished.
- **Concurrency.** A release holds the group of its first component in
  dependency order: `production-release-train` for every release with the Hub,
  then `production-release-web`, `-cli`, `-android`, `-ios`. Two releases share
  a group only when they share that component, so each waits for the other and
  the train never dispatches them side by side; the group backs that wait up.
  A test evaluates the workflow's group for every pair of scopes against the
  rule. Run names carry the tag and scope.

Migration evidence: releases dispatched from earlier tags keep the group they
were dispatched with (`production-release-train`, or `production-release-clients`
for a client-only release). A new release that the train dispatches beside one
of them either holds another group, or shares `production-release-train` with an
earlier service release that it does not wait for; there it waits pending, as
every release did before, and no second release can join that wait.
Publication order is unchanged for each component. A release published after a
newer one of other components keeps its own preflight and its notes baseline,
which is the highest published version below it.

Recovery evidence: Production Release Recovery applies only to the
preflight-success/PostgreSQL-readiness-waiting shape, which only a Hub release
has. Every Hub release holds `production-release-train`, the group the recovery
`unlock` job acquires, so the proof and the unlock are unchanged. A release
without the Hub never takes that shape. A failed one is recovered as before, by
re-running its failed jobs. A release without the Hub that hangs before its first
mutation still holds back the releases that wait for it until their three-hour
dispatch deadline, as before.

## Unreleased: Retry transient CI ledger evidence reads

The CI ledger now shares the release train's bounded GitHub read transport:
network errors and HTTP 5xx receive at most five attempts, with a ten-second
deadline per attempt and increasing backoff. The deadline also covers JSON
and artifact bodies. Client errors and malformed JSON still fail closed;
only the original verified run, tested commit and successful jobs can earn
ledger entries. An unavailable ledger still makes later gates run in full.

Hub releases apply and read back an exact-host `/mcp` Browser Integrity Check
exception with the existing protected deployment credential, then require an
anonymous Python-style client to reach the Hub's 401 OAuth challenge. Other
security products and paths remain protected. Creation, retry and retirement
are documented in [MCP edge compatibility](design/mcp-server.md#cloudflare-edge-compatibility).

Exact-tag PostgreSQL expand migrations support bounded concurrent index builds
with durable, checksum-bound name reservations and the existing migration
ledger. Interrupted builds recover only their own indexes; unknown names and
changed definitions fail closed. See [online index migrations](operations/postgres-online-index-migrations.md).

xMatrix has one global source version. The root `version.json` file is the canonical
version source for a release train. An on-demand train publishes only its
selected components; existing versions of other components remain live and the
receipt records the exact scope. Keep source
manifests synchronized with:

```bash
pnpm version:check
```

A release no longer needs a version change on `main`. The Production Release
Request stamps the requested version onto the frozen `main` SHA as a single
release commit (`scripts/release-commit.mjs`): every manifest carries that
version in the released artifacts, and `main`'s own `version.json` may lag the
newest tag. `pnpm version:set <version>` (which updates `version.json` first and
syncs the package manifests, Rust crate metadata, and native release metadata)
is what the request runs; use it on a branch only to make local builds report a
specific version.

## Beta and stable channels

A release is a beta `X.Y.Z-beta.N` or a stable `X.Y.Z`, and the version alone
decides its channel (`releaseChannel` in `scripts/release-version-order.mjs`).
All releases form one ascending SemVer line:
`X.Y.Z-beta.1 < … < X.Y.Z-beta.N < X.Y.Z < X.Y.(Z+1)-beta.1`.

- **Beta.** Any Agent requests one after merging, as before:
  `gh workflow run production-release-intent.yml --ref main -f release_components=<list>`.
  The train freezes `main`, ships the union of the open betas it contains, and
  versions the release as a beta of the patch after the last stable (or of a
  higher `X.Y.Z` that `main`'s `version.json` or an earlier beta already names).
  The Hub and the beta Web (`beta.xmatrix.sh`) deploy to production; CLI,
  Desktop and Android publish to their dev channel; iOS goes to TestFlight
  only. Its GitHub Release is a prerelease.
- **Stable.** Only the stable release Agent requests one, naming a beta it
  verified and the bump its changes call for:
  `gh workflow run production-release-intent.yml --ref main -f channel=stable -f candidate=xmatrix-vX.Y.Z-beta.N -f bump=patch|minor|major -f release_components=web,cli,desktop,android,ios`.
  The version is the last stable raised by `bump`; it must reach the
  candidate's `X.Y.Z` and exceed every release. The intent and the train check
  that the candidate is an immutable beta tag whose Production Release
  succeeded and shipped every component asked for, and that its source contains
  the last stable's source, so no stable moves back. The train then rebuilds
  exactly that source at the stable version, deploys the stable Web
  (`xmatrix.sh`) when it names `web`, and publishes the named clients to their
  stable channel; iOS is also submitted to App Review. The Hub is not part of a
  stable: it runs every beta, and keeps serving the stable Web until the next
  stable ships a newer one. A stable train ships alone, and wakes the train
  again for the betas it left open.
- **Failure.** A beta whose gates or production run failed reopens for the next
  train. A stable that failed before tagging closes: nothing changed. A stable
  whose production run failed stays in flight under
  `refs/release-inflight/<tag>/`, pending recovery by re-running that run's
  failed jobs, until it succeeds or a later successful stable ships every
  component it names. No train retries a stable on its own.
- **Gates.** A train runs the CI gates for what it ships on its release
  commit. The Hub suite gates each beta that ships the Hub; the Web suites and
  client suites (Rust on Linux and Windows, Desktop, Android, the iOS
  simulator) gate the stable that ships them. Every train runs CodeQL on its source for the
  languages it ships before anything deploys
  (`docs/operations/ci-lint-and-public-runners.md`).
- **Evidence.** Each tag's annotation records the `scope`, `source` and
  `channel` later trains read back. The request's authorization job is named
  `authorize <scope> production <tag>`, and stable preflight accepts only the
  release commit of a revision the request's `main` contains
  (`release-commit.mjs verify-cut`).
- **Clients.** Every build machine checks the artifact it built runs as exactly
  the release version before uploading it: the CLI's `--version` on each
  platform, the Desktop app's `app.asar` (`scripts/desktop-app-version.mjs`),
  the Android APK through `aapt2`. A CLI or Desktop build picks its update feed
  from its own version, so a beta follows dev and a stable follows stable. The
  CLI installs only a newer release (`--force` reinstalls the same version), and
  refuses a download that does not report the version its feed named; the
  Windows Supervisor runs a verified candidate to prove its version and never
  stages one that precedes the committed release. R2 refuses a beta on stable
  and a stable on dev, and the Web download API refuses a stable pointer or
  GitHub fallback that names a beta. iOS ships `X.Y.Z` with the Production
  Release run ID as its build number.

The synthetic Human reconnect smoke carries the exact source `version.json`
version in its WebSocket URL and handshake. Its assertions compare those wire
values with that manifest for both beta and stable builds, rather than requiring
a stable-only version shape.

## Release notes

The stable release Agent also authors the release's user-facing changes since
the previous stable, following [Authoring release notes](releases/README.md).
Commit `docs/releases/<version>.md` through a PR before building and verifying
the final beta candidate. The stable intent and train reject a candidate whose
source lacks valid notes for the resulting stable version. This preserves the
unchanged-beta-source contract: notes on newer main cannot be attached later.

The production receipt publishes the authored stable notes, or GitHub's exact
tag change list for a beta, before its deployment evidence on the GitHub Release.
Users open `/releases/<version>` from Desktop updates, Machine versions or the
CLI's update output, and download cards resolve their component and channel to
the same exact-version page. iOS stable submissions populate App Store What's
New from the authored notes, with a bounded preview and link to the full text.
Manifests add an optional `releaseNotesUrl`; existing
consumers can ignore it and the native IPC shape stays unchanged. After release,
verify that the exact version's public page and update links work. Old releases
without user-facing notes show an explicit unavailable message.

Beta note generation bypasses cached release-list responses before choosing its
explicit preceding published version. Reads retain the existing three-attempt,
15-second-request bound; the note length and release-control-marker validators
remain unchanged. In 1.5.1-beta.11, an outdated baseline expanded the generated
notes beyond their bound after the Web deployment had succeeded. Re-running
only that Production Release's failed receipt job published the correct small
change list. Preserve immutable tags and use the same-run failed-job recovery;
do not edit an already published body's notes to repair a failed receipt.

Migration: existing immutable releases are untouched. New stable candidates
must include notes in their source, so an older beta must be superseded by a
newly verified one containing the document. Receipt failures retain the existing
same-run recovery path; no version, tag, signing or update-feed authority changes.

## Scope evidence without job step metadata

Production request authorization is the completed successful job named
`authorize <canonical scope> production`, which depends on the frozen plan and
all selected gates. The dispatcher depends on this job. Production preflight
and the independent Hub/Web reuse checks require exactly one such job, its
completed/success conclusion, successful plan/gates, the authorizing workflow
identity, and the same verified main/release SHA. A caller-supplied scope or a
successful dispatcher alone cannot authorize a deployment. Step logs and an
empty `steps` array supply no authorization evidence.

Deployment receipt jobs similarly carry their scope in
`deployment receipt (<canonical scope>)`. Archival requires the completed
successful exact-scope job plus its existing exact run/SHA/attempt, selected
component results and finalizer checks. Historical immutable tags retain their
old receipt label and exact successful step marker; archival still accepts that
historical proof only when no new scoped receipt exists. Missing step metadata
never authorizes an old tag, and a failed/ambiguous new receipt cannot fall back.

Migration evidence: v1.0.367's production request and its plan/gates/dispatcher
succeeded, but the jobs and per-job APIs returned `steps: []`. Production
preflight failed on the missing marker in three attempts; every build/deploy
job was skipped and the live Web build stayed unchanged. The writer and all
request-proof readers migrate together in a new reviewed main revision. The
scope-specific job preserves the former marker's exact selection while using
job conclusion evidence that remained available. Runtime workflow tests cover
empty steps, missing/wrong/duplicate scope, failed/skipped/cancelled/incomplete
jobs, selected-gate failures, different SHA and delayed evidence.

Recovery: keep the failed immutable v1.0.367 tag unchanged. After the fix passes
CI and merges, request a new Release Intent. The train reopens the failed train's
intent and chooses a higher immutable version containing both the performance
change and this fix. No provider mutation, manual tag move, direct deployment or
credential expansion is needed. Existing production serialization and recovery
conditions remain in force.

### Delayed job conclusions

Before production mutation, preflight reads the request's plan, aggregate gates
and exact tag/scope authorization together. It retries missing or incomplete
conclusions within a ten-minute window, at most 120 reads five seconds apart,
with uncached requests and a ten-second request timeout. The full preflight
job has a 20-minute timeout. A
reported failure or duplicate authorization still stops immediately; exhausting
the bound still refuses deployment. Successful authorization without reported
gate success is insufficient.

Migration evidence: 1.5.1-beta.2 and beta.3 passed their request gates but failed
production preflight because GitHub's Jobs API had not reported those successes
within the former one-minute window. No build or deployment ran. Completed job
logs were available while the API still reported pending jobs for several
minutes. This changes only the bounded evidence read, retaining the same exact
source, workflow, tag, scope and successful-job requirements.

Recovery: preserve failed tags and use a new beta from the CI-validated main
revision containing this fix and its authored stable notes. Verify its successful
production run and live Web before requesting stable. The normal same-run
failed-job recovery remains available when GitHub accepts it; no direct deploy,
manual tag move or substitute authorization is introduced.

### Delayed candidate run discovery

Train GitHub reads bypass caches and have a ten-second request timeout. An empty
Production Release list is re-read at most 120 times, five seconds apart within
a ten-minute evidence window. A reported active run remains active; the newest
completed run must succeed, so an older success cannot hide a newer failure.
If a checked stable intent's candidate evidence is still missing, active or
unreadable, planning fails with that intent preserved. It cannot discard the
stable decision or fall through to a beta on unavailable evidence. A definitive
candidate rejection retains the existing refusal behavior.

Migration evidence: the 1.5.1-beta.6 Production Release succeeded and its stable
intent passed, but the following train received an empty candidate run list,
deleted the checked intent and selected a beta instead. No stable tag was cut.
Recovery: after the reviewed fix merges, re-run the affected planning job when
the intent still exists. An intent the old planner already deleted must be
requested again by the stable release Agent through Production Release Intent.
No manual ref restoration, moved tag, new deployment path or weaker success
requirement is introduced. Existing immutable releases are unchanged.

Production preflight also re-reads an omitted current Production Release run
before deciding which exact-SHA run is authoritative. Own-run discovery and
request-job conclusions share one ten-minute window, with uncached reads and
ten-second request timeouts. A known earlier same-SHA run still refuses a
duplicate immediately; a missing current run or an exhausted window never
authorizes deployment. The 1.5.1-beta.9 preflight exposed this second empty-list
case before production mutation and recovered through the same run's failed-job
retry once its record became visible. New immutable releases contain the
bounded discovery; historical tags retain their existing same-run recovery.

## Shared release workflow definitions

The immutable Production Release train calls `server-release.yml` with an explicit `hub`, `web-build`, or `web` target. The former `hub-deploy.yml`, `web-build.yml`, and `web-deploy.yml` had no other callers. Their original steps now live in separate target-selected jobs in the shared workflow. Hub and Web retain independent production concurrency groups, exact-request authorization, read-only GitHub permissions, the same production environments, and unchanged credential bindings. The build job explicitly keeps `contents: read` only. Web still builds beside Hub after PostgreSQL readiness; only Web deployment waits for Hub and the verified build handoff. Selected jobs keep the historical `hub / deploy`, `web-build / build`, and `web / deploy` evidence names; inactive jobs have distinct names. Unknown targets select no production job.

The Hub Worker version tag carries the authorized `deploy_sha`. Its post-deploy
smoke requires the live health metadata to report that exact SHA and a nonempty
provider version ID, alongside the existing health and compatibility checks.
Missing or mismatched revision evidence fails the release gate.

CLI, Desktop and Android build machines upload their verified files straight into the immutable R2 release `releases/<component>-v<version>/parts/<part>/<run>-<attempt>/`. `client-publish.yml` moves no artifact: it seals the release manifest that names the newest complete attempt of each part and points the channel its version names at it: `channels/<component>/dev.json` for a beta, `stable.json` for a stable (see "Beta and stable channels"). A channel never moves back to an older release. Hub and Web deploy to production with every beta.

Migration evidence: before consolidation, the effective YAML definitions were saved and compared with the selected shared jobs. Every original step, environment, runner selector, timeout, credential binding, and component lock matched; release-policy tests validate the new caller bindings and authorization order. Historical immutable tags continue to contain and use their previous workflow definitions. Android's new nested publication evidence is `android / release / release`; archival accepts that name or historical `android / release`, rejects multiple matching records, and still verifies exact train SHA, attempt, scope marker, PostgreSQL readiness, and finalizer outcome.

Recovery remains the established Production Release Recovery workflow: it may cancel only the exact preflight-success/PostgreSQL-readiness-waiting shape before any build or deploy job materializes, then resume the same authorized replacement run. The parent graph and that proof are unchanged. A consolidation failure must be fixed through a new CI-validated main revision and Release Intent; do not modify immutable tags, publish unverified assets, or bypass train authorization. The existing CLI manifest/envelope `workflow: "cli-release.yml"` value remains the compatibility label expected by installed Rust update and Windows continuity consumers; relocating the reusable publisher does not rewrite that wire field. Signing helpers retain the original Developer ID leaf/team checks, pinned Apple intermediate, private keychain isolation, and cleanup; no signing identity or artifact format changed.


## Unreleased: Web per release channel

Every beta deploys the beta Web (`xmatrix-web-beta`, `https://beta.xmatrix.sh`,
no workers.dev or preview hosts, not indexed); only a stable deploys the stable
Web (`xmatrix-web`, `https://xmatrix.sh`), rebuilt from the verified beta's
source. `server-release.yml` picks the target from the tagged version
(`node scripts/version.mjs channel`) and `deploy-config.mjs` renders it
(`web` or `web-beta`). A stable train may name `web`; it still never names
`hub`. Deployment receipts record the channel's Web, and the receipt reader
accepts either Web for betas released before the split. Before a train deploys
the Hub, preflight reads the live stable Web's build (`/api/web-build`) back to
its release and refuses a Hub whose client policy would answer it with 426: a
different protocol version or a higher minimum Web version
(`scripts/stable-web-compatibility.mjs`).

The native shells load and trust the Web of their own channel. A beta desktop,
Android or iOS build opens `https://beta.xmatrix.sh/app` and a stable one
`https://xmatrix.sh/app`. Each lets only that exact https origin navigate in
place and call its bridge (the stable Web also under `www.xmatrix.sh`), never
the other channel's Web or another host under `xmatrix.sh`. Desktop and Android
read the channel from the app's own version. iOS cannot, because its App Store
version drops `-beta.N`; `scripts/ios-testflight.sh` sets its Web
(`XMATRIX_WEB_URL`, read back as `XMatrixWebURL`) from the release version when
it archives. Android's packaged offline Web is served under the build's own Web
origin. On every shell, the in-place sign-in opens only the Hub
(`xmatrix-hub.xmatrix.sh`), no longer any `xmatrix.sh` host. Beta users sign in
once more on the beta Web, because the session cookies the Web sets for native
shells belong to `xmatrix.sh` alone.

Migration evidence: the first beta train after this change creates the beta
Worker and its custom domain on its Web deploy; `xmatrix.sh` keeps the last
beta it served until the first stable that names `web` replaces it. The Hub
already trusts the beta origin (APP_BETA_URL). Native builds released before
the shells chose by channel keep loading `xmatrix.sh`. Clients that choose by
channel ship only once `beta.xmatrix.sh` serves: their first beta follows the
first beta Web deploy, or names `web` itself.

Recovery: a failed beta Web deploy is re-run on the same Production Release
run, like any job; it touches neither the Hub nor `xmatrix.sh`. Beta native
builds load nothing while the beta Web is down, so that re-run restores them
too. Undoing the split is a revert of this change and of the shells choosing
by channel: betas then deploy `xmatrix.sh` again, later native betas load it,
and the idle beta Worker can be deleted.

## Unreleased: Repository tokens are bound to the Run

The Hub mints an Agent's GitHub repository token only for the repository the
Hub admitted for that live Run on the calling machine, and asks GitHub only for
contents and metadata access (no pull requests, issues, Actions, workflows or
secrets). A repository outside the Space's connected installations is refused
with a precise reason (`github_installation_not_linked_to_space`,
`github_repository_not_installed`), and a probed installation token is accepted
only when it covers exactly that repository. Daemons that predate the Run
binding keep working while `GITHUB_REPOSITORY_TOKEN_LEGACY_UNBOUND_ENABLED` is
on.

## 1.0.0: first source-available release

1.0.0 is the first release built from the public repository `LambdaLabsHQ/xmatrix` under FSL-1.1-ALv2. The source is published; self-hosting is not documented or supported, and external pull requests are closed in favour of the Prompt request issue template. The version moves from the 0.16 train to 1.0.0 with no protocol, storage, or update-channel break: `scripts/release-train.mjs` takes `version.json` because it is above the newest tag, the Windows continuity sequence orders 1.0.0 above every 0.x release, and installed CLI, desktop, and iOS clients update through the same channels.

Since 0.16.854 this release adds:

- GitHub: Agent repository tokens are bound to their Run and Git permissions; private repository events stay out of public channels; the `xmatrix/claim` check verifies the Space's installation; a second App install merges into the Space connection; the pre-review verdict lands only on the reviewed head commit.
- Web: workspace lists update by push instead of polling; declined summons show on their card instead of a Channel notice; the summon panel shows Jev's input and answers; a Machine tag and its hover card open the Machine's page; message rhythm and composer alignment follow the avatar column; square jump highlight and reply quote card.
- Runtime: crowded channels fan out across owner cells and sockets carry their owner; Cursor quota headroom follows the bucket of the selected model.
- Reliability: Windows tree cleanup skips an unterminable older process on a recycled parent edge; expected Stripe, notice, and expired-credential conflicts are classified instead of reported as Hub errors.

## Unreleased: Summon tags show the routed machine

A summon chip shows the choices behind the launch. Jev fills repository, model,
effort, and harness. Routing fills `machine:<owner name>`. A hostname stays
the popover subtitle and is not that tag. Fields the author already wrote are
not repeated, and the message body stays unchanged. Whether a
machine is a laptop is that machine's own reported form, not a Jev choice, so
there is no `placement:` tag. Headroom picks among every environment that can
run the chosen work, laptop or not. An owner who turns auto-assign off keeps
that machine out of automatic assignment. Evidence from
`registration-parameters-v7` may still record a placement choice;
`registration-parameters-v8` does not ask one.

## Unreleased: Workspace search reads pages, attachments, and members

Ctrl+F searches page titles and committed section text, attachment filenames,
and Space members, and keeps scanning older messages until the readable history
is proven or the result list is full. A hit inside a page opens that section.
Restricted pages stay hidden, and uncommitted page edits are not in the index.

## Unreleased: Shared Agent execution symptoms

The Channel work dock shows connection retries, failed turns, and prolonged
absence of runtime progress through one per-Instance observer used by every
Agent harness. Progress and completion clear transient symptoms, failed turns
remain visible until new work, and reconnect replays the current summary.
Declared waits and open tool calls suppress the five-minute silence signal.
Optional ACP v1 Session Notices appear separately from execution failures;
an error notice does not fail a turn. Public presence carries only typed
symptoms and timestamps; supplied diagnostics remain in the host Trace.
Older clients and runtimes retain their existing display and behavior.

## Unreleased: Work dock island is a wood plank

On wood, the work-dock capsule is a plank in the rail's paint rather than a
glass capsule, with no edge lines. The avatar on its leading end is clear
liquid glass that bends the grain, and the words and timer ring are lightly
cut into the wood in dark ink.

## Unreleased: Work dock island matches the avatar

The work-dock capsule grows straight out of the circular Instance avatar at
the avatar's own size. The grey ring outside the face is gone. The presence
mark stays on the disc: a solid orange dot while the Instance is working, a
hollow orange ring while it waits. The timer ring and elapsed time stay at
the trailing end.

## Unreleased: Machine tag load excludes disk capacity

Machine tags use the higher of processor and memory usage for their fill and
colour. Disk capacity, including a nearly full disk, is excluded from the tag's
load. Hover details show processor, memory and disk readings; disk capacity
remains visible without affecting the tag's fill or colour.

## Unreleased: Registered launch reliability and diagnostics

Jev selects a summon model from the runtime-reported catalog. A registration that
only names its harness does not send that name as a model. When the runtime has
not reported a catalog, the launch omits the model parameter. Repository and
directory locations stay separate choices; repositories come from the Space
GitHub connector, and an unspecified location prefers a repository worktree.
Composite Space summons now retain a specific preflight rejection when an explicit
machine, harness, model, effort, repository, or directory has no authorized
registered match. Provider authentication, verification, rate limits, timeout,
invalid answers, and evaluation failures identify whether Jev was choosing an
environment or its launch parameters. The Channel invocation card and
`xmatrix diagnose` show the same bounded cause without adding provider text,
private paths, or credentials to the rejection. A failed preflight never allocates a Run.

Repository startup admission now verifies the repository against the authorized
Run instead of looking it up as a local Workspace. Disabled or model-ineligible
registrations no longer reach Jev. CLI diagnostics accept registration launches
without legacy Profile IDs. Editing a default model and pausing a registration
preserve unrelated configuration and policy resources, using their independent
revisions. An immutable maintenance receipt restores the one connector-authorized
repository omitted from the affected migrated registration. The existing
production maintenance workflow runs its dry-run and version-fenced write;
the original summon is covered by an end-to-end regression through admission
and Channel reply.

A daemon-started Agent Run reaches the daemon's own `xmatrix`: its directory
comes first on the Run's PATH and `XMATRIX_BIN` names the exact executable. A
stale `xmatrix` elsewhere on the profile PATH no longer reads newer subcommands
such as `page` as a runtime to wrap. A nested command that names a runtime
other than its Run's is refused before it touches the Run's status file, so it
can no longer mark the live Run `wrapper_startup_failed`.

## 0.16.342: Exact mention messages and stable Channel view selection

`@auto` remains syntax inside one Channel message. Routing uses the published
message and Channel context without sending a second body to launch authority or
comparing its hash. Jev receives a bounded privacy-safe view of the message;
transient gateway failures get one bounded retry without choosing an Agent on
the server's behalf. The old routing plan and dispatch endpoints return 410;
send a Channel message with `@auto` or a harness mention instead.
The Web Channel view keeps a Human's Tree or Flat selection in the active tab
when a preference write returns an older view, reports the unconfirmed save,
and rechecks the write once before accepting it.
## 0.16.341: Publish launch failure diagnostics in Hub and Web

This Hub/Web train ships the 0.16.340 source changes that identify the failed
Jev question and validation issue, show retained failure causes in invocation
cards, and label unread quota as unknown. The separate 0.16.340 production
request selected Hub and CLI, so Web requires this new immutable release scope.
The 0.16.340 Hub deploy stopped during bundle verification because the clean
checkout had not built `@xmatrix/protocol`; this train builds it before the
exact-SHA dry run and retains the failed tag's recovery evidence.

## 0.16.340: Explain launch parameter failures

Auto summon failures now report a safe provider or validation cause before launch
allocation. Invalid Jev answers identify the question key from the actual decision
request and the validation issue, so new parameters receive the same diagnostic
without a fixed display list. The invocation card surfaces retained failure evidence
for older generic failures, keeps candidate observations behind a disclosure, and
labels unread quota as unknown instead of showing a measured 100% balance.

## 0.16.339: On-demand component publication and Web completion

Production requests now select any supported subset of Hub, Web, CLI, Desktop,
Android, and iOS. Node checks and the selected component suites run on one
frozen SHA before the immutable tag is created. Tagged deployment verifies the
exact scope authorization, publishes only selected components, and records the
actual scope in R2 and GitHub receipts. Desktop requires CLI in the same train;
selected client publication checks live Hub admission of its exact version.
This release can publish Web alone after Hub 0.16.338, making the compact
`machine:<uuid>` completion available in the Channel Composer.

## 0.16.338: Channel control and Hub-only production scope

Stop commands now finish their Hub dispatch and visible receipt before the
message response. `/kill all` describes unconfirmed queued stops as pending
instead of failed. Existing live Agents receive a new `@auto` summon as context;
the allocated Run alone receives it as its initial message. A candidate without a
current model catalog can explicitly select its harness default without sending
a fabricated model ID or effort override. Summon decision evidence retries one
idempotent storage step after a transient failure, and Auto publishes its exact
prepared batch immediately before arming the durable recovery coordinator.
The updated Web source inserts `machine:<uuid>` instead of
`machine:machine:<uuid>`, while the Hub accepts both spellings as the same exact
machine identity. The completion change reaches users only when a reviewed Web
release follows this Hub-only train.

The production train for this version applies its PostgreSQL checks and deploys
Hub only. Web, CLI, Desktop, Android, and iOS remain at their previously
published versions. The full test matrix, immutable tag, Hub source checks,
post-deploy verification, and scoped deployment receipt remain required.

## 0.16.317: retire the :new and :once launch suffixes

Legacy `:new` and `:once` message launches are rejected with a tag-syntax
migration notice; they are not translated or executed. Use
`@auto repo:owner/repo mode:persistent <message>` or `mode:once`, replacing `repo:`
with `pwd:"<registered/directory>"` for a registered directory. Start-action
completion and Agent/Automation guidance use tags. Existing instance addresses,
stop, reborn and handoff retain their lifecycle semantics. Stored Automation
expressions are not silently rewritten; owners must replace retired launch
suffixes before their next successful invocation.

## 0.16.316: correct routing snapshots and report launch failures

Auto and harness invocation exceptions now produce a source-bound Channel
notice instead of only a server log. Direct harness requests also distinguish
candidate-query, eligibility and allocation failures. A failure after possible
allocation or wake delivery is explicitly unconfirmed, not proof that no Agent
started; reporting it never retries the request or falls through to another
launcher. Private exception details remain out of Channel notices.

Routing now orders quota snapshots by validated provider observation time,
not Instance heartbeat time. An old positive snapshot cannot replace newer
exhaustion simply because its Instance updated later. Agent unregister also
carries its authenticated connection version, fencing stale connections;
daemon-launched Runs leave completed/failed terminality to their exit report.

Among eligible candidates, deterministic routing compares exact fresh remaining
quota before load/latency rather than treating every positive reading equally.
Invalid percentages do not gain preference. Auto receives exact quota and
freshness facts plus explicit requirements, while request suitability can override
quota preference. Auto's v7 decision path separately assesses access, platform
and continuity before quota-aware selection, within a shared 10-second budget
and at most two concurrent prerequisite batches. Rejected candidates cannot be
resurrected by selection, and all-rejected or failed evaluations never allocate.
The architecture evaluation record preserves earlier unsuccessful experiments
and distinguishes model outcomes from service failures and deployment evidence.

Focused tests cover exhausted candidates, service failures, successful dispatch,
wake exceptions and notice-service failures. A fresh-PostgreSQL reproduction
and an isolated Hub/daemon fixture cover snapshot ordering, real child startup,
Channel replies, exhausted-candidate exclusion and Agent-requested stop. The local
fixture controls both external model boundaries. These checks do not establish the
cause of the production 315 canaries without replies; a real launch, reply and
Agent-requested stop still require post-deployment acceptance.

## 0.16.315: preserve provider quota exhaustion during routing

Read the actual `resetAt` quota wire field, including Unix-second timestamps.
Evaluate quota windows independently so a short reset cannot erase an exhausted
weekly window. Persisted exhaustion with a known reset remains exclusion evidence
until that reset, capped at 31 days; positive or reset-unknown observations keep
the 15-minute freshness bound. Fresh provider recovery replaces older evidence.
Unknown quota is not unlimited: deterministic routing prefers observed positive
quota, and Auto's v5 rubric uses the same preference among candidates equally suitable for the request.

Protocol and Hub regressions cover both Auto and direct harness selection. The
production 314 canary did launch but failed at the provider's usage limit; these
changes do not claim that canary completed or automatically replay an accepted
execution. Post-deployment launch, reply and Agent-requested stop remain required.

## 0.16.314: route ordinary requests without custom environment descriptions

Auto's v4 suitability rubric treats a coding harness as capable of ordinary
repository work even when its owner has not entered a custom routing description.
Brief requests are routed for the Agent to clarify instead of being rejected by
the selector. Explicit unsupported specialized requirements still abstain;
authorization, eligibility and allocation checks are unchanged.

Remove retired main-to-test dispatchers from the reusable CI graph so the
production request can validate it under read-only permissions. Conditional
skipping alone does not satisfy GitHub's reusable-workflow permission ceiling.
No caller permission is expanded and Next's push-only deployment is preserved.

Live synthetic Jev checks on 2026-09-21 selected an environment for README
inspection and a brief request, and abstained for an undeclared proprietary
Windows application. These checks verify rubric behavior, not completed Agent
launches or a production accuracy benchmark. Real Channel launch acceptance
must be verified after deployment.

## 0.16.313: Auto availability and selection errors

Remove Jev account allowlisting from Auto, routing and evaluation. Existing
authentication, Channel access and environment eligibility remain enforced;
the provider key stays inside the Worker. Routing accepts a valid highest-ranked
candidate above abstention without treating relative choice probability as
calibrated confidence. Auto distinguishes unavailable selection services,
semantic non-selection and an empty eligible set.

Legacy launch-suffix retirement and Agent registration composite-key migration
are separate changes and are not included in this release.

## 0.16.312: keyboard-first Auto launches

The composer offers Auto and launch conditions through one `@` search. Selecting
a repository, model or machine creates removable tags without requiring users
to learn parameter syntax. Arrow keys and Tab/Enter select conditions; ordinary
typing continues the message. Existing harness entry points and IME remain intact.
Portable `@auto key:value` summons route through Jev with server-enforced constraints,
replay recovery and exact-directory fallback. Authenticated Agents can invoke
Auto and harness shouts using their owner-bound Channel authority, alongside
existing peer lifecycle and stop commands. Explicit effort requires a daemon
advertising `machine_routing_effort_v1`.

## 0.16.311: production freeze of the @codex:new launch chip

0.16.310 froze one commit earlier than the hotfix that binds a shared `@codex:new`
mention to its routed launch and cools a machine that just failed to spawn. This
train is that hotfix on current main.

## 0.16.310: @codex:new shows the routed launch and skips a machine that just failed to spawn

`@codex:new:owner/repo` already binds a harness to one environment. When several
Codex Profiles share a Space, the written `@codex` stayed plain text, so a
routed launch that then failed to spawn looked like the mention did nothing.
The message's launch now names that chip. A non-retryable daemon spawn failure
cools that Profile for an hour so the next shout can pick another machine.

## 0.16.309: @codex:new routes with repo or CWD

`@codex:new:owner/repo` is a harness summon, not a unique Profile. Hub binds
the repository to one environment through routing (Jev when configured, with
quota as a tie-break). `@codex:new:/absolute/path` matches the registered
working directory. An empty routing model is idempotent, so plan/dispatch no
longer fail after the first parse.

## 0.16.308: paged catalog activity and post-0.16.307 fixes

0.16.307 never froze a candidate tag: the version-bump push's main `CI` run was
cancelled by later merges before it could dispatch the candidate `Test Release`,
and the following same-version pushes could not freeze it. This train re-bumps
from current `main`, so the candidate contains every change since 0.16.306.

The paged PostgreSQL Channel catalog now serializes a Channel's newest message
time as `updatedAt`. A Channel that keeps receiving messages advanced
`activity_at` but not `updated_at`, so chat-list flat views ranked it by its
last config write and pushed it to the bottom of every loaded page, where
infinite scroll never reached it. It now matches the legacy `list-channels`
read, which already folded the newest message into `updatedAt`.

## 0.16.307: production freeze of 0.16.306

0.16.306 landed on main but its Test Release did not freeze a candidate tag,
because a later same-version push compared equal and skipped tagging. This
train freezes the same product: one Agent name in completion, shared status
chips for owner/machine, and shouts that do not send the harness as a model id.

## 0.16.306: one Agent name in completion

Composer `@` completion offers one row per Agent display name in a Space.
`@codex` and `@grok` are harness shouts; routing picks the machine. `:new` and
`:once` still complete GitHub repos and registered working directories.
Duplicate Human names stay distinct. A shout no longer sends the harness name
as the runtime model id, so ChatGPT Codex uses its configured default.

## 0.16.305: @codex shout selects a startable machine

A `@codex` shout now plans only among matching machines, and only requires a
registered default working directory when one exists. 0.16.304 could pick a
busier machine without a workspace, then fail closed when dispatch required a
workspace. Registration-launch errors no longer skip shout routing.

## 0.16.304: @codex auto-route

A bare `@codex` shout is a harness capability, not a unique handle. The composer
inserts the display name, message commit no longer rejects repeated Agent names
as ambiguous, and Hub routes the shout to an eligible machine. Duplicate Human
names still fail closed. The composer has no separate auto-route form: mention
syntax is the product surface. Composite registration launch and owner controls
ship with this train; Space `data.agent_registration_authority` stays off, so
this release does not cut identity over or broaden Agent permissions.

## 0.16.303: mobile startup

The first Channel-list page loads before background workspace and Agent data,
while direct Channel links retain message-history priority. Client admission no
longer restarts initial private reads when the account query client changes.
Hash-named Web scripts and styles use immutable caching. The iOS shell creates
only the current tab at startup, preserves visited tabs, and retires hidden pages
when the active account changes. Older clients tolerate the additive bridge
metadata.

## 0.16.300: composite registration migration preparation

Defines owner/machine/harness registration keys and Space-scoped configuration
keys without a new Agent UUID. Adds inactive composite-key tables and a bounded,
read-only inventory operation for the reviewed Space registrations. Existing
profile authority and runtime addressing remain in place until verified bindings,
conflicting configurations and dependent references are migrated. This release
does not claim the identity cutover or broaden Agent permissions.

## 0.16.299: approval preflight and Agent recovery

Includes the sandboxed Agent reply and owned Instance recovery fixes from 0.16.298.
Approval validates required secret availability before committing the decision, so a
missing value leaves the request pending and can be retried after saving. Missing-secret
errors explain that action without exposing private catalog details.

## 0.16.298: sandboxed Agent replies and owned Instance recovery

Agent child CLI commands use their inherited Run routing and scoped brokers without
opening the Human profile registry. macOS isolation permits only the non-secret
lineage discovery needed by the owner-execution guard; credentials, approval tickets,
and marker writes remain blocked. Owners can request exact-Run Instance recovery
through an authenticated control endpoint without posting a Channel message.

## 0.16.297: readable exact-Profile summons

Agent mentions addressed by a complete Profile ID display the resolved name and
original lifecycle/repository tail, without exposing fragments of the ID as
command text. Pending summons preserve the same exact identity as member
mentions. Repeated display names remain ambiguous instead of adopting the first
pending Agent's receipt.

## 0.16.296: validated Windows update recovery release

Includes the Windows automatic update recovery fix from 0.16.295. Shared recipient
identity and Channel preference test fixtures remove duplicate-code failures on main
without changing message delivery or preference behavior.

## 0.16.295: Windows automatic update recovery

Windows daemon self-update now retains its restart obligation after the old process exits.
Failed updates restore and verify the previous daemon before reporting rollback success.
Cleanup excludes Agent wrappers and commands that merely mention `daemon`, including when
they share the stable CLI executable. CLI-only updates preserve an intentionally stopped task.

## 0.16.294: reproducible maintenance preflight

The protected PostgreSQL maintenance preflight now installs pinned Node, pnpm,
and workspace dependencies after verifying immutable release authority. Fresh
runners can execute the bounded operator checks without relying on a previous
job's PATH. Production credentials remain exclusive to the subsequent maintenance
job. The authorized Space rename, its fixed manifest and restore path are unchanged.

## 0.16.293: Agent presence survives catalog refresh

- Channel pagination, route resolution, and realtime updates now share the
  hydrated Channel merge instead of replacing live Agent cards with sparse rows.
- One instance merge retains omitted tags, rejects older nonterminal status,
  accepts current idle/offline reports, and isolates replacement instances.
- Browser coverage verifies model, effort, sandbox, and branch visibility after
  catalog refresh and the subsequent busy-to-idle transition.

## 0.16.292: disconnect and reborn recovery

- Historical reborn lookup accepts the current display label, retained address,
  or exact Profile ID and still rejects ambiguous names.
- Agent replies now retain exact Run authority across transport-only disconnects,
  while terminal, replacement, deletion and handoff fences remain enforced.
- Peer presence broadcasts no longer await recipient inbound queues, preventing
  reciprocal concurrent broadcasts from deadlocking.
- PostgreSQL reborn intents retain stop-to-spawn continuity across delayed
  acknowledgements and coordinator restarts; migration 0058 is additive and
  existing daemon stop/spawn contracts are unchanged. See
  [Runtime reborn recovery](operations/runtime-reborn-recovery.md).

## 0.16.290: repeated Agent display names

Agent Profiles can share a display name such as `codex`. Owner and machine
labels appear in the picker, message headers, and the Channel details rail.
Selecting a repeated name uses the exact
Profile ID for startup and Instance controls. Ambiguous typed names do not pick
an arbitrary Agent. Registration no longer adds host names or numeric suffixes.

Migration 0057 adds a non-unique display label while retaining historical
addresses for existing invocations and automations. Existing Profiles are not
renamed or enabled for routing by deployment; those remain authorized owner or
Space administrator operations.

## 0.16.289: Space environment routing

Users can request a model without choosing a machine. Automatic routing selects
among explicitly owner-registered environments in the current Space, including
different harnesses. Declarations describe capabilities and unattended
availability; fresh presence, startup latency, provider quota and active Run
counts inform eligibility and ordering. Optional Jev matching can abstain.

PostgreSQL serializes startup fallback with a unique accepted Instance, rejecting
late superseded startups. Registration names are optional and identity labels
show owner, machine and harness. Desktop users can explicitly install supported
runtimes without automatic sign-in or enrollment. Migration 0056 and a daemon
advertising model forwarding are required. See
[Space agent routing](architecture/space-agent-routing.md) for boundaries,
verification and rollout prerequisites.

## 0.16.287: generic Jev evaluation

The Hub exposes authenticated `POST /api/ai/jev/evaluate` for shared state and
Boolean, Choice, or Score questions. The provider key stays in a Worker secret;
a deployment-owned Human/Run-owner allowlist gates access. Requests are bounded,
time out after 15 seconds, and return structured answers with sanitized errors.
The local `pnpm jev:evaluate` command uses the same client. This entry point does
not change routing or Agent dispatch. See [Jev evaluation](operations/jev-evaluation.md).

## 0.16.283: persist offline when reverse delivery evicts the last owner

Evicting a half-open Machine Daemon socket used `remove()` before `close`, so
the late close callback never unregistered the catalog row. A last-owner
`failedDeliver` eviction now persists offline. Catalog `online` cannot survive
a dead reverse-delivery session.

## 0.16.282: hollow-online daemon notices

When a Machine Daemon catalog row is `online` but reverse delivery returns
`delivered=0`, the start notice says the daemon has no live control session
and will start on reconnect. It no longer claims the daemon "is online".

## 0.16.281: Agent send keeps the Run token

If the daemon request-broker journal path returns `unauthorized` for this Run,
`xmatrix send` submits the same body with the already-resolved Agent Run token.
It does not fall back to the launching Human's session.

## 0.16.248: optional catalog configuration

Production deployments no longer require `XMATRIX_SECRET_CATALOG_KEY` to ship
Channel transfers and secretless Workstation approvals. An absent value is omitted
from the deployment secret payload, preserving existing Worker secrets. A supplied
value still requires validation and post-deploy binding verification. Managed
Secret recovery remains separate; this release neither generates nor rotates keys.

## Manifests

- `/api/releases/latest` returns the current web/root train as `version` and `trainVersion`, plus the latest CLI, Desktop, and Android release manifests.
- `/api/cli/releases/latest`, `/api/desktop/releases/latest`, and `/api/android/releases/latest` expose the newest
  immutable stable release for that target (reviewed R2 channel first, GitHub fallback where supported). Their
  `version` and `releaseVersion` fields describe the downloadable release, and `trainVersion` preserves the current
  web/root train for diagnostics. R2-backed CLI assets also carry exact size, SHA-256, workflow, Git SHA, and run
  provenance; Windows continuity refuses manifests without those fields.
- Target release manifests resolve the newest published release whose tag uses the target prefix, such as `cli-v*`, `desktop-v*`, and `android-v*`. Desktop stable feeds must also require the platform-specific updater asset set before serving a release: macOS feeds require `latest-mac.yml` plus DMG/ZIP blockmap assets, while Windows feeds require `latest.yml` plus EXE blockmap assets. Do not let a draft or missing current-train target release break installed-client update feeds, and do not let one desktop platform's missing assets block the other platform's updater feed.
- CLI and daemon update checks prefer the manifest `version` before falling back to the release tag, so that value must match the downloadable target release version.

## Client Behavior

- Cross-Space Channel moves require a durable proposal and two separate Human
  admin acknowledgments. Web/native shells and CLI share that protocol; Agent
  drafts retain their existing Space scope and cannot acknowledge. Same-Space
  reparenting is unchanged. Tree, message and attachment scope commit together.
- Workstation approval cards distinguish queued delivery from locally recorded
  decisions and process completion. Exact Machine/host routing, durable terminal
  receipts and idempotent local execution keep retries from repeating commands.
  Owner-approved host commands use a clean environment and one-shot executor
  tickets without gaining Human Hub credentials.
- Production Hub deployment requires the protected catalog encryption key before
  deploying and verifies its binding afterward. Secret-free once approval remains
  independent of catalog availability. Recover existing keys before configuring
  this binding when retained encrypted data exists.

- Production releases apply the exact tag's pending PostgreSQL expand migrations
  on both existing shards before readiness and deployment. The runner rejects
  empty ledgers, changed history, pending contract migrations, and incorrect shard
  identities; transactional receipts make failed-job retries resumable. This
  restores the routine migration step missing from the 0.16.238 train.
- PostgreSQL message acknowledgments accept an omitted sequence without failing
  request hashing. When a summon parks its cursor by message ID, the transaction
  resolves that exact message within the authorized Channel and Space; later
  messages remain unread. A missing target or conflicting sequence fails closed,
  and replay preserves the original cursor result.
- Daemon-spawned Claude stream processes use the reviewed Agent Profile runtime
  from `XMATRIX_SPAWN_RUNTIME`, never the launcher/agent-type identifier. Spawn
  failures now include the exact executable name in diagnostics.
- Reborn reads the predecessor Instance's current authority version after the
  daemon confirms its stop. PostgreSQL no longer rejects cleanup with
  `expectedVersion is invalid`, and stale cleanup cannot terminalize an
  Instance that was rebound to another Run.
- Post-retirement Space authority routes are re-registered in the active route
  inventory before channel creation. This repairs a lost registry write even
  when the immutable retirement manifest already contains the Space route.
- Existing Space capacity routes receive the same active-registry repair before
  a new root channel is registered with its authoritative family.
- Brand surfaces that provide their own canvas use the transparent logo source:
  browser icons, in-app brand marks, and the Android adaptive foreground.
  Desktop and iOS app icons, Apple touch icons, PWA install icons, and social
  previews remain opaque because those consumers require or render a full
  background more reliably.
- A production version train runs CLI, Desktop, Android, and iOS publication
  from the immutable `xmatrix-v*` tag. Candidate checks retain job evidence,
  while production handoffs and downloadable assets use the reviewed R2
  release store instead of GitHub Actions Artifacts.
- Linux release orchestration bootstraps Node from the upstream `tar.gz`
  archive so minimal self-hosted runners do not need an external `xz` binary.
- Release-storage uploads uniformly reuse the existing S3 streaming uploader
  and `R2_RELEASE_*` credentials for every object size, including manifests,
  channel pointers, and receipts. There is no small-file Wrangler PUT fallback.
  Independent download/readback verification streams S3 GET responses with
  the same scoped credentials and a deadline covering headers and the full
  body. Partial reads are removed, and complete size/SHA-256 checks still gate
  publication. Read-only callers without S3 credentials retain the bounded
  workspace Wrangler path; configured S3 failures cannot switch transports.
- Native artifact handoff downloads verify the internal R2 manifest and every
  declared object before removing that transport-only manifest from the exact
  directory passed to strict CLI and Desktop content verification.
- Windows Desktop handoff uploads use native PowerShell environment access, so
  the staged release directory cannot be lost through Bash-style variable
  expansion under the Windows runner's default shell.
- Test Release reconnect smoke recovers the exact synthetic Channel when a
  transient create response is lost after commit. It accepts either an
  exhausted retryable response or a name conflict, waits for the committed
  winner to appear in the catalog, then continues through ordinary cleanup.
- Post-retirement Space and private-Space creation repairs an authoritative
  route whose active-registry publication was interrupted, so the first root
  Channel can finish its family registration instead of returning an opaque
  server error after commit.
- **0.16.0 Web migration notice:** the first authenticated browser/Web launch
  replaces its rebuildable local history replica and resynchronizes it from Hub
  authority. The browser must be online while that rebuild completes. Channel
  history is not deleted from the Hub; an interrupted rebuild restarts safely
  on the next launch instead of exposing a partial local history. This does not
  migrate the independent Rust or Desktop-native replica formats. Preserve
  this scope and notice in the `0.16.0` client release descriptions.
- The CLI can be updated manually with `xmatrix update` on macOS, Linux, and Windows. The Windows
  installer still rewrites any historical WScript/generation Scheduled Task to the exact stable
  `xmatrix.exe daemon` action and verifies that process before succeeding.
- A Windows in-place update must keep live Agent wrappers. The updater stops only `xmatrix.exe daemon`,
  renames the locked previous CLI aside when `File.Replace` cannot open the running image, writes the
  new stable binary, and starts the existing Scheduled Task. It must not stop `xmatrix-daemon` and must
  not require generation pointer activation on the official direct-task install.
- The daemon checks for updates periodically on every platform and uses the manager-specific atomic
  replacement and rollback path for that OS.
- Windows Agent broker proxies resolve the captured Profile's current loopback broker before
  forwarding requests, including when an old daemon port has been reused. They retain the original
  upstream Run capability, return a retryable 503 during replacement, and never replay a written
  request. Explicit adoption disables legacy discovery. Already-running older wrappers require an ordinary instance
  Reborn recovery into the fixed CLI; a daemon-only update cannot patch those processes.
- macOS CLI releases publish `xmatrix-macos-arm64` and `xmatrix-macos-x64`; the Apple Silicon release runner cross-compiles the Intel binary and signs both with the same Developer ID identity. `install.sh` installs the native arm64 binary when its shell runs under Rosetta.
- The macOS Desktop release builds one app per architecture (`arm64` and `x64`, never universal), each carrying its own architecture's CLI seed. One `latest-mac.yml` lists both; electron-updater picks the `arm64` files on Apple Silicon and the others on Intel, and its legacy top-level `path` stays on the arm64 ZIP.
- A Windows CLI release publishes the single portable `xmatrix-windows-x64.exe` artifact through the same reviewed,
  immutable R2 handoff as the other CLI platforms. The release manifest records the exact workflow provenance, size,
  and SHA-256; a Windows code-signing certificate is not required.
- The macOS and Windows desktop apps use the Electron updater feed, download updates in the background, and install downloaded updates on app restart. Automatic checks do not interrupt the user with a dialog; manual checks still report the result.
- macOS release builds fail closed unless both the built app and packaged updater ZIP satisfy the established Developer ID requirement: bundle ID `net.madebyrobot.xmatrix`, Apple Developer ID certificate chain, and Team ID `VWN9V9V56Z`. Adhoc, unsigned, invalid, or identity-drifted artifacts must never reach the stable or dev updater feeds because Squirrel.Mac cannot migrate installed clients across that boundary.
- The self-hosted macOS release runner downloads Electron and electron-builder binaries through their checksum-aware npmmirror endpoints and retains the binary caches and PNPM store between runs. CLI and Desktop installs share `.github/actions/macos-pnpm-install`, preserving the runner's proxy environment and registry selection with bounded fetch timeouts and retries. On the M1 release host, sing-box routes domestic mirrors directly using local DNS while other proxied requests retain the Singapore Alibaba Cloud route. Release and manual disk-cleanup jobs remove only validated current-checkout outputs; shared-store pruning requires an operator to drain all runners on that host first. See [macOS runner network and cache maintenance](operations/xmatrix-release-deployment-guide.md#macos-runner-network-and-cache-maintenance).
- Every Linux release job runs on the US machines: release validation on its own `xmatrix-release-test` runners, apart from PR CI, everything else — planning, builds, Hub and Web deploys, CLI and Desktop finalizers, post-CD archival, Test/Production brokers — on `xmatrix-us-release`. Do not retarget them to `local-linux-x64`: domestic Linux runners stall on `uploads.github.com` and R2. The former always-on `postgres-integration` CI partition is not a release gate.
- A user-initiated update failure remains user-visible through an actionable recovery dialog and application-menu manual download entry. In particular, preserve the manual-update context until Squirrel.Mac completes its asynchronous post-download signature validation; do not turn that failure into a silent return to “Check for Updates.”

When changing release behavior, update the relevant workflow, script, and this document together.
