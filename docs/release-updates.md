# Release Updates

## Unreleased: a first message's launch line shows it is working, and xMatrix's summon no longer quotes it

After sending a new conversation's first message, authors read the plain line under it as the system doing nothing. The line now arrives with the message and leads with a ring around the mark of whoever acts next: xMatrix's mark in a turning ring while it chooses, the picked Agent's mark in a ring that drains with the author's three seconds, and a turning ring again while it starts. While xMatrix or the Agent is at work a light sweeps across the words. "Change" and "Don't start" follow a divider in a quieter ink, and on a phone the line no longer wraps "Don't start" onto a second row. Reduced motion stops every animation.

When xMatrix started an Agent for a new conversation's first message, its `@<harness>` reply quoted that message in a large block right under it, so the author saw their own words twice before anything happened. The web now shows that summon alone: xMatrix, then the Agent's launch status. Web only; the Hub still records the reply. Recovery is a CI-validated beta reverting this change.

## Unreleased: one retention notice; records kept from results are the Customer's

Decided by Daniel on 2026-11-25. xMatrix, as the tool, deletes the original
results of a provider that bounds their storage (`resultRetentionDays`:
@gcp, @gmail, @google, @googlecalendar) at that age and on disconnect;
conclusions and records people or Agents write from them belong to the
Customer, who is responsible for them, and the product does not delete or
police Pages. Every such receipt and `xmatrix connector list` now carry one
neutral sentence: "The original result is deleted after 29 days, and at once
when the connection is disconnected. Whether records you keep from it comply
with the provider's terms is your responsibility." This replaces the
"do not copy into Pages or memory" wording and the per-provider
`resultRetentionMayKeep` added hours earlier. The Agent launch prompt and the
xMatrix skill ask Agents to keep conclusions with their source id, not copies of
results. Hub, protocol, CLI prompt and skill.

## Unreleased: Terms and Privacy state who owns records kept from connector results

Terms §10 and Privacy §12 (version 2026-11-25) state the split Daniel approved
on 2026-11-25: where a provider limits how long API results may be stored,
xMatrix deletes the original connector results at that limit (29 days today
for Google Cloud, Gmail, Google Docs/Drive/Sheets and Calendar) and at
disconnect; records the Customer, its members or Agents write from them are
Customer Data the Customer controls and is responsible for under that
provider's terms. Web only.
## Unreleased: Antigravity first-step acknowledgment, on-demand ACP images, and steered execution tracking

- **Immediate first-step and mid-turn Channel feedback + shorter turn tail**: tightened `channel-contract.md`, `steered_turn_input`, and Antigravity's native `_meta.antigravity.systemPrompt.append` note so Agents send a one-sentence acknowledgment in their very first step on multi-step work or mid-turn instructions and end immediately after `xmatrix send --final-for` instead of writing a duplicate local closing summary.
- **On-demand image reading for Antigravity ACP and preserved steered attachments**: Antigravity ACP now delivers materialized local attachment paths in prompt text (`inline_prompt_images: false`) instead of eagerly base64-inlining every screenshot into `session/prompt`, avoiding long-session media bloat and double ingestion; both ACP and Claude mid-turn steering now materialize and forward inbound attachments instead of dropping them, and non-steering ACP vendors no longer mutate execution sources before declining a steer.
- **Steered execution completion in PostgreSQL**: `recordMessageExecutions` now allows append-only source additions on non-terminal executions while preserving source immutability and terminal fencing, fixing steered turns that previously stayed stuck in `accepted` and dropped steered source rows.

Hub (`@xmatrix/db`, bootstrap prompts) and CLI / daemon; no schema migration. Recovery is a CI-validated beta reverting this change.

## Unreleased: Workspace receipts say what may be kept

The retention notice on Gmail, Google Docs/Drive/Sheets and Calendar receipts
told Agents not to copy results into Pages or memory at all, stricter than
Google's Workspace AI Tools Addendum, whose 30-day bound covers Google
Technical Information, not user data. A manifest can now declare
`resultRetentionMayKeep`; the Workspace connectors say lasting notes may keep
the business facts a task concluded (an amount, a date, a status) with their
source id, never the retrieved text. `@gcp` keeps "do not copy": Google
Cloud's §17 counts costs, IAM and architecture conclusions as technical
information. Protocol and Hub only.

## Unreleased: Google Docs/Drive/Sheets and Calendar reach Google's Workspace MCP servers

From 2027-02-01 Google's Workspace AI Tools Addendum has AI agents reach
Workspace data through Google's official Workspace MCP servers; agents still
calling the REST APIs are held to Standard quotas. `@google` and
`@googlecalendar` gain three actions over those servers with the connection's
own OAuth token: `mcp_tools:<server>` lists the live tools with their input
schemas and Google's read-only marking, `mcp_read:<server>/<tool> {json}` calls
a tool Google marks read-only, and `mcp_write:<server>/<tool> {json}` calls any
other under the app's write permission (so `ask` approves each one). Servers:
`docs`, `drive`, `sheets`, `slides` for `@google` and `calendar` for
`@googlecalendar`. Google answers only once the company connector client is
marked "AI-powered agent" and the MCP services are enabled on its project;
until then these actions report Google's refusal and the existing REST
actions keep working unchanged. Hub only.

## Unreleased: App Store Connect and Google Play Console operational analytics actions

Agents and operators can now query App Store and Google Play operational metrics directly from Channels without leaving xMatrix or adding new Google OAuth consent scopes:

- **App Store Connect (`@appstoreconnect`)**: added `analytics` (downloads and aggregates gzipped Apple Analytics Reports TSVs using the existing API key alone — no vendor number needed — covering discovery impressions/page views/conversion/sources, downloads, installs/deletions, sessions, crashes, purchases and subscriptions, with strict Apple/S3 segment host allowlisting and zero credential forwarding to pre-signed URLs), `enable_analytics` (idempotently creates an `ONGOING` or `ONE_TIME_SNAPSHOT` Analytics Report Request), `metrics` (Xcode `perfPowerMetrics` launch/hang/memory/battery/disk/termination metrics and regression insights), `subscription_reports` (daily `SUBSCRIPTION`, `SUBSCRIPTION_EVENT` and `SUBSCRIBER` reports), and `finance` (monthly settled `FINANCIAL` reports by region or `ZZ`).
- **Google Play Console (`@googleplay`)**: added `vitals` (Android Vitals overview and daily crash/ANR/slow-start/slow-rendering/LMK/wakeup/wakelock/error trends sliced by version, API level, device or country via the existing `playdeveloperreporting` OAuth scope, clamped to Play's `freshnessInfo`), `error_issues` (top grouped crash/ANR clusters), `anomalies` (Play-detected metric anomalies), `reviews` (recent customer reviews with rating distribution and `unanswered` filter), `voided_purchases` (refunded/cancelled/charged-back orders and subscriptions), and `store_reports` (reads Play Console `pubsite_prod_rev_*` Cloud Storage CSV exports including UTF-16LE files for installs, store performance, ratings, crashes, sales, earnings and subscriptions using optional `reportsBucket` and `reportsServiceAccount` credentials without changing Google OAuth scopes).

Hub and protocol only; no schema migration. Recovery is a CI-validated beta reverting this change.

## Unreleased: Gmail, Google Docs/Drive/Sheets and Calendar results expire at 29 days

Google's Workspace AI Tools Addendum (from 2027-02-01) lets data an AI tool
reads from Workspace be processed only for the user's active task and never
kept after the tool is disconnected; Google Cloud's §17 already bounded @gcp.
`gmail`, `google` and `googlecalendar` now declare `resultRetentionDays: 29`,
so the Space retention clock that expires @gcp results expires theirs too:
receipts and inbound events become tombstones, execution summaries clear, and
private originals are collected at once; disconnecting deletes everything.
Gmail notification reads stored privately (owned by the event message,
`app:gmail:…`) are now matched as well; before, only receipt-owned originals
(`…:<app>`) were. Results stored before this release expire when the Space's
clock next runs (any retained-provider call, private result or routing
decision arms it). Removing a single Gmail mailbox, rather than disconnecting
Gmail, does not yet delete that mailbox's earlier results; the 29-day bound
still applies. Hub only; no schema or client change.

## Unreleased: code scanning leaves the release train

Every release train waited for its CodeQL analysis to finish before it
dispatched the release, although the analysis only files code scanning alerts
and never decided whether a train shipped. On a Web beta the JavaScript and
TypeScript server half took about three minutes, longer than the gates beside
it (about one and a half), so it set the pace of the train. Code scanning now
runs from its own workflow, `.github/workflows/codeql.yml`: each push to `main`
scans Hub, Web and Desktop JavaScript and TypeScript and the workflows, and a
daily run scans every language, Rust, Kotlin and Swift included. A running
scan finishes, and only the newest waiting push is scanned next. Alerts land in the same code scanning
categories as before. No release train, beta or stable, waits for a scan.
Decided by Daniel on 2026-11-24. CI only; no product, schema or client
change. Recovery is a CI-validated change that makes the train's `gates` need
a scan again.
## Unreleased: the release train builds the Web beside its gates

A Web release ran in two serial halves: the train's gates (about four
minutes), then, only after the tag, the production Web build (about three and
a half), then the deploy. The build mutates nothing a user can reach, so the
train now runs it beside the gates (`web-prebuild` in
`production-release-request.yml`, the same `build` job of
`server-release.yml`), and stores the bundle under the exact release commit
(`handoffs/web-prebuilt/<commit>/<attempt>/bundle`). The tagged release looks
for that bundle first and reuses it only when its checksums and its recorded
commit verify; when there is none, or it does not verify, the release builds
its own exactly as before. The train dispatches the release once both the
gates and the prebuild have finished, whatever the prebuild's result. Nothing
deploys before the gates pass and the tag exists: only the tagged `web` job
deploys, and it still re-verifies the exact request, scope and commit.

The prebuild needs the production build configuration, so the `production`
environment now also admits the `main` branch (it admitted only `xmatrix-v*`
tags); every job that deploys still requires a tag ref in its own condition.
Approved by Daniel on 2026-11-24. Expected effect: about three minutes less
from merge to a live beta Web. CI and release infrastructure only. Recovery is
a CI-validated revert, after which the `main` rule can be removed from the
environment.
## Unreleased: a conversation follows a workflow run, so Agents stop polling GitHub

Every Agent on every machine calls `gh` with one owner's token and shares its
5,000-an-hour REST quota. `gh run watch` asks every three seconds (about 40
calls a minute), so a few Agents watching CI and release trains ran the quota
out within the hour. `xmatrix channel subscribe` now also takes a workflow
run's URL (`https://github.com/<owner>/<repo>/actions/runs/<id>`): the Hub
keeps a `workflow_run` source relation (migration 0272 allows the kind), posts
the run's verdict once when its `workflow_run` webhook completes, wakes the
conversation's resting Agents and ends the relation. A run that already
completed is answered with its conclusion and not followed; reading the run
uses the GitHub App's `actions: read`. The Channel contract now tells Agents
never to poll GitHub and to subscribe instead. Hub, schema (expand only) and
CLI change; an older CLI keeps subscribing pull requests as before.
Recovery is a release reverting this change; the migration only widens a
CHECK.

## Unreleased: the Hub suite runs as eight shards

A pull request that reaches the Hub runs the complete Hub suite (#2079). With
four shards each took 3 min 35 s to 4 min 38 s, about a minute of it setup
and build, and was the pull request's longest job by two minutes. The suite's
459 files are now split by recorded duration into eight shards
(`XMATRIX_HUB_TEST_SHARD=<n>/8`), which halves each shard's share of the
tests; release trains use the same layout. Every file still runs exactly once
and no assertion changes. A Hub pull request or train now holds nine hosted
jobs instead of five. CI only. Recovery is a CI-validated revert to four.

## Unreleased: a pull request that reaches the Hub runs the Hub suite before merge

From 2026-11-17 to 11-24, 65 release trains failed their gates, and 53 of them
(82%) failed on the Hub suite: the one train gate a pull request never ran.
A change that broke it merged green, failed the next train after seven to
twelve minutes, and held every change riding that train until someone fixed
main; on 2026-11-24 eight trains in a row failed that way between 20:15 and
21:05 UTC. A pull request whose diff reaches the Hub (`packages/hub`,
`packages/db`, `packages/protocol`, the Agent prompts or a shared root file)
now runs the complete Hub suite, the static job and four shards, in place of
`hub-check`; its typecheck and deploy bundle are part of the static job. Such
a pull request takes about four to five minutes instead of three; one that
does not reach the Hub is unchanged.

The CI ledger now records what a pull request ran in full. Its `node-tests`
entries run the same two partitions as a train's `node-checks`, and its Hub
jobs are the train's own, so a train of the exact tree that pull request
tested reuses both instead of running them again. When main moved between the
pull request's run and its merge the tree differs and the train runs them
itself. The Web and Rust jobs of a pull request remain subsets under other
names and vouch for nothing. No gate or assertion is removed. CI only; no
product, schema or client change. Recovery is a CI-validated revert restoring
`hub-check` and the unledgered names.

## Unreleased: a message sent to a working Antigravity joins its turn instead of cancelling it

Claude's turns took a Channel message that arrived mid-turn as more input to
the running turn; an ACP harness had no such path, so the same message
cancelled Antigravity's turn with `session/cancel` and the work restarted
after it, and messages that did not cut the turn waited for it to end, which
left the Agent's later sends behind the Channel. `agy acp` joins a
`session/prompt` sent while a turn runs to that turn without interrupting the
running tool (measured on 1.5.16: a `sleep 25` kept running and the answer
quoted the joined message); it answers the earlier prompt `end_turn` at once.
The ACP runtime now sends such a message as another `session/prompt` and ends
the turn only when its own prompt and every joined one have answered, as it
does for Claude. Only Antigravity is opted in; other ACP harnesses are
interrupted as before. CLI runtime only, no Hub, schema or protocol change.
Recovery is a release reverting this change.

## Unreleased: build both macOS CLI architectures on one Apple Silicon runner

After #1880 moved hosted `macos-x64` CLI builds onto `macos-26`, requesting two
concurrent `macos-26` VMs per release (and per `cli-release-cache.yml` push)
hit GitHub's hosted Apple Silicon pool capacity: 6 of 46 CLI releases (including
four consecutive `web,cli` releases on 2026-11-24, `4.11.1-beta.18`–`beta.21`)
failed because the second `macos-26` job sat unallocated for 15 minutes and was
cancelled while the first `macos-26` job finished in ~2 minutes. Both
`cli-build.yml` and `cli-release-cache.yml` now build `aarch64-apple-darwin`
(`macos-arm64`) and `x86_64-apple-darwin` (`macos-x64`) sequentially on a single
`macos-26` VM, resetting the ephemeral `kache` store between targets via
`.github/scripts/reset-kache-store.sh` so each target retains its full per-part
cache budget without cross-eviction (self-hosted runners keep their persistent
store untouched). Both binaries still undergo isolated Developer ID signing,
`verify-macos-cli-signature.sh`, `lipo -archs` architecture checks, exact
`--version` verification (via Rosetta `arch -x86_64` for Intel), and separate
R2 release-part uploads (`macos-arm64` and `macos-x64`). CI / release
infrastructure only; no binary format, signing identity, or client behavior
change. Recovery is a CI-validated forward release restoring separate matrix
entries (or moving `macos-x64` to `macos-26-intel`).

## Unreleased: Google Cloud results are deleted at 29 days and at disconnect

Google Cloud's General Service Terms §17 (GCP Access Tools, effective 2027-01-01) forbid keeping information obtained through its APIs, such as costs, IAM and architecture, for more than 30 days or after the tool is disconnected. `@gcp` receipts were Channel messages kept forever, execution summaries kept their first 1,000 characters, and private originals stayed in storage for up to 61 days. A provider manifest can now declare `resultRetentionDays`, and `gcp` declares 29. The Space's retention clock, the one that already expires private results, deletes what the provider returned at that age. Receipts and Monitoring incident messages become delete tombstones, execution summaries and reasons are cleared, and private originals are physically deleted right away, without the 31-day upload safety window. Disconnecting Google Cloud deletes all of it at once. A connected Space keeps using it without reconnecting; only results older than 29 days disappear. Receipts and `xmatrix connector list` tell Agents not to copy results into Pages or memory. Results already past 29 days are deleted once the new Hub runs. Hub/DB only, no migration. Recovery is a CI-validated beta reverting this change; tombstoned results cannot be restored.

## Unreleased: Agent registration catalog scans recent Instances once and deduplicates shared catalogs

`registration_catalog_page_v9` was the highest-cost non-auth query on production PostgreSQL (6,091 calls / 1,054 s over 24 h, p95 705 ms, 38,591 shared buffer hits per call on the largest Space): its per-registration `LATERAL` probed all ~10.3k historical `run_agent_registrations` rows into `data.instances` to find the ~189 Instances updated in the last 48 hours, repeatedly detoasted `presentation_json`, and shipped identical model and parameter catalogs on every registration row. Expand-only online index migration `0270_expand_instances_updated_at_index.sql` adds `instances_updated_at_idx` on `data.instances (updated_at DESC)`, and `registration_catalog_page_v10` hoists the 48-hour scan once per page, extracts catalog fields in a single `jsonb_to_record` pass per recent row, and ships each distinct model/parameter catalog once per page by SHA-256 digest before rehydrating in `PostgresAgentRegistrationRepository.list()`. On the same production read-only repeatable-read snapshot, all 32 registrations matched field-for-field with zero differences while shared buffer hits fell from 38,591 to 2,776 (-92.8%), execution fell from 64–68 ms to 9.7–11.5 ms, and wire bytes fell from 101.9 KB to 76.5 KB (-25%). Hub/DB only; the online index is additive and rollback is a CI-validated beta reverting the query.

## Unreleased: channel history names each attachment the way commands take it

`@x:publish_video` and a program's `X.prepareVideo` take a Channel video as `<message id>/<attachment id>`, but `xmatrix channel history` printed an attachment's id only when it had no local copy: once the CLI had downloaded the file into its cache, the line showed the local path and nothing else, so an Agent that had just sent the video could not name it. Every attachment with an id now carries a `ref: <message id>/<attachment id>` line. CLI only. Recovery is a CI-validated CLI release reverting this change.

## Unreleased: a handoff that took over still shows the successor its author wrote

A handoff written with conditions, such as `@grok:1:handoff:@model:claude-fable-5-2`, showed the written model on its card only while it was in flight. Once the successor's record arrived the card redrew the successor as its bare name (`@claude · Took over`), so the model the author asked for and the parameters xMatrix picked disappeared from the conversation. The recorded card now reads the stored mention back and keeps drawing the successor as written, each condition marked, followed by the picks of the successor's launch, the same way the in-flight card does. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: the card a shared link shows carries the site's title and its own address

The card a link to the site shows when it is shared still read "Living pages
maintained by your AI agents" and "xmatrix.sh": a line the site dropped, and
the app's domain where the site's is xmatrix.page. It was an image drawn once
by hand, so nothing redrew it when the words changed. `node
scripts/share-card.mjs` (apps/web) now draws it from where the words are
decided, the English page title and the production site origin, and the image
carries the words it was drawn with; a test fails when they are no longer the
site's, or when the card's alt text says something else. The card now reads
"xMatrix", "Multi-agent collaboration around live documents" and
"xmatrix.page" over the same block art. Networks that have cached the old card
keep it until they fetch the page again. Web only. Recovery is a CI-validated
beta reverting this change.

## Unreleased: the comparison's panels stay inside a phone's screen

On a phone each row of the homepage's comparison is one column, and that
column took its width from what its scenes held. A scene's widest line changes
as it plays, so for most of each eight-second loop a row's two panels were
wider than the screen: 116 px past their row at 393 px wide and 189 px at 320,
the paper cut at the screen's edge with no margin on its right. Each time the
width changed, the captions under the scenes wrapped differently and
everything below moved by a line or more. The row's column is now as wide as
the row whatever its scenes hold: panels end inside their row at every width,
the section keeps one height while its scenes play, and scrolling the page on
a phone no longer shifts its layout (0.06 before, by Chrome's layout-shift
measure). 600 px and wider are unchanged. Web only. Recovery is a
CI-validated beta reverting this change.

## Unreleased: the homepage's demos mount as they near the screen, and the live page's sheet keeps one height

The homepage's three stages are the app's own components, and all three were
fetched and run with the page, whether or not a visitor scrolled to them. Each
now mounts when it comes within one screen of the window, and its frame holds
its place from the start. On a phone throttled to a quarter of its CPU and
8 Mbit/s (median of five loads of a local production build) the main thread is
blocked for 1.7 s before any scrolling where it was 2.4 s, and 774 KB of
script is fetched where it was 1122 KB; the work for a stage further down is
done on the way to it. The live page's sheet also grew and shrank as its
Agents wrote, by 84 px on a phone, moving everything under it on each pass of
the demo. It now keeps the height of its fullest state at every width (checked
at sixteen widths from 320 to 1920 px), and the Agents matrix's stage holds
the height of the matrix it shows. Web only. Recovery is a CI-validated beta
reverting this change.

## Unreleased: Chinese homepage slogan updated to 「注意力就是一切」

Updates the Simplified and Traditional Chinese homepage slogan (`hero.slogan`, shared by the hero and closing plank) and OpenGraph/Twitter `shareDescription` in `apps/web/src/lib/landing-copy.ts` from 「拯救你的注意力」 to 「注意力就是一切」. Web only; recovery is a CI-validated beta reverting this change.

## Unreleased: a page of the site at xmatrix.page no longer asks the Hub for a session

Every page of the site mounts the app's auth provider, which reads the session
from the Hub. At the site's own origin that read cannot succeed: the session's
cookie does not reach xmatrix.page and the Hub does not answer it, so the
browser blocked each reply. The provider took the blocked read for a passing
failure and tried again for as long as the page stayed open, backing off to
once every 30 seconds, so every page of the site logged CORS errors and kept
sending the Hub requests it refuses. A page at the site's own origin is now
signed out without asking; xmatrix.sh, and a deployment whose site and app
share one origin, read the session as before. Web only, no API or schema
change; recovery is a CI-validated beta reverting this change.

## Unreleased: the site's beta answers at beta.xmatrix.page

The site lives at xmatrix.page, but a beta of it could only be read at
beta.xmatrix.sh, the beta app's address, so a change to the site was reviewed
under a domain that is not the site's. The beta Web now also serves the
marketing site at beta.xmatrix.page (`web.beta.siteOrigin`), arranged as
xmatrix.page is beside xmatrix.sh: the site's pages answer there, the beta
build's canonical URLs name it, and any other path, the app and sign-in among
them, goes to beta.xmatrix.sh with a temporary redirect. Like every beta origin
it stays out of search: its robots disallows everything and its pages answer
`noindex`. The Hub does not trust it; the stable Web, xmatrix.page and the
session cookie are unchanged. Beta Web only, no API or schema change; recovery
is a CI-validated beta without `web.beta.siteOrigin`.

## Unreleased: revised homepage copy across all six published locales

Rewrote the homepage copy in `apps/web/src/lib/landing-copy.ts` across all six
published locales (`en`, `zh`, `zh-tw`, `ja`, `ko`, `es`) to align with the
live-document multi-agent collaboration positioning: updated hero sub-links,
live-document and conversations sections, multi-machine agents matrix framing,
comparison table rows, connectors, pricing copy, FAQ answers, footer tagline,
and SEO/share metadata (keeping English title <= 62 chars and description <=
158 chars), plus updated `apps/web/e2e/site-home.spec.ts` and `shareImage.alt`.
Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: the homepage shows the product running and leads to the App on every device

The homepage was a Hero, a marquee of twelve agent chips and separate sections
whose headings sat left or centred by turns, a tall gap between each; a phone
saw the action below its first screen and no picture at all in the live-page
section. It is now the Hero, sized to its art so what follows shows in the
first screen, and three stages that are the app's own components fed a sample
Space: a live page written by three Agents, with the iPhone beside it on a
desktop in the conversation about the same project and the App Store and Google
Play badges over it; the Mac window; and the Agents matrix (machines by agents)
over every agent `agent-presets.json` holds, where the marquee named twelve by
hand. The comparison, connectors, pricing and questions keep their content on
one heading scale and one rhythm; the page closes on a wood plank with the
download for this device, and the footer is paper, with no slab and no rules.
Under the Hero's action one sentence links the App's other platforms and the
browser. The Chinese pages carry the slogan in Chinese. The guides for AI
agents (`download.md`, `index.md`, `llms-full.txt`) name the iPhone and iPad
app and Google Play. New styling is utility classes on the elements; the
stylesheets' rule count falls from 2206 to 2191. Web only. Recovery is a
CI-validated beta reverting this change.

## Unreleased: iOS composer attachment menu morphs in place and opens native pickers directly

Tapping the paperclip button in the iOS app previously clicked a hidden `<input type="file" multiple>`, triggering WebKit's `WKFileUploadPanel` popover: with the keyboard open it stayed anchored mid-screen after the composer dropped to the bottom, and with the keyboard closed it morphed as a separate circular glass popup overlapping the composer pill. `ComposerInputAuthority` now runs its single-surface glass height morph for external panels (`ComposerAttachmentPanel` and `ComposerInputHistoryPanel`) as well as completion overlays, reads live animated height on mid-flight interruptions, and retains the closing panel inside the shrinking glass while retracting. On iOS shells advertising `nativeAttachmentOpenPanel`, the composer capsule morphs upward to show Photo Library, Take Photo or Video, and Choose Files aligned over the paperclip column; selecting a source coordinates through a page-wide open-panel input (matching WebKit's per-WebView mutex so closing New Conversation mid-fetch still settles `change`/`cancel` and unlocks later composers while holding Send only on the originating draft) and triggers `WKUIDelegate.webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)` directly via `PHPickerViewController`, `UIImagePickerController(.camera)`, or `UIDocumentPickerViewController`, handing disk-backed `URL`s straight to WebKit with fail-closed staging capacity (256 files, 64 per batch, user-facing alerts on truncation/full storage) and draft-generation/revision checks. Unarmed file inputs (such as profile avatar selection) show a native action sheet; desktop, mobile Safari, and older iOS shells fall back unchanged. Web and iOS. Recovery is a CI-validated beta reverting this change.

## Unreleased: a first message's launch choice is one line of text, and choosing is no longer a race

Under a new conversation's first message the web drew a brass card listing every Agent of the Space as a pill, with "Don't start" and a draining rule. It is now one sentence on the paper: "Choosing an Agent…", then the Agent xMatrix picked and the seconds left, with "Change" (or "Pick one") and "Don't start" as words at its end. No Agent is listed until the author asks. "Change" opens the app's paper menu and records "start nothing" first, so the three-second window can no longer start an Agent while the author is choosing; the Agent picked there is the author's own `@<harness>` message, and the menu's last row puts that summon in the composer, where model, effort, machine and repository are written with the composer's completion. A line that says no Agent started keeps "Ask an Agent". Once anything follows the message the line is gone, because the summon already shows the launch and whose it was. The "No Agent was asked" line of a named conversation uses the same sentence and menu. The Hub is unchanged.

## Unreleased: workspace search filter chips support keyboard deletion and bounded truncation in the original single-row UI

Workspace search keeps its original single-row inline filter chip UI while fixing filter deletion and long-title overflow: pressing `Backspace` at the start of the query input removes the last filter chip without erasing typed text, `ArrowLeft` at the start of the input selects chips for `Backspace` / `Delete` removal, focused chip `×` buttons also accept `Backspace` / `Delete` and return focus to the input, long filter chips truncate inside the field so the query input stays usable on desktop and mobile, and `.app-search-overlay` / `.app-search-panel` keep `-webkit-app-region: no-drag` so desktop top-bar drag regions never swallow clicks. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: Google Play Console creates a one-time product in one command

`@googleplay:one_time_product` creates a one-time in-app product with its
title, description and price: the named region keeps exactly the stated
price, Google converts it for every other region, and the purchase option can
be activated in the same step. Setting up a "remove ads" purchase for a new
Android app needed the Play Console website, because the catalog write of
every regional price does not fit a command. Hub and protocol; no schema
change. Recovery is a CI-validated beta reverting this change.

## Unreleased: public site pages are prerendered, with valid structured data and direct app links

An Ahrefs audit of xmatrix.sh and xmatrix.page found 37 slow pages. Each one was a localized page, a `/docs` page or a `/<slug>-alternatives` page: the Worker rendered them on every request and a cold isolate took 1–2 s. All of them are now prerendered at build: 6 locales × (home, download, support, 10 guide pages, 19 competitor pages). The build fails if a representative page of each kind stops prerendering. The 114 competitor pages and 6 homes no longer carry a `SoftwareApplication` node without ratings, which Google reported as 120 rich-result errors. Site pages on xmatrix.page link to `/app`, `/login`, `/console`, `/billing` and `/account/delete` on the app origin directly instead of through a 302. The footer's Perplexity link goes straight to `/search/new`. Search descriptions and titles that results cut off are rewritten to fit: 47 descriptions over 160 characters and 9 Spanish guide titles. The `/support` titles now say what the page helps with. Web only. Recovery is a CI-validated beta reverting #1994.

## Unreleased: message video attachments respect their original aspect ratio

Inline video attachments in the conversation timeline previously used a fixed 16:9 full-width box (`aspect-video w-full`), adding black pillarboxes around portrait videos and letterboxes around ultrawide videos. `MessageVideoAttachment` now sizes the video container to the attachment's aspect ratio within the column width and `28rem` max height, using stored attachment `width`/`height` metadata immediately to avoid layout shift and falling back to decoded `videoWidth`/`videoHeight` on `loadedmetadata` (cached per channel media store across virtualized remounts). Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: registration lists read the settings they display

The Agents catalog previously transferred launch instructions and workspace and capability grants even though it only uses model settings and model grants. It now selects the fields the catalog needs, and picks the newest model and parameter observations from one pass over each registration's recent Instances. Models and parameters retain their own observation times and ordering. Detailed configuration and launch admission continue to read their authority records. Hub and DB code without a schema migration. Recovery is a CI-validated Hub beta reverting the change.

## Unreleased: Pages read only the Agent details they display

Page links and tree activity fetched full Agent Instance catalogs and then discarded resting Instances. They now read just the display fields of active Instances. Discussion summaries need only message previews and read positions. Page links check access on the linked pages and their ancestors. In the November 21–22 production baseline, the replaced reads returned about 1 GB per day from PostgreSQL across those endpoints. Hub and DB code without a schema migration. Recovery is a CI-validated Hub beta reverting the change.

## Unreleased: one page's access check reads its ancestors, not every page of the Space

Every page request (a read, a section update, a conversation's edits) checked access by reading a row for every page in the Space, about 22 KB for a Space of 240 pages, some 35,000 times a day. Access is inherited from ancestors alone, so a check for named pages now reads those pages and their ancestor chain (`page_chain_access_v1`, a recursive read by primary key) and resolves access over that chain exactly as before; reads that need every readable page (the tree, search, link lists) keep `page_tree_access_v3`. A Space past the page limit no longer refuses a single page's read. Recovery is reverting the change.
## Unreleased: finding a conversation and attaching a file no longer read every Channel of the Space

`xmatrix channels --find <words>` asked the Hub for the complete Channel list and filtered it in the terminal, and sending a file from a terminal read the same complete list to learn one Channel's mode and Space. In a Space of about 3,600 Channels each of those is 18 list pages with every resting Agent record, about 9 MB from PostgreSQL, and the instructions every Agent starts with tell it to find conversations this way. `GET /api/channels` now takes `find`: the list query (`channel_list_v10`) keeps only the readable Channels whose name, topic or summary holds every word, whatever the case, the same rule the CLI applied. The CLI sends the words and still applies the rule itself, so it reads the same result from a Hub that does not filter; an attachment send reads the one Channel's family (`familyOfChannelId`) for its scope. A read that names words takes the complete-catalog path, not the sync-token one. Recovery is reverting the change.

## Unreleased: what waits on a person is read on its own, not through the whole Channel catalog

The Chrome extension's badge asked the Hub for the complete Channel catalog once a minute to count the conversations that wait on the signed-in person. In a Space of about 3,600 Channels each of those reads paged every Channel row, every resting Agent record, and then resolved every Channel's full row again 200 at a time only to keep its attention summary: about 17 MB from PostgreSQL per read, roughly 1 GB an hour from one installed extension, and the largest single source of database egress since 2026-11-22. `PostgresChannelCatalogRepository.attention` (`channel_catalog_attention_v1`) now reads the principal's own attention rows and returns one summary for each readable Channel that still has any (a few kilobytes for the same Space). The complete catalog read (`GET /api/channels`) uses it once per Space in place of the 200-Channel resolves, with the same summaries on the same rows; `GET /api/channels/attention` answers the attention snapshot alone for a signed-in person, and the extension badge reads that. A Space whose attention cannot be read is marked incomplete, as before. Recovery is reverting the change; nothing is stored differently.
## Unreleased: a program asks a connected app, approved ahead and run on time with no agent

A Norn program can now have a connected app do something by itself: it *prepares* an action, which fixes the account and content and has it admitted under the app's one permission, and *performs* it later, once, at whatever time or event the program waits for. Under **Ask first** a Space admin answers the frozen request in the conversation's Pending approvals ahead of time, seeing the account, text and attachment; approving sends nothing. When the program gets there the Hub runs the action through its durable executor and the program reads the receipt. No agent is started, so a batch of posts approved in one sitting goes out on its schedule while every agent sleeps. The built-in `X` library gives X's posts their words (`X.preparePost`, `X.prepareVideo`, `X.publish`), and any other app's action is asked for by name with `Actions.prepare` and `Actions.perform` (Norn `Actions`, norn-lang/norn#55).

What was approved is read again when it runs: the approver must still be an admin who reads the conversation, the connection and the X account must be the ones approved, and the permission is read once more immediately before the provider is called. A prepared action runs at most once, an unknown outcome is reported as failed and never retried, an approval is good for 30 days, and a program that ends voids approvals it never used. Expand migrations `0268` (`norn_requests.host_due_at`) and `0269` (the `approved` state and the program references on `app_connector_action_requests`).

## Unreleased: X publishes a post with its video in one approved action

`@x:publish_video:<account> {"text":"…","video":"<message id>/<attachment id>"}` uploads one MP4 attachment of the conversation and publishes it with the exact text under a single approval. The video is uploaded when the post is published, so an approval no longer expires with a one-hour upload receipt. Nothing is posted when the attachment changed, X fails the video, or processing does not finish within the action's bound; an uncertain result is reported as failed and never tried again.

## Unreleased: a new person's message in the welcome conversation is answered

A person with no agent who wrote in their welcome conversation without naming anyone got no reply: the "connect a computer first" answer only read a conversation's first message, and the welcome conversation's first message is xMatrix's own setup step. That message now gets the same `connect-agents` step, once per conversation, as a new conversation's first message does. Someone with an agent, and every other conversation, is unchanged. Hub only. Recovery is a CI-validated beta reverting this change.

## Unreleased: competitor alternative pages factual audit, verified source footnotes, 8-link footer, and sitemap lastmod

Audited all 19 competitor comparison landing pages across all 6 published website locales (`en`, `zh`, `zh-tw`, `ja`, `ko`, `es`): aligned every H1 with xMatrix's core living-Pages positioning plus each competitor's real top gap, removed ambiguous cloud-VM wording, updated counts to 35 coding harnesses and 35 connected apps, removed inaccurate "GitHub Ask-first" claims, aligned iOS/mobile wording with `/download` (native macOS/Windows/Android plus Web including iPhone & iPad), included Free's 500 lifetime writes per Space in all CTAs, trimmed quota-handoff over-emphasis off non-quota pages, added verified HTTP-200 clickable source links under every pain point, unified Simplified Chinese terminology (`活页面`), tightened the site-wide footer to 8 flagship comparisons (with all 19 reachable within 2 hops), and added `dateModified` to `WebPage` JSON-LD plus `lastModified` to `sitemap.xml`. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: ACP PR activity reporting, milestone Channel contract, and ACP resume trusted rules

ACP runtimes (Antigravity, Grok, OpenCode, Cursor, Kimi) now feed shell `gh pr create` tool calls into the shared `ChannelActivityReporter` (during turns and between-turn background updates) so pull requests opened by ACP Agents emit the same `Opened pull request` activity entry and auto-subscribe the conversation as Codex and Claude Code. The shared `channel-contract.md` now names `xmatrix channel edit-message <channel> <id>` and explicit multi-step milestones (PR opened, CI failed/fixed, merged, next item), while Antigravity's native `_meta.antigravity.systemPrompt.append` carries an Antigravity-only note clarifying that built-in turn-batching reminders never override Channel milestone reporting. ACP `session/load` and its fallback to `session/new` (plus restarts) now retain `trusted_rules` on resumed sessions instead of dropping them to `None`. Hub (bootstrap prompts) and CLI / daemon. Recovery is a CI-validated beta reverting this change.

## Unreleased: quota waiter recovery uses per-pool locks and durable resumable pool reconciliation

Pool quota observations, usage-limit/billing holds, wait registrations (`waitForRegistrationQuota`), and waiter reconciliation now serialize per pool under a deterministic `(owner_user_id, quota_pool_id)` advisory lock order without blocking unrelated pools or requiring an observation row to exist yet, eliminating the concurrent registration/observation lost-wake race. A new `control.registration_quota_pool_reconciliations` ledger (expand migration `0267`) persists each pool's observation revision, reconciliation obligation, and resumable `reconcile_cursor_channel_id`, replacing the owner-wide 128-row prefix scan so exhausted sibling pools cannot starve recovered pools and 129+ waits on one pool drain across bounded DB-only pages (`reconcileOwedRegistrationQuotaPools` and `deliverQuotaWakes`) without extra provider requests, including automatic bounded repair of pre-migration unready waits. DB and Hub. Older Hubs ignore the new table while draining. Recovery is a CI-validated beta reverting this change; the new table is left unused.

## Unreleased: Norn outside events record durable per-program delivery obligations and isolate webhook effects

Outside events reaching Norn (`occurNornEvent`) now scan waiting programs in bounded keyset pages, record durable per-program delivery obligations in `data.norn_event_deliveries` (expand migration `0265`) before attempting immediate delivery, and isolate per-program failures so one blocked program cannot starve later programs or suppress other webhook/drain effects (GitHub, Gmail, Sentry, App Store Connect commerce, and native rooms). Owed deliveries remain due in `NORN_CHANNEL_DUE_SQL` and are retried independently through the Channel coordinator (`reconcileNornPrograms`) in bounded pages with current Space-role and app-grant rechecks and exponential backoff. DB and Hub. Older Hubs ignore the new table while draining. Recovery is a CI-validated beta reverting this change; the new table is left unused.

## Unreleased: Gmail upload snapshots use durable cleanup leases and bounded expiry reconciliation

Temporary Gmail upload snapshots staged in R2 now reserve an exact-key cleanup lease in `control.connector_mail_snapshot_leases` (expand migration) before `put` and release or transition that lease to `delete_pending` with bounded exponential backoff when immediate deletion fails, keeping confirmed Gmail send outcomes intact without retrying external sends. A bounded, resumable keyset reconciler (`reconcileMailSnapshotLeases`) runs in the minute cron's network lane to delete expired abandoned snapshots and retry failed deletes by exact `connector-mail-snapshots/<token>` key without touching general attachment objects. DB and Hub. Older Hubs ignore the new table while draining. Recovery is a CI-validated beta reverting this change; the new table is left unused.

## Unreleased: quota window holds and refusal attribution live once in protocol

`packages/db/src/agent-registration-quota-probe.ts` previously re-derived the 31-day exhausted window hold, remaining headroom, and 2-second reset-time matching in SQL (`keptExpiry`, `KEPT_REMAINING`, `QUOTA_RESET_MATCH_MS`), while the Rust runtime duplicated refusal-to-scope attribution and the 2-second tolerance (`quota_scope_by_reset`, `RESET_MATCH_TOLERANCE`) with a different tie-break when two scoped windows were both used up. Window merging (`mergeRoutingQuotaWindows`) and refusal attribution (`attributeRoutingQuotaRefusal`) now live once in `@xmatrix/protocol`: PostgreSQL persistence locks and merges through the protocol helpers with no SQL quota derivation, and the Rust runtime forwards the raw refusal reset time and fresh provider reading so Hub attributes the scope (while continuing to accept `quotaScope` from older daemons during the compatibility window). Protocol, DB, Hub, and CLI / daemon. Recovery is a CI-validated beta reverting this change.

## Unreleased: full Top6 website i18n (`en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `es`)

Expanded public website localization across 6 languages (`/` English, `/zh` Simplified Chinese, `/zh-tw` Traditional Chinese, `/ja` Japanese, `/ko` Korean, and `/es` Spanish) covering the homepage, all 19 `/<competitor>-alternatives` landing pages (plus legacy brand 308 redirects), `/download`, `/support`, and all 10 `/docs` user guide pages, while keeping legal pages English-only. Every localized route sets the matching `<html lang>`, canonical URL, 6-way bidirectional `hreflang` + `x-default` alternates, localized OpenGraph/JSON-LD metadata, site-wide footer language switcher preserving the current path, direct localized footer links to all 19 competitor pages, `sitemap.xml` entries with `xhtml:link` alternates (196 URLs total), and `site-host.mjs` site-origin allowlisting. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: App Store Connect collections support resumable cursors, frozen submission approvals, and unified web pagination

App Store Connect read listings (`list_apps`, `in_app_purchases`, `subscriptions`) now emit an opaque query-only continuation `cursor:<token>` when a collection exceeds five pages and accept that cursor to resume later pages without caller-supplied URLs. `submit_in_app_purchases` and `submit_subscriptions` now implement a read-only `prepare` step that freezes exact app, product, group, and existing version identities plus a SHA-256 digest into approval cards so post-approval catalog additions cannot widen the submission and partial-write replays finish idempotently. `WebSession` now exposes `listComplete` and `listPreview` backed by the same shared `paginateAppleCollection` implementation as `AppStoreConnectApi`, replacing the separate pagination loops in `app-store-connect-review.ts` and `app-store-connect-web-management.ts`. Hub only. Recovery is a CI-validated beta reverting this change.

## Unreleased: direct root `/<competitor>-alternatives` landing pages with live product preview

Removed the `/alternatives` hub page (which risked targeting negative brand queries) and moved all 19 competitor comparison landing pages to flat root-level `/<competitor>-alternatives` URLs (`/raft-alternatives`, `/t3-code-alternatives`, `/conductor-alternatives`, `/jules-alternatives`, etc.), with permanent redirects for legacy names (`/superset-alternatives`, `/slock-alternatives`, `/lobechat-alternatives`, `/evermemos-alternatives`, `/google-jules-alternatives`). Tightened `<title>` tags (<=60 chars, front-loaded `<Competitor> Alternatives (2026)`) and `<h1>` headings to match competitor search intent, embedded the live xMatrix `<AppWindow />` preview directly below the hero, added `SoftwareApplication` structured data, and replaced the single footer hub link with direct `<Competitor> Alternatives` links from every page. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: bound WebSocket hibernation attachments by V8 structured-clone size

`hibernationBoundedJson` checked only UTF-8 JSON byte length against Cloudflare Durable Objects' 16 KiB `WebSocket.serializeAttachment` limit. Because V8's `ValueSerializer` encodes any string containing a UTF-16 code unit above `0xFF` (such as an em-dash or CJK character) as two-byte UTF-16 for the entire string plus alignment padding, an Agent Instance session whose JSON fit under 16 KiB could exceed 16 KiB in V8 structured clone (e.g. 16,449 bytes in Sentry `XMATRIX-HUB-E8`), bypassing hibernation compaction and throwing inside `serializeAttachment`. `hibernationBoundedJson` now enforces both UTF-8 JSON length and a sound upper bound on V8 structured-clone size on both input and normalized attachments so oversized Agent Instance presentations compact before serialization. Hub only. Recovery is a CI-validated beta reverting this change.

## Unreleased: Antigravity quota uses native `agy -p "/usage"` instead of direct OAuth token reads

The Antigravity quota reader previously read `~/.gemini/antigravity-cli/antigravity-oauth-token`
directly and sent HTTP requests to Google's private `v1internal` Cloud Code
endpoints with a synthesized `antigravity/cli/<ver>` `User-Agent`. That created
unnecessary ToS/anti-abuse risk and failed on `agy` 1.5+ macOS and Windows
installs that store sign-ins in the system keyring instead of a plaintext token
file. The reader now invokes the official unmodified `agy -p "/usage" --output-format json`
command (gated on `agy >= 1.1.11`, bounded by timeout and `kill_on_drop`,
hiding the console window on Windows, fast-aborting unauthenticated login
prompts, caching with a 3-minute success / 1-minute failure TTL, and
invalidating the cache when remote Antigravity sign-in completes). Set
`XMATRIX_DISABLE_ANTIGRAVITY_QUOTA_PROBE=1` to disable Antigravity quota
probing explicitly. CLI / daemon only. Recovery is a CI-validated CLI release
reverting this change.

## Unreleased: Repeated outside events do not repeat a Norn round

GitHub and connector events now carry their provider identity into the Norn
ledger. All matching streams are recorded in one transaction per program.
Retries reuse that identity, and a Hub build that cannot evaluate the source
saves the event for the scheduled recheck. This covers events delivered by
the updated Hub. Hub and DB code only, with no schema or client migration.
Recovery is a CI-validated beta reverting the change.

## Unreleased: Agent presence reads ship each distinct Instance catalog once

Channel windows and exact Instance reads carried each Instance's model,
command and parameter catalogs on every row, although Instances of one harness
version report identical catalogs. Those copies made the resting-presence read
the largest source of PostgreSQL result bytes (40-60% per day). The reads now
name each catalog by its SHA-256 digest and ship each distinct catalog once per
answer; the DB layer puts it back on every record, so Hub responses are
unchanged. A production-sized 200-Channel page drops from about 4.9 MB to
1.7 MB. DB and Hub. Recovery is a CI-validated beta reverting this change.

## Unreleased: Stripe connector exposes read-only account and payment inspection actions

The Stripe connector previously delivered inbound webhook cards only and
declared no outbound read actions, so Agents and Channels could not inspect
connected accounts or look up a failed PaymentIntent's decline code and payment
method through `xmatrix call` even though the Stripe App OAuth grant already
held `event_read`, `payment_intent_read`, `invoice_read`, `subscription_read`,
and `dispute_read`. The connector now exposes eleven read-only actions over
the Space's retained native OAuth grants (`accounts`, `list_events`,
`get_event`, `list_payment_intents`, `get_payment_intent`, `list_invoices`,
`get_invoice`, `list_subscriptions`, `get_subscription`, `list_disputes`, and
`get_dispute`), using the existing per-account leased token refresh and a
strict endpoint allowlist with no `expand` outside those five permissions.
Protocol and Hub. Recovery is a CI-validated beta reverting this change.

## Unreleased: mobile Handoff and Stop second confirmation no longer collapses on tap

Opening Handoff or long-pressing Stop on an Agent dock item programmatically
focused the first successor or Stop button, and `.app-agent-work-item`'s
`onBlur` cleared `handoffPickerOpen` and `armedAction` whenever
`relatedTarget` was outside the item. On iOS WebKit (WKWebView and Mobile
Safari), tapping any `<button>` blurs the previously focused button with
`relatedTarget === null` before `click`, so confirming Handoff or Stop
immediately closed the picker or disarmed Stop without sending. Separately, on
narrow mobile viewports or for a second Agent in the dock, bare-disc controls
stayed on the avatar's row (`trace-row` / `row`), letting the raised avatar
(`z-index: 21`) overlap Handoff/Stop (`z-index: 20`) and toggle the panel shut
when tapped.

`AgentWorkAvatar` now keeps armed controls and the Handoff picker explicitly
pinned (`data-controls-open`), dismisses them on outside presses or `Escape`
via `listenForOverlayDismissal` (and when its Trace folds), and ignores
in-window `onBlur` with `relatedTarget === null`. Bare-disc items whose panel
shifts left of the disc or would overflow the column stack their controls above
the avatar (`panel` / `trace-panel`) so every button stays unobstructed and
within the viewport. Web only. Recovery is a CI-validated beta reverting this
change.

## Unreleased: the Chrome extension has one action, ask, and asks in the Space you are looking at

A question asked on a page went to the Space last used by the extension, or the
person's first Space when none was recorded, not the one open in the side
panel; a Space without Agents then answered "No Agent was asked". The panel's
app now tells the extension which Space it shows (`{ type: "space" }` in
`extension-embed.ts`), and questions go there; the box names that Space before
it is sent. The message mentions nobody, so the Space's routing picks the Agent.

The selection bar's *Ask* / *Quote* pair, the context menu's *Discuss* /
*Quote* pair and the panel bar's *Quote* / *New chat* become one action: a
field beside the selection, *Ask about this…*, that opens into the question
box; *Ask about “…”* and *Ask about this page* in the context menu, which open
the same box on the page through activeTab; and *Ask about this page* in the
panel bar. The panel asks once, right after sign-in, whether to turn on the
field beside selections, instead of a strip above the app. Source labels drop
the unread counts sites put before their titles. Web (the Space announcement
and the privacy policy wording) and the extension, which ships outside the
release train; an extension built before it keeps its old Space choice.
Recovery is reverting this change.

## Unreleased: the Chrome extension packages the app instead of framing the Web

The extension's side panel showed the Web (`/app`) in a frame, so every open
downloaded the page and its scripts and ran each request through the Web's
Worker: several serial round trips before anything showed. The extension now
ships the workspace app in its own package, built from `apps/web`
(`src/extension-app`, `apps/chrome-extension/scripts/build-app.mjs`): the same
providers, gate and shell, with the Web's Hub proxy routes bundled to answer in
the page and send straight to the Hub. Opening the panel loads nothing from the
Web; the last conversation list paints from the app's local copy while the Hub
is asked. The panel hands the app its session over `postMessage` as before,
now with the account, so the app does not wait on a read of it; the refresh
token stays in the service worker. The package's content security policy is
the Web's without the Web (packaged scripts only, requests to the Hub only, no
picture loaded from an address a message names).

The Web no longer allows the extension to frame it: CSP `frame-ancestors` is
`'none'` again, and its proxy no longer takes a client identity from request
headers. That allowance reached only the beta Web. Addresses the app writes
for other people (a copied conversation or page link, an invite) are the Web's
in the extension, where the page itself lives at the extension's origin.
Web (the policy and the address helper) and the extension, which ships outside
the release train. Recovery is a CI-validated beta reverting this change; an
extension build from before it then frames the beta Web again.

## Unreleased: the Chrome extension becomes a side panel

The extension now opens the person's Space in Chrome's side panel instead of a
send-to-conversation popup, signed in with the extension's session (the panel
hands the app short-lived access tokens; the refresh token stays in the
extension). Selected text can start a new conversation or be quoted into the
open one, from the context menu, the panel's page bar or an optional button
beside the selection (asks for web-page access first). Ships outside the
release train; recovery is reverting the directory.

## Unreleased: Chrome Web Store listing for the extension; privacy policy covers it

The privacy policy (section 11) now says what the xMatrix Chrome extension
reads, when, where it sends it, and what it keeps on the device, as the Chrome
Web Store requires of a listing's policy. `apps/chrome-extension/store` holds
the listing text, permission justifications, privacy answers, screenshots and
promo tile for the first submission. Web only (policy text). Recovery is a
CI-validated beta reverting this change.

## Unreleased: reload stale Web builds automatically and preserve unsent composer drafts

When a new Web deploy replaced static chunks, an already-open tab hitting a lazy
chunk (`ChunkLoadError` or browser dynamic-import failure) showed the blocking
full-screen "xMatrix was updated" card with a single Reload button, and reloading
dropped unsent composer drafts. `AppFailureScreen` now reloads automatically once
without showing the card (guarded in `sessionStorage` per build id for 60 seconds
so a broken deploy cannot loop; repeated failure falls back to the manual card),
and deployed builds also check `/api/web-build` at low frequency and silently
reload after resting in the background for 15 seconds when online with no
in-flight sends, queued attachments, or unsaved new page. Per-channel text drafts,
picked `@` bindings, and workspace selections are mirrored into account-scoped
`sessionStorage` (bounded to 20 channels / 64 KiB and cleared on sign-out) so
reloads keep unsent text. Stale `highlight.js` and page-tree hover chunk prefetches
now catch rejections quietly instead of raising unhandled rejections. Web only.
Recovery is a CI-validated beta Web release reverting this change.

## Unreleased: a late unanswered start does not fail a launch that connected

The Hub ends a spawn command the machine never answers and records that as a
failed start. That verdict used to be ignored only while the Run was still
`running` or `stopping`. A launch that had already connected, and whose Run
had then finished, was still stamped `spawnResult.ok: false`. For the next 30
minutes the startup breaker ranks that harness behind every other, so the next
summon skips the environment that did start. An unanswered start is now
ignored once the launch has connected (`state='connected'` or `connected_at`),
and that same fact suppresses the startup-failure notice. A start that never
connected is still failed and still said on its summon. Hub only. Recovery is
a CI-validated beta Hub release reverting this change.

## Unreleased: Gmail snapshot cleanup preserves the send result

Sending an approved draft, a new message with attachments, or a reply with
attachments reports the original Gmail result even if deleting the temporary
upload fails. The Hub logs a fixed cleanup warning without including the
snapshot URL or provider error details. Access still expires after ten minutes.
Durable cleanup after a failed deletion or interrupted execution remains open
in [#1418](https://github.com/LambdaLabsHQ/xmatrix/issues/1418). Hub only. Recovery
is a CI-validated beta Hub release reverting the change.

## Unreleased: Chrome extension to send pages to a Channel

New `apps/chrome-extension` (Manifest V3). From the toolbar popup
(Alt+Shift+X) or the context menu, a person sends the current page, a link or
the selected text, with a note, to a conversation in their Space as
themselves. The selected text goes as a quote, and mentioning an Agent hands it
the work. The badge shows how many conversations are waiting on them. Sign-in
uses the existing CLI device flow. Requests declare an `app` client identity
on platform `chrome-extension`. No Hub, protocol, Web or client release
component changes. The extension ships outside the release train until a
Chrome Web Store listing and its publish workflow exist; until then it loads
unpacked. Recovery is reverting the directory.

## Unreleased: show all scoped quota windows in Web instead of truncating at three

Web's `normalizeQuotaUsageList` sliced deduplicated quota windows to three
entries (`.slice(0, 3)`). For providers with two scoped pools and both 5h and
weekly windows (such as Antigravity's `Claude & GPT` and `Gemini` 5h/1w pools),
sorting placed `Gemini · 1w` fourth and silently dropped it from both the
rendered agent quota chips and `usageLimitSummary`. The arbitrary display slice
is removed so every deduplicated window renders and participates in limit
verdicts. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: tolerate small clock skew on quota probes and prune dead probe results

Provider quota probe reports carried `quotaObservedAt` from the host's wall
clock, while Hub validation (`parseRoutingQuotaProbeResponse`,
`routingQuotaRecord`, `providerQuotaReading`, and PostgreSQL
`upsertRegistrationQuotaObservation`) rejected any timestamp even a few
milliseconds ahead of the Worker's `Date.now()` or `statement_timestamp()`.
Because Cloudflare Workers' `Date.now()` and host NTP clocks can differ by
tens to hundreds of milliseconds, valid `quota_probe` completions were rejected
with `machine_command_result_mismatch` (409, surfaced as
`runtime.authority_rejected`), leaving commands in `leased` and stranding their
files in `~/.config/xmatrix/daemon-command-results/` for an hour. Protocol and
DB validation now accept bounded forward clock skew up to 5 seconds and clamp
it to `now` (while still rejecting timestamps beyond 5 seconds in the future),
and the daemon drops kept `machine_quota_probe_result` files immediately on
non-retryable rejection or connection-epoch change (with a 5-minute fallback
sweep window). Protocol, DB, Hub, and CLI. Recovery is a CI-validated beta
reverting this change.

## Unreleased: the download page's channel picker is a paper menu

The channel picker beside the main download was the system select: opened, it
drew a wood-coloured focus ring and the platform's blue list, the loudest
thing on the page. It is now quiet text that opens a paper slip listing
Stable and Preview with one line on what each is and a check on the chosen
one, with no border around it; Escape, arrow keys and a click outside work,
and focus returns to the text. The sentence under the platform list that described the channel moved
into that menu. Web only. Recovery is a CI-validated beta reverting this
change.

## Unreleased: cross-compile macOS x64 CLI releases on Apple Silicon (`macos-26`)

Hosted `macos-x64` (`x86_64-apple-darwin`) CLI release and cache-warm jobs
previously ran on 3-core `macos-26-intel` runners (~4m02s even with a warm
`kache` store, vs 1m27s for `macos-arm64`). Both `cli-build.yml` and
`cli-release-cache.yml` now cross-compile `x86_64-apple-darwin` on `macos-26`
(Apple Silicon), explicitly check the Mach-O architecture via `lipo -archs`,
verify `--version` via Rosetta (`arch -x86_64`, installing Rosetta if absent),
and keep the same Developer ID signing and R2 verification gates. CI / release
infrastructure only; no binary format, signing, or client behavior change.
Recovery is reverting the runner back to `macos-26-intel`.

## Unreleased: the download page carries fewer things

After the channel picker the download page had grown back to six elements in
its top block and a link in every row. The top is now the icon, the heading,
the download with its channel picker, and one line under it that says what
the build is for and links the other Mac build; the jump link to the list is
gone, since the list starts right below. Rows are a platform, one line and
its buttons; desktop and Android release notes and the two macOS ZIPs are one
line of small links under the list. No download URL was removed. Web only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a page is found, read and written a level at a time

An Agent had the title tree and whole-page reads, with nothing between, and a
conversation carried every page any of its Runs had opened. Two changes (#1873
and #1875):

Finding the page. Jev attaches a new conversation to a page chosen among every
page its author can read, each put as its path and the one line saying how it
stands; it was the first 60 of the tree by title alone, and the tree's order
made that an arbitrary 60 (in a Space of 111 pages, 51 could never be
attached). A Space that does not fit one question is asked in up to six
batches, then among each batch's choice. Page search (Web, the MCP
`search_pages` tool and the new `xmatrix page search`) matches every word of
the query wherever each stands, with pages holding it as typed first, and
names the section holding the most of the words; a query without spaces
matches as before. `xmatrix page tree --summaries` prints each page's line.

Carrying and reading it. A page that was only read from a conversation, never
linked, referenced or edited there, is no longer put whole into each later
Run's launch context: it is named with its line and its read. The link itself
stays. `xmatrix page read --outline` prints a page's headings with their sizes
and `--section <slug>` one section; `xmatrix page edit --section <slug>`
rewrites that section, which the Hub applies to the revision it was read from
and merges like any edit. What a section read printed is written back as that
section, never as the page, and the CLI refuses a section edit against a Hub
that does not serve sections.

Hub and CLI; Web only through the search results it shows. No schema change.
Recovery is a CI-validated beta reverting these changes; a reverted Hub makes
the newer CLI's `--outline`, `--section` and section edits refuse with a
message and write nothing.
## Unreleased: the download page is one release channel at a time

The download page offered stable builds as buttons and tucked preview builds
into a line of text links under the list, so the two channels did not read as
the same choice. A quiet Stable / Preview picker now sits beside the main
download (under it on phones) and decides the whole page: the main button, the other-Mac link, every row
(macOS, Windows, Android, Web), its release notes and the macOS ZIP links are
the selected channel; the list heading names it and one sentence under the
list says what it is. Preview adds the Android preview APK and the beta Web,
which the page did not link before. `/download?channel=preview` opens on
Preview. The sentences under the heading no longer say "stable". Web only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a Windows Supervisor with an unreadable journal starts its own release

The Windows Supervisor starts the daemon its `activation-journal.json` names.
When neither that file nor its `.previous` image could be read (bad JSON, a
checksum mismatch, a payload that fails validation), the Supervisor exited, so
the machine had no daemon; a daemon is the only way a fixed release reaches a
machine, which left a person running `install.ps1` by hand. The Supervisor now
moves both files aside as `activation-journal.json*.unreadable-<unix seconds>`,
writes the journal a first start writes (its own Authenticode-verified
executable as the committed release) and starts that daemon, which updates
itself as usual; it records `supervisor / activation_journal_unreadable` in
`continuity-events.json`. An I/O error other than a missing file still stops
the Supervisor. Nothing reports this to the Hub yet: `xmatrix daemon doctor`
shows the event on the machine. Windows CLI / daemon only. Recovery is a
CI-validated CLI release reverting this change.
## Unreleased: shrink the version-stamped CLI entrypoint and raise release kache budget

Even with a warm `kache` store, bumping `packages/cli-rs/Cargo.toml` on a
release tag still forced `rustc` to re-monomorphize `tokio`, `clap`, `rustls`,
and the top-level async entrypoint inside the `xmatrix` binary crate (over 50s
on Linux and ~4m on `macos-26-intel`), while the `640MiB` `kache` save budget
evicted ~70 release crates from a ~740MiB store on every run. The top-level
bootstrap now lives inside `xmatrix-cli-runtime::entrypoint`, leaving
`packages/cli-rs/src/main.rs` as a thin wrapper that only forwards
`env!("CARGO_PKG_VERSION")`, `cli-build.yml` and `cli-release-cache.yml` now
build only `--bin xmatrix` (skipping the five unpackaged `windows-continuity`
helper binaries), and `.github/actions/cli-release-kache-save` raises the
default store cap to `960MiB` so a full release build fits without eviction.
CLI binary packaging and CI cache infrastructure only; no protocol, schema, or
user-visible CLI behavior change. Recovery is reverting this PR.

## Unreleased: the daemon keeps unconfirmed results, not a command journal

On 2026-11-20 one stored quota reading that 4.7.0 could not read back made two
machines' daemons refuse every command for six hours: the daemon kept its own
record of each command's phase in one checksummed file,
`daemon-command-effects-v1.json`, and a file it could not verify vetoed
everything. 4.7.1 fixed the verification and added a `.previous` image and a
quarantine. The journal itself is now gone. Whether a command runs is the
Hub's admission to decide, and the daemon already asks it before every
execution; a `Received` or `Admitted` record was re-executed on redelivery
anyway, and the payload digest check had refused real commands twice. The
daemon keeps one thing: the result of a command it finished and the Hub has
not confirmed, one file per command under `daemon-command-results/`, removed
when the Hub confirms it. A redelivered command with a kept result is answered
with it under the new lease; any other delivery runs. A result that cannot be
written is still reported, and one that cannot be read is removed, so the cost
of either is that one command running again if the Hub delivers it again.
Removed with the journal: phases, payload digests and re-keying, the checksum,
`.previous`, quarantine and size eviction, and the Windows update handoff's
refusal while a `Received` or `Admitted` record remained (up to 31 days). The
old file is deleted at daemon start and not migrated; the Hub redelivers what
it had not confirmed. `BootJournal` and `ActivationJournal` are unchanged. CLI
/ daemon only. Recovery is a CI-validated CLI release reverting this change;
the reverted daemon starts from an empty journal.
## Unreleased: a message row scrolled into view costs its own style, not the app's

Scrolling a conversation mounts message rows, and the main thread took long
enough over each batch that the timeline showed blank where rows had not yet
been drawn. Style recalculation was the largest part, and most of it was not
the rows' own. One admin rule, `.app-admin-view:has(...) ... article > button`,
made the browser restyle every button in the app whenever a node was inserted;
the open user record is now read from the address instead. One `::selection`
and three `::highlight()` rules matched every element, so each element was
styled five times over; where highlight styles inherit (Chromium, detected
before first paint as `data-highlight-inherit` on `<html>`) they are named
once on an ancestor, and other engines keep the previous rules unchanged. The
passage toolbar no longer reads the selection on every scroll frame unless a
passage is selected. On 300 mixed rows at 4x CPU throttle, elements restyled
over a scroll fell from 74-82 thousand to 12-13 thousand and style time from
5.0-5.9 s to 2.3-2.8 s; mounting the rows in React is unchanged and is now the
larger share. `app-style-scope.test.mjs` holds the two selector shapes out and
lets the stylesheets' rule count only fall (`css-rule-budget.json`): new
styling goes on the element as utility classes. Web only. Recovery is a
CI-validated beta reverting this change.

## Unreleased: the download page is one action and a ruled list of platforms

The download page was five wood slabs carrying fourteen liquid-glass buttons,
two competing headings and a sideways card scroller on phones. It is now the
app icon, `Get xMatrix`, a line naming the build this device gets and one wood
pill to download it; the other Mac architecture and the jump to every platform
are text links under it. macOS, Windows, Android and Web follow as rows on the
same paper, each with its system glyph, release notes and white pill buttons
for its builds; preview builds and ZIPs are two lines of links under the list.
Every download URL, device detection and copy key is unchanged. Web only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a start its machine never answered is ended in its place

A connected daemon that took a start command and never admitted, ran or failed
it left the Hub to end the start after ten deliveries, about five minutes, and
then only in the database: nothing was written on the summon, an `@auto` summon
went to nobody else, and the start breaker never saw it, because all three
hang off the failure report a daemon sends. On 2026-11-20 two machines'
daemons refused every command for six hours and twenty starts ended that way;
six more had since 2026-10-31. A spawn command now fails as
`machine_not_answering` after three silent deliveries (other commands keep
ten), and in the same transaction the Hub records the failed-spawn report the
machine never made, which the coordinator finalizes like any terminal report:
the failure is said on the summon, an `@auto` summon goes to the next Agent,
and the Run counts as a failed start. Every environment on that machine then
ranks last, in every Space, until the machine answers any command or 30
minutes pass; the fact is read from the commands the Hub sent, and nothing is
stored about the machine. Hub and Web (the summon reason names the machine).
Migration `0261` lets `data.machine_run_terminal_reports` hold a
`machine_spawn_result`; an older Hub finalizes such a row the same way and
never writes one. Recovery is a CI-validated beta reverting this change; the
relaxed constraint is harmless to keep.

## Unreleased: stop message hover flicker across channel switches and hide Windows background consoles

Switching channels painted the last screen of messages immediately in
`TimelineOpeningTail` while the virtual list measured behind it with
`visibility: hidden`, then dropped `invisible` and called `slot.moveBefore(host, null)`
in the same commit. Because the newly mounted destination slot still resolved
as `visibility: hidden` until style recalculation, Chromium dropped `:hover`
for a painted frame during handover — flashing the hovered message row's
background highlight off and back on and restarting the action toolbar's
opacity fade on both macOS and Windows. In addition, a legacy
`:root:not(.dark) .app-agent-work-dock > div` rule in `globals.css` outranked
the wood theme's `pointer-events: none` on `.app-agent-work-scroller`, letting
the transparent band above the work dock steal hover from scrolled messages.
Separately on Windows, several periodic background commands in the Desktop App
and CLI/daemon ran without hiding their console window (`powershell` daemon
heartbeat, 100 `ping.exe` network probes, `gh auth status`, `codex` parameter
discovery, `update-self`, `git cat-file`, `gh api`, and the one-shot
update-handoff PowerShell task), and the Desktop App rebroadcast unchanged
daemon heartbeat status every 30 seconds and re-sent unchanged window titles.

`TimelineRowSlot` now resolves the destination slot's `visibility` style before
calling `moveBefore`, keeping `:hover`, the row background highlight, and the
hover action toolbar steady across channel-switch handover; the light-mode
`.app-agent-work-dock > div` rule now keeps `pointer-events: none` so only
agent dock items capture pointers; all Windows background spawns pass
`windowsHide: true` / `CREATE_NO_WINDOW` / `-WindowStyle Hidden`; unchanged
daemon heartbeat status is deduplicated; and desktop window titles only update
when the title text changes. Web, Desktop, and CLI / daemon. Recovery is a
CI-validated beta reverting this change.

## Unreleased: delivered execution reports release their lock files

Each execution report in a machine's `execution-outbox/` has a lock file of its
own. A confirmed report was removed; its lock file never was, and admission
counts every entry against the 2049-entry bound. After 1024 delivered reports a
machine's outbox held only lock files and refused every new report with
`Execution outbox is full` (seen on a production machine from 2026-11-16: 2048
lock files, no reports). The daemon's drain pass now removes a lock file that
has no report beside it, while holding that lock, and a lock taken on a file
released that way is not treated as the lock. An outbox already in that state
empties on the first pass after the update. CLI / daemon only. Recovery is a
CI-validated CLI release reverting this change.

## Unreleased: Antigravity quota reads the Gemini weekly window

Google's Cloud Code `retrieveUserQuotaSummary` endpoint omits the native
`Gemini Models` group (both 5-hour and weekly buckets) unless the request
carries a versioned CLI `User-Agent` (`antigravity/cli/1.2.0+`). The quota
reader previously sent `antigravity/xmatrix`, so only `Claude & GPT` (`5h` and
`1w`) came back from the summary and the fallback `fetchAvailableModels` path
filled in only `Gemini · 5h`, leaving `Gemini · 1w` missing everywhere. The
reader now sends `antigravity/cli/<version>` from the installed `agy` CLI (or a
`1.5.13` floor when unavailable), restoring both `Gemini · 5h` and `Gemini · 1w`
alongside `Claude & GPT`. CLI / daemon only. Recovery is a CI-validated CLI
release reverting this change.

## Unreleased: hosted CLI release builds reuse warm per-target kache stores

Hosted CLI releases (`cli-build.yml`) previously compiled all 400+ Rust crates
cold on every beta and stable tag (5–14 minutes per platform, with
`macos-26-intel` at 14m11s), ran Windows release builds with Defender real-time
scanning enabled, and throttled hosted PNPM upload-dependency installs without
reusing the `lockfile-verified.jsonl` cache. A new `cli-release-cache.yml`
workflow on `main` now maintains bounded per-target `kache` stores (`linux-x64`,
`macos-arm64`, `macos-x64`, `windows-x64`) using the same pinned compiler as PR
CI and `cli-build.yml`; `cli-build.yml` restores those stores on release tags,
excludes build directories from Windows Defender, and reuses the hosted PNPM
verification cache. CI / release infrastructure only; no client or schema
change. Recovery is reverting the workflow PR.

## Unreleased: harden continuity journal checksums and self-healing

`BootJournal`, `ActivationJournal`, and `CommandEffectJournal` previously
verified `checksumSha256` by deserializing the JSON payload into structs and
re-serializing it, so any 1-ULP float shift (such as an Antigravity quota
reading `(1.0 - 0.9004436) * 100.0 = 9.955639999999999`) or future serialization
difference tripped `activation journal checksum mismatch` and permanently
rejected every daemon command. Journals now hash and verify exact raw payload
bytes via `serde_json::value::RawValue` (keeping a `float_roundtrip`-backed
legacy fallback so existing pre-fix journals recover automatically on upgrade),
and `CommandEffectJournal` now maintains a `.previous` image and quarantines
unrecoverably corrupt files (`*.corrupt-*`, bounded) so a broken local effect
journal can no longer wedge a machine's daemon. CLI / daemon only. Recovery is a
CI-validated CLI release reverting this change.

## Unreleased: a billing refusal is a hold, read once

A payment refusal (an empty prepaid balance, or Cursor asking for a payment
method on one model pool) was stored as a used-up quota window and also as
side flags. Launch then stripped the window for a named summon and checked
the flags again, and the window's max age cut a year-long hold down to 31
days. The registration reading now carries `billingHolds`, and
`routingQuotaVerdict` is the only decision: unnamed `@auto` treats a hold as
used up until the hold's own expiry, a named summon ignores holds, and a
provider window that is actually used up still refuses both. Hub only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: Antigravity stays busy while its subagents run

Antigravity's ACP v1 server marks `invoke_subagent` `completed` as soon as the
subagent starts and emits no ACP events while it runs, so an Instance dropped
to `idle` (green) right after spawning a subagent, left the idle-sleep counter
at zero, and did not listen to ACP stdout for the subagent's reactive wakeup.
Antigravity Runs now read the session's local `.system_generated/subagents/`
and message state to keep the Instance `busy` (and count active subagents
against idle sleep) until every launched subagent reports back or is killed,
and always listen to the ACP stream between turns so unsolicited wakeups
transition into `busy` and stream traces without waiting for a new message.
CLI / daemon only. Recovery is a CI-validated CLI release reverting this
change.

## Unreleased: the Hub canary waits for Cloudflare to know its new version

Two Hub betas in a row failed before any traffic moved: right after the upload,
Cloudflare had not yet listed the new version, and then could not view a
version it had just listed (code 100146). The canary now looks the version up
up to six times with growing waits (about 75 s in all) and retries only that
not-found answer when it views it; any other failure still stops the release
before a deployment. Release tooling only. Recovery is a CI-validated change
reverting this one.

## Unreleased: the comment card's @ list sits on its paper, and never folds one Agent

The @ list in a page's comment card was the glass composer's list dropped
onto paper. On the card it now reads as the page's paper menus: flat rows
from edge to edge, faces in the comment's text column, names at the text's
weight, a fold row as one more quiet line without an arrow. In every
composer, an open section shows its last candidate rather than spending a
"Show 1 more" row to hide it. Web only. Recovery is a CI-validated beta
reverting this change.

## Unreleased: unlink a page from a conversation

A page linked to a conversation kept reaching it (new Runs read it at launch,
it sat in the header cards, typing on it woke a co-writing Agent) and there was
no way to stop that: deleting a link was undone by the next read, edit or
mention from the conversation. A page's card at the top of a conversation now
offers **Unlink from this conversation**, and `xmatrix page unlink <page-id>`
does the same. It removes every link between the two, stops co-writing, and
records the unlink (expand migration 0260, `data.page_unlinks`); reads, edits
and mentions there no longer link the page again until someone links it
explicitly. Hub, DB, Web and CLI. Older Hubs ignore the record while they
drain. Recovery is a CI-validated beta reverting this change; the new table is
left unused.

## Unreleased: a page comment's @ lists every Agent the Space can start

The comment box on a selected passage used the conversation composer but was
given no Space, so `@` offered nothing and a new Agent had to be typed out by
name. It now gets the same context as a new conversation's composer: `@`
lists every Agent and machine the Space can start and the launch conditions,
`#` channels and pages. A picked Agent, `@auto` or `@machine:…` starts a new
discussion of the passage, its first message carrying the pick, instead of
going to the Agent already at work on the page. Web only. Recovery is a
CI-validated beta reverting this change.

## Unreleased: Agents no longer report a plan; conversations show talk and pull requests

Grok and Codex Runs showed their runtime's plan (completed steps, the step in
progress) as a collapsible line in the conversation and as the work dock's
intent line; Claude Runs showed none, because Claude Code no longer offers its
todo tools to current models (v2.1.233: newer models keep track of multi-step
work without a written checklist). Rather than force the checklist back onto
Claude (#1836, reverted here), the plan is retired for every runtime: no
runtime reports it, the Hub refuses a report of one from an older CLI, the
conversation leaves out plan entries already stored, and history folds each
to its stored line. Progress is the Agent's own status message plus pull
request, CI and merge facts. The channel contract no longer asks Agents to
keep a plan current. Hub, Web and CLI. Recovery is a CI-validated beta
reverting this change.

## Unreleased: a summon naming a billing-refused harness runs its model

`@cursor machine:Workstation` with the Default model gemini-4-neon failed at
once with "xMatrix's selection no longer matches authorized launch resources"
(`registration_selection_invalid`). The account carried a billing refusal,
whose hold reads as one used-up account window. A named summon is let past
that refusal (#1814), but its models were still filtered by the hold, so none
was left to run. A named summon's hold now takes none of its models away; a
scoped window the provider measured used up still refuses its model, with the
usual quota wait. Unnamed `@auto` still leaves the refused account out. Hub
only. Recovery is a CI-validated Hub beta reverting this change.

## Unreleased: Default model is picked from a menu

**Default model** on an Agent's page, and on the Space's registered locations,
was a free-text box: you had to know and type the exact model name. It is now a
menu: Harness default, the models the harness's own catalog and its declared
list name, and **Other model…**, which opens a field for a name the menu does
not list. A saved model stays selected even when the catalog no longer lists
it. Web only. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: a pull request whose CI passed has a green tick

On GitHub's pull request slip a CI failure was red, but a pass wore the same
plain ink as an open pull request, so the two states the slip exists to tell
apart did not read at a glance. A pull request whose latest CI passed now
wears a green tick, the same green as a connected App's tick and a free
presence dot. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: ACP and Antigravity runtimes report waiting state

ACP runtimes previously stayed `busy` during long tool calls and `idle` while
Antigravity waited on background `run_command`, `schedule`, or `run_workflow`
tasks across `end_turn`, so xMatrix could not show them as `waiting` or keep
them from idle-sleeping. ACP sessions now track in-turn tool calls (and parked
questions/permissions, excluding subagent calls) through `ToolWaits` to report
`runtimeState.waiting (kind: "tool")` past the 15-second threshold. For
Antigravity (`agy acp`), non-daemon tool calls still open at `end_turn` become
cross-turn background waits (`kind: "background"`) with `background_tasks`
written for the idle-sleep check, and the between-turns run loop listens to the
ACP stream so task completions transition cleanly into `busy` reactive wakeups
and back to `idle` or remaining waits. CLI / daemon only. Recovery is a
CI-validated CLI release reverting this change.

## Unreleased: Status, Machines and Agents are one matrix

Adding an agent to a machine was spread over three rail entries: it was
installed under Machines, signed in under Agents, and its state read under
Status, whose list only repeated the other two and sent each row away. The
same machines and agents were drawn up to four times, and the pages disagreed:
a row said "3 running" where the total said none were working. The rail and
the phone dock now have one entry, **Agents**, and every fact has one place.

- **A matrix on a desktop.** A machine to a row, an agent to a column, and a
  cell for that agent on that machine: `Ready`, `3 working`, what it waits on
  (`Sign in`, `1w limit`, `Update`), `Off` when installed and not turned on in
  this Space, `+` where it is not installed, `—` where it cannot run. A cell
  with a quota shows the window closest to its limit. A machine's row shows a
  load reading only when it is under strain; teammates' machines follow the
  reader's own. There is no list beside the matrix: it is the list of both.
- **The matrix is edited where it is read.** Choosing a cell opens its editor
  under it: `+` installs the agent on that machine, `Off` turns it on in this
  Space, `Sign in` signs it in, and an agent's cell shows where it works, its
  usage, its switch, its version and updates. While a machine installs or
  updates, its cell says so, also after its editor is closed, so several can
  run at once. The `+` after the last agent adds a column for an agent no
  machine has yet; the table's last row, **Add a machine**, connects another
  computer in place and it becomes a row. A row's heading still opens the
  machine and a column's heading what the Space set on that agent; a page
  opened that way takes the matrix's place and has a way back to it.
- **An avatar matrix on a phone.** Each machine heading (with its OS icon and
  inline exceptions such as sign-in, quota limit, or strained CPU/disk) sits
  above a full-width strip of vertically aligned agent avatars—no horizontal
  scroll up to 8 columns and no working-count noise. Working avatars pulse
  quietly; attention items show an amber ring and semantic badge; strained
  quota bars appear below the avatar; tapping any cell opens an unblurred
  bottom-sheet editor, and a ghost **Add a machine** row at the bottom guides
  adding another computer.
- **One count says who works:** an Instance with work in hand. A live process
  waiting for its next message is "Ready", and its agent's page lists it as
  waiting. A program its machine reports signed out, or too old for xMatrix,
  reads as that everywhere, not as ready.
- **A machine's page** starts with its agents. Each installed one is a line:
  what it does in this Space, **Sign in** where it waits on that, and its
  switch. Version, updates and uninstall open under the line. What is not
  installed is under **Add an agent**; one installed from there joins the lines
  above, is turned on, and is signed in on the same line. Load, settings and
  the xMatrix version follow; a daemon and CLI of one build are one line.
- **An agent's page** shows where it works and waits, its usage, sign-in,
  access and settings. Its header links to its machine and to the agent
  across machines. The "Where it runs" facts its header already said are gone.

The addresses `/status`, `/agents`, `/machines` and `/local` are unchanged, so
links, bookmarks and installed iOS builds keep working; on a desktop a bare
`/agents` or `/machines` is the matrix. A phone's More no longer lists Agents
and Machines, the Agents list no longer leads with "Manage machines" or ends
with "Installed on your machines", and the page of an agent no longer carries
install controls. iOS shows the third tab as Agents after its next release.
The desktop app's own machine page keeps its "Agents" and "Found on this
machine" sections for now. Web and iOS. Recovery is a CI-validated change
reverting this one.

## Unreleased: App Store Connect collections traverse pages explicitly and fail closed on truncation

`AppStoreConnectApi.list` previously returned `{ rows, included, next? }` for both
complete-collection lookups and bounded previews, so callers reading `.rows`
could silently treat a first page as the entire catalog, version list, or draft
submission. `AppStoreConnectApi` now separates `listComplete` (bounded
multi-page traversal with loop and path-scope checks, refusing if more pages
remain) from `listPreview` (disclosing `incomplete` previews). One-time
in-app purchases and auto-renewable subscriptions now traverse multi-page
catalogs, check pending versions and draft items completely, and share one
catalog submission helper; commerce polling shares `listComplete`. Hub only.
Recovery is a CI-validated Hub beta reverting this change.

## Unreleased: an Android build repeats a failed dependency download

Three of the seven Android releases on 2026-11-18 failed within two minutes
because the Gradle Plugin Portal answered badly: a plugin "was not found", or a
POM could not be parsed. Re-running the same job passed. `android-deploy.mjs`
now repeats a Gradle task up to three times when its output shows a dependency
resolution failure, refreshing dependencies on each repeat. A failed test, lint
or build still fails at once. Release tooling only. Recovery is a CI-validated
change reverting this one.

## Unreleased: other Android apps can no longer hand the app's page an address

Google Play flagged Cross-App Scripting in the Android app: its WebView lived
in an exported activity, so any installed app could send it an address. Such
an app could open any page of the trusted Web, or open the signed-in login page
with its own `device_code`, `user_code` or `cli_callback`. The WebView now lives
in `WebAppActivity`, which is not exported. `MainActivity` keeps its name, so
home-screen icons still work, but holds no WebView: it passes on only a
conversation id, the login return with an `auth_error`, and the sign-in return's
`code`, `state`, `error` and `new_account`. Everything else opens the app as
usual. The page now collects a waiting link over the origin-checked bridge, so
no link is evaluated as script. Android only. Recovery is a CI-validated Android
release reverting the change.
## Unreleased: no Hub cache shares a read in flight across requests

#1785 fixed the sign-in key cache (HUB-DJ), but the same pattern lived on in
three more places: a page's embedded GitHub files, the Android push token and
the diagnostics hashing key each kept a promise at module level that another
request could await. A Worker request cannot settle on a promise another
request created, so when the first request ended early, everyone waiting on its
read failed: an embed showed an error, or a push batch dropped its Android
sends. These caches now go through one `SettledCache` (`@xmatrix/protocol`),
which keeps only finished values. The sign-in key cache and the database's Space
placement hints use it as well. One push batch's Android sends still share one
token grant. A source scan (`no-isolate-shared-promise.test.mjs`) fails on any
module-level variable whose type holds a promise. Hub only.

## Unreleased: a summon with no agent connected says how to bring one in

A new person who typed `@codex …` before connecting a computer got "Agent
launch failed: No registered environment offers an authorized model and
workspace for this invocation (registration_not_found)", twice, and nothing
they could act on. When the person has no enabled agent at all, the Hub now
answers the summon with the same `connect-agents` step a first message without
a summon gets: agents run on your own computer, open xmatrix.sh there and run
the command, or download the desktop app. Someone who has agents still gets
the launch failure. Hub only.

## Unreleased: the Hub deploys as a canary and rolls its code back on failure

`scripts/hub-canary-deploy.mjs` now owns the production Hub deployment. It
uploads the tagged release as a Worker version, gives it 10% of traffic for
three minutes, verifies that version through a Cloudflare version override
(`hub-postdeploy-smoke.mjs --version-override`), then promotes it to 100% and
verifies the public origin. A failure during the split, the hold, the promotion
or the final check deploys the previous version back at 100% and fails the
release.

Only Worker code rolls back; PostgreSQL schema does not. The train applies
expand migrations before this step and ships contract migrations separately
after the new Hub is proven, so the previous Hub stays compatible during the
window. A release that changes a Durable Object class lifecycle cannot be
uploaded as a version or rolled back across; `wrangler versions upload` refuses
it and the release deploys once without a canary. Secrets are Worker-level and
do not roll back with code. Before any traffic reaches the uploaded version,
the release reads that version's bindings and refuses to continue if a secret
this release selected is missing. `XMATRIX_HUB_CANARY_HOLD_SECONDS` changes the
hold (default 180 s). Hub only. Recovery is a CI-validated Hub beta reverting
this change.

## Unreleased: a sign-in key read is never shared with another request (HUB-DJ)

The Hub cached the in-flight read of a Better Auth public key and let other
requests await it. A Worker request cannot settle on a promise another request
created, so when the first request ended before its read finished, every request
waiting on it failed authentication with "can never settle" (Sentry HUB-DJ, 8
events on 2026-11-17). The cache now holds only keys that have finished loading;
concurrent first reads of one key each read it once. Signature, issuer, audience
and expiry checks are unchanged. Hub only. Recovery is a CI-validated Hub beta
reverting this change.

## Unreleased: the answer field on a request card has its own fill

The line where the reader writes an answer on a request card (pencil, "Write
your answer here…", round Send) is now a borderless strip in the paper's own
colour, so it stands apart from the brass card around it instead of blending
into it. Web only. Recovery is a CI-validated Web beta reverting this change.

## Unreleased: model catalogs keep over 100 models and `/effort` lists options while asleep

Runtimes reporting more than 100 models (or more than 8 aliases) now retain
their full catalog across routing and `/model` / `/effort` switches instead of
dropping it at an arbitrary count cap. Bare `/effort` to a sleeping Agent also
lists the effort levels of the model it will wake on, and bare `/model` to a
sleeping Agent respects declared models when constrained. Hub only. Recovery is
a CI-validated Hub beta reverting this change.

## Unreleased: a failed version handoff on Linux and macOS returns to the original wrapper

When `update-self` moved a Run on Linux or macOS to a replacement wrapper and
that replacement exited or timed out before serving its channel (for example,
because Codex refused to open a thread the original wrapper still held), the
daemon treated the replacement's exit as the Run's own exit and dropped the
Run while the original wrapper kept running untracked. The daemon now retains
the original wrapper's handle, process tree and status during the handoff on
Linux and macOS just as on Windows, rolls back to the original wrapper when the
replacement fails or times out, and isolates the replacement in its own session
so cleanup never crosses generations. CLI only. Recovery is a CI-validated beta
reverting this change.

## Unreleased: a failed Claude turn no longer shows the Agent on the model `<synthetic>`

When a Claude turn fails on a used-up limit or an API error, Claude Code
writes the error as an assistant message whose model is `<synthetic>`. That
name replaced the Agent's model on its card, in message headers and in
`/model` ("current: <synthetic>") until its next real reply. The runtime no
longer takes it for a model, and the Hub ignores it from a runtime that still
reports it. Hub and CLI. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a refused `/model` writes its reset to the nearest minute

A provider can state a reset a fraction of a second early (17:59:59.747 for
18:00), and the refusal then read "used up until 2026-11-19 17:59 UTC". The
sentence now says the minute it means. Hub only. Recovery is a CI-validated
Hub beta reverting this change.

## Unreleased: a model's own used-up quota is no longer read as available while other models are served

A Claude account whose Fable week was used up kept being offered for Fable:
`/model claude-fable-5-2` went to the machine and was refused with a 429, a
sleeping Agent told to wake on Fable woke and failed its first turn ("You've
hit your Fable limit · resets Nov 19"), and a summon naming Fable could be
routed there. The reading did hold "Fable · 1w 100%". But every request the
account's Agents made on Opus came back "allowed", and that verdict was read
as the account being served past all its limits: it raised the used-up Fable
window to "still eligible" and let it lapse after fifteen minutes. A verdict
now bears on the account's own windows only. One model's own window that
reads used up stays used up until its reset; a refused account still refuses
every model. Hub and Web. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a `/model` asks for a quota read only when the reading is missing

Since #1758 a `/model` asks the machine to read quota that no current
reading tells. It also asked when a complete reading simply listed no limit
for the model (the provider holds none against the account now), on every
statement. It now asks only when the account or its per-model part was not
read. Hub only. Recovery is a CI-validated Hub beta reverting this change.

## Unreleased: `/effort` to a sleeping Agent takes effect when it wakes, and an unread quota is read

`/effort` written to a sleeping Agent is recorded like `/model` (#1754): the
answer reads "It starts at effort high when it wakes", checked against the
efforts of the model it will start on. A `/model` naming a model whose quota
xMatrix holds no current reading of now asks the machine to read it, so the
next statement and the Agent's wake decide on a reading instead of a guess.
If the reading then shows a model chosen for the wake is used up, the Agent
wakes on the model it last ran instead of staying asleep until that quota
resets, and the `/model` that chose it says so. Hub, DB and Web. Recovery is
a CI-validated beta reverting this change.

## Unreleased: a pull request's line names it and leaves out the subscription

GitHub's line for a pull request read `#1754` alone, with `following here`
and later `stopped following` among its steps. Those words described how its
updates reach the conversation, looked like a control that did nothing when
clicked, and left the pull request unnamed until it merged. The title is now
read when the conversation subscribes, so the line reads `#1754 <title>` from
the start and later lines keep it; the steps are only what happened to the
pull request (`opened by claude:2 · CI passed · merged`). The subscription
message stays as context for Agents. Hub, Protocol and Web. Recovery is a
CI-validated beta reverting this change.

## Unreleased: `launch:force` is retired; only a send's launch request starts an Agent

Every send that should start Agents already asks to (the composer, `xmatrix
send --launch`, MCP `launch: true`, Norn and Page sends), so `launch:force` in
a message's text no longer starts anything. It also closes a gap: an Agent's
live reply carries no launch request, yet `@codex launch:force` written in it
still started codex. Start on a mention's card and quota retries are
unchanged. xMatrix's summon for a first message that named nobody is now
`@<harness>` appended with `launch: true`; one written before this release
and still undispatched shows Start on its card. The composer no longer offers
or highlights `launch:force`; old messages keep parsing it as a condition.
Hub, DB and Web. No schema migration. Recovery is a CI-validated beta
reverting this change.

## Unreleased: `/model` to a sleeping Agent takes effect when it wakes

A `/model` written to an Agent that was asleep answered that it had no
session to switch and asked for the statement again after it woke. The
choice is now recorded: the answer reads "@claude:3 is asleep. It starts on
claude-fable-5-2 when it wakes", and its next wake or reborn starts on that
model. A model whose provider quota is used up is still refused first, with
its reset time, and `/model` with no value lists the models the Agent last
reported. Hub, DB, Web and CLI. Recovery is a CI-validated beta reverting
this change.

## Unreleased: a Windows daemon that exits is started again within a minute

The Windows `xmatrix-daemon` Scheduled Task only retried a task that failed to
start; a daemon that exited later stayed gone until the desktop app was opened,
so Agents could not send and the Machine took no new work. The task now has a
trigger that repeats every minute and does nothing while the daemon runs, so an
exited daemon is back within a minute. `setup daemon` adds it, and a daemon
self-update adds it to an existing task without stopping it. CLI only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent's command on Windows no longer posts as its owner

When an Agent's shell on Windows lost its `XMATRIX_*` environment and the
process between it and the Agent wrapper had exited, `xmatrix send` fell back to
the owner's saved login and posted the Agent's text under the person's name.
The CLI now also recognises an Agent's command by the wrapper's Windows Job,
which every process the Agent starts belongs to, and refuses the owner's login
there. CLI only. Recovery is a CI-validated beta reverting this change.

## Unreleased: `/model` right after a reborn is applied, and a refused model's quota is read

A `/model` sent in the seconds after `:reborn`, while the old Run was still
recorded as running or stopping, was refused as "not connected" instead of
waiting. It now waits for the Instance's next report (up to fifteen seconds)
whenever the Instance has a Run and no connection, and is applied then. When
a provider refuses a model for quota and xMatrix holds no reading of that
model's own quota (the reading had lapsed), the refusal now asks the machine
for one fresh read of the account, so the Agents page and the next `/model`
say which quota is used up and until when; meanwhile, models that share the
refused model's quota are no longer listed as still available. Hub and DB.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a refused `/model` offers the step that gets what was asked

The answer to a refused `/model` now carries one button for the person who
wrote it. When the model's provider quota is used up on the Instance's
machine and another online machine of the Space runs the same Agent with
quota for that model, **Continue on <machine> with <model>** hands the Instance's work to
a new one there on that model (an ordinary handoff; the answer says it stops
the Instance first). It is offered only for a repository-backed Instance and
only for a machine whose own account reading shows quota for that model. A
statement sent to an Instance that is still starting now waits for the
Instance's first report (up to fifteen seconds) and is applied then; only if
it does not come up is it refused, with **Send again**. The answer no longer
says "Instance answered" for a refusal the Instance was never asked about. Machines are
named as their owners named them, which is what `machine:` selects. An
Instance that has reported no model catalog yet (its first turn still runs)
is asked as written, since its runtime holds the catalog; before, the Hub
refused it. `xmatrix channel history` marks used-up models in a listing.
Hub, DB, Web and CLI. Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent that cannot take work is listed under @ with why

The @ list showed only Agents ready to take work, so an Agent that was enabled
but could not run (its model unavailable, not set up on its machine, or
needing Space setup) disappeared, and nobody could tell it from one that was
never added. On 2026-11-16 antigravity vanished this way: its default model was
not in the catalog its updated harness reported. It is now listed greyed out
and cannot be chosen, with the reason where its description would be. An
Agent its owner turned off on its machine is still left out. Web only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a refused `/model` says why, and what is true of the Instance

Four `/model claude-fable-5-2` statements to one Instance failed with three
different answers, none of which said what to do: `no such running Instance`
for one that was still starting, `is not one this instance offers` for a
model it did offer, and the provider's raw `API error: 429 … Please try again
later` for a model whose weekly quota was used up for three more days.

- A model whose provider quota is used up is refused before the Instance is
  asked, so its running turn is not interrupted: "the provider quota for
  claude-fable-5-2 on <machine> is used up until 2026-11-19 18:00 UTC.
  @claude:3 stays on claude-opus-5-5." A provider refusal with no reading
  behind it names the machine and model the same way.
- `/model` with no value marks the models that are used up, and until when.
- A switch is decided by the model catalog the Instance row keeps. A Runtime
  cell that had hibernated lost its copy and refused every model.
- An Instance that is starting, asleep or stopped is told apart from one
  that does not exist, and a model outside the catalog lists what is offered.
- `xmatrix channel history` prints what each command came to (`[result]`
  lines under the message), which only the web showed before.

Hub, Web and CLI. Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent's default model no longer leaves it unable to run

Setting a default model for an Agent whose machine declares no models, such as
antigravity or Claude added with `xmatrix agent add`, marked it
`model_unavailable`: every launch dropped it, because a Space's model had to be
one the machine's owner declared. Such an Agent now runs the Space's model from
its harness's own catalog, the same way a summon naming a catalog model already
did. This needs a daemon that switches the runtime to a catalog model, and a
summon naming another catalog model still runs that one. The Agents page also
adds a model to the owner's grant before saving it as the default, as
`xmatrix agent model` does; before, saving a model the grant did not list
failed. Hub, DB and Web. Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent can set which model its owner's Agents run

The model an Agent runs when a launch names none (**Default model** on the
Agents page) could only be changed by a person in the app. The CLI now has
`xmatrix agent model <harness> [<model>|--clear]`, and an Agent Run can use it
as its owner, for its owner's Agents in its own Space: a conversation can now
ask an Agent to move antigravity off a model that has no capacity, for
example. A Run changes only the model. A configure that touches anything
else, or a grant change that does more than add models, is refused, and each
must name the version it read. CLI and Hub. Recovery is a CI-validated beta
reverting this change.

## Unreleased: "Following" a pull request no longer wakes every Agent in the conversation

When a Run opened a pull request, GitHub's "Following repo#N in this
conversation" line (#1710) was appended as an ordinary App message: it woke
every resting Instance in the conversation, reached every live one as work,
and counted as unread, although the line is context that reports what the
Run just did. Whether a message is an activity entry was marked twice (its
`activity` provenance and its `xmatrix.activity` kind) by each writer, and
whether it is context was decided twice (live delivery read the provenance,
the App wake path did not). Both now come from one protocol rule: the
append derives the kind from the provenance, and every delivery path reads
`isAgentContextMessage`. An App's own events (CI verdicts, reviews, merges)
still wake and reach Agents as work. Hub only. Recovery is a CI-validated
Hub beta reverting this change.

## Unreleased: a pull request's GitHub messages read as one connector story

What GitHub reported about a pull request an Agent opened (CI passed or
failed, merged, closed, reviews, comments) came as full messages, while the
Agent's own "Opened #121" was a small activity line, so the two looked
unrelated. They are now GitHub's messages, on the same tinted slip as every
other connector, and show the whole path: when the Hub subscribes the
conversation, GitHub says it is following the pull request here (context for
Agents, never unread); a run of facts is one GitHub message with an entry per
pull request, its current mark, `#121` and title, and its steps (`opened by
claude:1 · following here · CI passed · merged · stopped following`). A
review or comment is a GitHub message with the person's words whole. Older
messages keep their look. Hub and Web. Recovery is a CI-validated beta
reverting this change.

## Unreleased: a Codex conversation another process still holds is said once, with who holds it

When Codex refused to resume an Agent's conversation because another live
Codex process on the same computer still had it open (`thread … already has
an active writer`), every Run of that Agent failed with Codex's bare refusal,
and each message in the Channel posted another copy of it. The CLI now records which Codex process and
xMatrix process opened each Agent's conversation, and a refused resume fails
with `harness_session_in_use`, naming that process when it is still running
and saying to end it (or the Run it serves) and send the message again. The
conversation is kept: no new one is started in its place. The Hub posts that
failure once per Instance, Channel and holder, so later Runs failing the same
way add nothing. CLI, Hub and protocol. Recovery is a CI-validated beta
reverting this change.

## Unreleased: an Agent's runtime connect retries a lock timeout once

A Channel row is held by whatever changes it, and a private connector result or
an upload's multi-step commit can hold it for the seconds that commit takes. An
Agent's `runtime.instance_connect` waiting on that row was refused at its
two-second lock timeout (Sentry HUB-BE; the latest holder was a
`content.ref.commit` in `content_ref_insert_v1`), while message appends already
replayed one. Runtime mutations now use the same one bounded replay: a
`55P03` lock deadline has already rolled the transaction back, so the command
runs once more on a fresh session; every other answered rejection still
escapes. Hub only, no migration. Recovery is a CI-validated beta Hub reverting
this change.

## Unreleased: a program that is not signed in gives its owner two answers

The card for a program that could not take work because it is not signed in
on its machine offered one thing, the sign-in. A person who does not mean to
use that program there had no way to say so, and work kept being sent to it.
The card now gives its owner two buttons, Sign in and one that names what it
disables and where ("Disable Claude Code on mac-mini"), with no sentence explaining it. It is the owner's existing switch for the
Agent on its machine, in every Space, so nothing more is sent to it; the card
then says it is disabled and links to Agents, where the same switch turns it
on again. The welcome
conversation's sign-in row offers the same. An Agent's own request for a
sign-in, and a machine with no Agent in the Space, keep the sign-in alone.
Web only. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: A machine's versions show what their update is really doing

A machine with automatic updates on still showed a yellow Update beside its
versions, and the desktop App applied a downloaded update only when someone
quit it, so a Mac left open stayed on an old build. Seeing this machine's App
behind its channel now starts one quiet update check at once (once per release
per page), and the mark shows only the updater's real state: checking,
downloading with progress, or downloaded with Restart to update. A downloaded
update also applies itself once the person is away (idle five minutes or
the screen locks); the daemon runs separately, so Agents keep running. Seeing a
Machine's CLI behind asks its daemon to check once (per Machine and release, per
page), and the mark shows what the daemon reports: checking, updating to vX, or
the failure. A component that did not update reads "Not updated" with the
reason and the fix in place. Betas are judged against the dev channel they follow. Beta Web and
desktop; recovery is a CI-validated release reverting this change.

## Unreleased: typing a `norn run` fence on a Page keeps its name

Typing a fence that starts `norn` and then a space on a Page opened a code
block tagged only `norn`, and the name never landed, so the block was not a
program and the Page said nothing. A space still opens an ordinary language
such as `ts`.
Enter opens a fence whose info has a space in it, and the block keeps the
whole string `nornRunBlock` reads, including a name in any language. Web.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a slow Gmail notification pass keeps its lease

A mailbox draining a backlog of new mail delivers one message at a time, and a
message's automatic read can take longer than the two-minute claim lease. When
the lease ran out mid-pass, the pass's own ownership check then failed, the
notification that had just been posted was retried from the start on every
later pass, and each pass reported the fence as a failed notification pass
(one mailbox from 2026-11-16, about one error every two minutes). A delivering
pass now renews the lease it already holds before each message, and a mailbox
fence (`409`, the lease moved to another pass or the owner revoked access) is
an expected stop that retries quietly instead of being reported. Hub only, no
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a Gmail notification retried after its read was saved is delivered

A mailbox's new-mail notifications stopped for good when a notification pass
failed after its automatic read had been saved privately: every retry wrote
the private record again with the same command ids but a new expiry, which
was refused as a reused command, so the mailbox paused with its later mail
behind it (one mailbox from 2026-11-13). Each private-record write now uses
its own commands for the same record, a connector result already saved for
its message stands, and a retried notification pass is reported to Sentry by
its error class, code and status. Hub only; a paused mailbox resumes on its
own and delivers what waited. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a turn refused for its model's quota continues on another model

When a turn is refused because its own model's quota is used up (Claude's
`Fable` week), the quota retry its author chooses resumes the Instance at once
in the same session on another model of the same harness that has quota,
chosen the way a launch chooses (the runtime default first, then its catalog,
or the registration's declared models, never one the refused scopes
constrain), instead of waiting for that model's reset; with none, or when the
registration no longer offers the kind of model it ran, it waits as before.
Its next resume goes back to the original model once a reading shows that
model has quota. A resting Instance wakes unless the model it last ran is used
up. The Agents page and Instance tags name a model's own window by its scope
(`Fable · 1w`), and a summon naming a used-up model says until when. The
stored `remaining` of a reading now agrees with the windows kept used up. Hub,
beta Web and protocol, with expand migration 0258
(`agent_quota_retries.resume_model`, so a redelivered dispatch resumes on the
same model); the resumed model reaches the runtime as the preferred or
requested model a launch already sends. Recovery is a CI-validated beta
reverting this change; the column is then ignored.

## Unreleased: an Agent that delegates its request is let go

An Agent whose Run was started for a Norn request and then delegated it with
`xmatrix delegate` stayed in the conversation; it is now let go like one
whose request ended, unless it still holds another request or waits on a
question. An Instance delegated a request by its address is told that
answering does not end its Run. Hub only; expand migration 0257 adds
`norn_requests.delegated_away_instance_id`. Recovery is a CI-validated beta
Hub reverting this change; the column is then ignored.

## Unreleased: an Agent can call off a question it asked

`xmatrix cancel <request>` lets the Agent Instance that asked a question with
`xmatrix confirm`, `choose` or `ask` call it off while it is open. The
request ends `Cancelled`, the person's card says it is no longer asked, and
the Agent reads the program's end. Only that Instance can, and only for such
a question. Hub only, no migration. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: whoever holds a request of a Norn program can delegate it

A person asked on a card can delegate the request to an Agent in the
conversation (`@claude:2`), an Agent by name, or another member, who answers
it for them; while it is open, **Take back** returns it. An Agent delegates
with `xmatrix delegate`. The delegate's answer settles the request; their
refusal gives it back. Norn is vendored at norn-lang/norn#41, which defines
delegation; the program does not see it. Hub and beta Web; expand migration
0256 adds `norn_requests.delegator_user_id`. Recovery is a CI-validated beta
reverting this change: the column is then unused, a request delegated to an
Instance meanwhile ends `Broke` at its next pass, and one delegated to a
person or an Agent by name stays with them.

## Unreleased: quota is read per account and model

A provider's quota now has two kinds of window: account windows, which stop
every model, and scoped windows, which stop only the models whose catalog row
names their scope (Claude's per-model week such as `Fable`, Cursor's `Auto`
and `API` pools). A launch drops a used-up model before Jev chooses, including
the runtime default when that is the used-up one; a pool is refused whole only
when its account, or every model it could run, is used up, and a model the
author named is refused with when it is back. A turn refused for one model's
quota no longer holds the pool or hands the work to another harness: its
reading is recorded and the quota retry waits on that model's windows alone.
A limit the daemon could not tell holds the pool until its reset and asks the
machine for a fresh complete reading on the next launch, Channel refresh or
reconnect; that reading releases the hold or narrows it to the window
resetting with it. Hub's Cursor special cases are gone. Hub only, with expand
migration 0254 (`registration_quota_observations.scoped_windows_json`,
`scoped_observed_at`, `scoped_expires_at`; `windows_json`/`observed_at`/
`expires_at` are the account part). A daemon that predates scopes behaves as
before: its usage limit holds the whole pool and hands off. Recovery is a
CI-validated beta Hub reverting this change; the added columns are ignored.

## Unreleased: the retired Automation storage is dropped

Contract migration 0253 drops `data.automation_occurrence_runs`,
`data.automation_occurrence_conversation_id(text)`, `data.automation_occurrences`
and `data.automations`, which no code reads or writes since #1682. It refuses
while any Automation is still enabled and attached to its page; paused,
finished and detached rows go with their tables. An administrator applied it
through the PostgreSQL Contract Migration workflow at this change's reviewed
PR head before it merged. No product change. Recovery is forward only: the
rows held no Automation that could run.

## Unreleased: schedule lines no longer run; scheduled work is a `norn run` program

A task line ending in `🔁 every …` or `⏳ <time>` is plain text: the Hub does
not sync it, fire it on an event or run it. An Agent edit that leaves one on a
page is answered with the line and the advice to write it as a program, a code
block tagged `norn run <name>` on the same page. Schedules lists are empty, and
a CLI's `page automation` commands answer that schedule lines are retired.
Hub only, no product change: the Automation tables it left behind are dropped
by contract migration 0253. Recovery is a CI-validated beta Hub reverting this
change; the rows are gone, so a revert cannot resume an Automation.

## Unreleased: signing out of an app, or choosing a provider, leaves the browser's account

After an app signed in with the browser's web session, signing out of the app
(including "Use a different account" on a new account) landed on the sign-in
page, which signed straight back in with that same account. Choosing Google or
GitHub also returned the browser's account without opening the provider, so
no other account could be picked. A sign-in start now declares one intent:
only the app's own check of the browser session reads it, and a chosen
provider always opens with its account chooser. An app window where the person
signed out does not resume the browser session. The desktop app's browser tab
no longer reads "Sign-in didn't finish" when the browser simply isn't signed
in. Hub, beta Web and desktop, no migration. Recovery is a CI-validated beta
reverting this change.

## Unreleased: an app uses the browser's existing sign-in

Opening the desktop or phone app no longer asks for Google or GitHub when that
browser is already signed in on the web. The app's sign-in reads the browser's
session and hands the app a code for that account; with no session it returns
to the app's own provider buttons. The connect card no longer tells a person
to sign in with the same account. Hub and beta Web, no migration. Recovery is
a CI-validated beta reverting this change.

## Unreleased: DeepSeek Harness is offered full access alone

A DeepSeek Agent could be added asking first. In that mode xMatrix leaves
DeepSeek Harness on its own `workspace-write` sandbox, which refuses the
write every `xmatrix` command makes to `~/.config/xmatrix`: the Agent could
not send a reply, and the sandbox fails the command outright instead of
asking, so no card appeared either. The confirmation now offers DeepSeek
Harness full access alone and the Hub refuses `ask` for it, as for Codex and
ZCode. Hub and Web. Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent can be added asking first

Confirming an Agent's access offered full access or nothing. A harness can now
be added with `ask`: xMatrix adds none of the full-access parameters, the
harness runs on its own defaults, and each time it wants permission for a file
or a command the request appears as a card in the Channel it is working in,
with the answers the harness offers, and waits for a person. One plain
`xmatrix` message, page or read command is not asked about, so the Agent can
still reply. Claude Code and the ACP harnesses can be given `ask`; Codex and
ZCode are offered full access alone, and the Hub refuses `ask` for them. The
add dialog and `xmatrix agent add --access ask` choose it, and the owner
changes it later from the Agent's page or with
`xmatrix agent access <harness> <full|ask>`. An `ask` launch runs only on a
Machine whose CLI shows the cards; on an earlier one it does not start. Claude
Code's grant now also states that its permission requests are answered with
allow in full access, which the runtime always did. No schema change. Hub, Web
and CLI. Recovery is a CI-validated beta reverting this change.
## Unreleased: the access confirmation works for a harness never added on the machine

The confirmation reads the owner's environment for the harness before the
first add, and that read answered 404 until the harness had been added once,
so adding a new harness from the Web or `xmatrix agent add` failed instead of
asking. The owner now reads an empty environment, with what full access adds,
for a harness not added yet; nobody else reads it, as before. Hub only.
Recovery is a CI-validated beta reverting this change.

## Unreleased: a machine's owner confirms an Agent's access when adding it

Adding an Agent started its harness with full access without saying so. Every
add now shows, word for word, what xMatrix adds to that harness's launch
(arguments, environment variables, session settings, and whether its
permission requests are answered with allow) and writes nothing until the
machine's owner confirms. `xmatrix agent add` prints the lines and takes
`--access full`; at a terminal it asks, and anywhere else it stops and says
what to show the owner. The Web asks in one dialog from the New agent page, a
harness switch, an install that turns its harness on, and "Bring them in". The
confirmation is kept per harness on a machine, so adding the same harness to
another Space does not ask again. An Agent Run cannot confirm for its owner:
it adds only a harness already confirmed there. Agents added earlier keep
running as they were; their page, `agent list` (new ACCESS column) and
`agent show` report the access they run with, and their owner can confirm it
from the page. No schema change. Hub, Web and CLI. A CLI or Web released
before this adds without the confirmation, reported as unconfirmed. Recovery
is a CI-validated beta reverting this change.
## Unreleased: a client that predates balances no longer draws a prepaid account as "100%"

A DeepSeek account's reading was listed under `live.quota` with a full share
of headroom, so a CLI or Web older than the balance display printed "100%"
beside an account holding a few yuan. A prepaid reading is now listed as
`live.balance` (amount, currency, the provider's verdict) and no `quota`:
older clients read nothing and show `-`; this CLI and Web show the money.
Routing is unchanged. Hub, Web and CLI; a 4.2.1-beta.22 CLI shows `-` for the
account until it updates. Recovery is a CI-validated beta reverting this change.

## Unreleased: what xMatrix adds to a harness launch is declared once and reported

xMatrix starts each harness so it stops asking before it touches files or runs
a command, and did so from five places: Claude Code's
`--dangerously-skip-permissions` in its preset's default arguments,
Antigravity's in its ACP arguments, Grok's `--always-approve`, Codex's
`sandbox=danger-full-access` and `approvalPolicy=never` and ZCode's
`mode=yolo` hard-coded in the daemon, and the ACP bridges answering every
permission request with allow. Each preset now declares its own under
`access.full`, DeepSeek Harness's `DSH_PERMISSION_MODE=danger-full-access`
among them, and the Hub resolves them into one grant per launch
(`docs/design/agent-access.md`). The daemon applies that grant and nothing of
its own, and the registration catalog reports it, so what is shown is what
runs. A registration launch may carry `access` (`full` or `ask`); none is
`full`, so every existing Agent launches with exactly the parameters it had.
The undocumented `XMATRIX_CODEX_APP_SANDBOX`, `XMATRIX_CODEX_APP_APPROVAL` and
`XMATRIX_ZCODE_APP_MODE` overrides are gone. No schema change: the launch is
a JSON declaration. Hub and CLI; a Machine on an earlier CLI keeps its
hard-coded behaviour and receives Claude Code's and Antigravity's flags in
the arguments the Hub sends. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a DeepSeek Agent can run xmatrix from its own shell

DeepSeek Harness kept its own default permission mode, `workspace-write`, so
its shell could not write `~/.config/xmatrix` and every `xmatrix` command an
Agent ran there stopped at `Operation not permitted (os error 1)` unless the
Agent raised its permission for that one call. xMatrix now starts it with
`DSH_PERMISSION_MODE=danger-full-access`: it may write outside the workspace
and no longer asks before each command, as the other harnesses already run.
The variable is listed in the preset (`access.full.env`), the same data the launch
reads. The harness also removes `XMATRIX_EXECUTION_KEY` from every command it
runs, which made `send --final-for` refuse; the CLI now reads the key from
the daemon's record of the Run whose request capability the command holds. A
refused write to the profile lock names the file. CLI and Hub (the registry
a Machine receives); it applies to DeepSeek Runs started after a Machine
runs this CLI. Recovery is a CI-validated beta reverting this change.

## Unreleased: a summon names its model by the model's name, not its selector

Picking a model for a summon wrote the id its harness selects the model with.
DeepSeek Harness selects with a JSON pair, so the message read
`model:"[""deepseek-official"",""deepseek-flash""]"`. The composer now writes
the name that harness's own catalog gives the model
(`model:DeepSeek-V4.1-Flash`) whenever the id would need quoting and no other
model in that catalog carries the name; otherwise it writes the id as before. The Hub already resolved a written name to its model, so
the launch is unchanged, and a message already sent keeps the text it was
written with. Only a registration that uses the runtime's own catalog is
affected; an owner-declared model list is still matched exactly. Beta Web
only. Recovery is a CI-validated Web release reverting this change.

## Unreleased: a DeepSeek Agent shows the balance left on its API key

A DeepSeek Agent's card and its `xmatrix agent list` row said nothing about
quota, because DeepSeek has no window to meter: an API key is billed against
a prepaid balance. The runtime now reads DeepSeek's balance endpoint with the
key DeepSeek Harness already holds and reports the money left with its
currency: a tag on the card (`¥12.34`), "Balance" on the Agents page, and the
QUOTA column of `agent list`. An account DeepSeek says can no longer pay for
a request reads as out of quota, so routing passes it over. A missing or
refused key leaves the reading absent, as before. The daemon's pre-launch
quota read also covers OpenCode, whose quota was only known while one of its
Instances ran. No schema change. Hub, Web and CLI; the balance appears once a
Machine runs this CLI. Recovery is a CI-validated beta reverting this change.

## Unreleased: an execution report the Hub can never store is answered once

A daemon keeps each execution report until the Hub gives it a receipt and
sends it again every five seconds until then. A report whose Run is gone was
answered 403, and one that conflicts with what the Hub already holds 409, so
those reports came back forever: about 400,000 of the Hub's 470,000 requests
a day, each one a Postgres transaction. The Hub now answers both once with a
final receipt (`source_unavailable` / `superseded`, with a reason). Released
daemons already accept those, so their queues drain without a client
update. Nothing is stored for those reports. Hub only. Recovery is a
CI-validated beta that reverts this change.

## Unreleased: On a Mac or PC, bringing agents in starts with the app

Most new people left within half a minute of being shown a terminal command.
On a Mac or Windows browser the first step is now the desktop app: one button
downloads the installer for the system, and the app connects the computer and
finds its agents once its owner signs in. The command is one click away
("Use a terminal instead"); Linux, with no app, still starts with it. Inside
the app the step says it is connecting this computer instead of showing a
command. Beta Web only; recovery is a CI-validated Web release reverting it.

## Unreleased: a `norn run` block whose name runs nothing says why

A Page block tagged `norn run 2nd-pass` (or `v1.2`, or two words) never ran:
the Hub read only names that start with a letter, passed the block over and
said nothing, while the Page drew it as a program "starting…" for good and
`page edit` reported no problem. What a block's info string makes of it is
now one function in protocol (`nornRunBlock`) that the Hub and the Page
editor both read. A misnamed block is reported by `page edit`, by `page
read` and under the block on the Page; a message carrying one is refused
with the same words. An edit whose sync finds a block whose conversation was
deleted now says so in its answer too, as the Page already did. Hub and Web.
Recovery is a CI-validated beta reverting this change.

## Unreleased: an Agent's `page read` shows the Page's programs

`xmatrix page read` printed no `programs:` section when an Agent ran it: the
route it reads was not among those an Agent Run's credential may call, and
the CLI prints nothing when that read is refused. A person's CLI showed it.
The route is now allowed for an Agent Run, read-only. Hub only. Recovery is
a CI-validated beta Hub reverting this change.

## Unreleased: an Instance whose first start never became ready is not started again by each message

A harness that refused to start because it was not signed in left its new
Instance "interrupted", so every later message in that conversation woke it,
failed the same way and posted the sign-in notice again: five notices in
three minutes on 2026-11-14. Such Instances have existed since routing
stopped refusing these launches beforehand (#1630). An Instance's first Run
that connects and then ends before its agent is ready now leaves nothing to
wake, like a Run that never connected. An Instance that has worked and fails
a later start stays wakeable, so the first message after the sign-in resumes
it. Hub only. Recovery is a CI-validated Hub beta reverting this change.

## Unreleased: a machine can be asked, now, whether one program is signed in

The only way to learn whether a harness is signed in from xMatrix was the
machine's whole inventory: every preset probed, every registry read, each
status-less ACP harness started. That takes many seconds (16 on a server with
four harnesses), so pages showed the reading from the daemon's last probe,
up to six hours old. The daemon now answers a `check` for one preset: its
status command (Claude Code 0.3 s, Codex 0.1 s), or for an ACP harness with
none, one start the way a launch starts it. It changes nothing. Nothing uses
it yet: the pages that show a sign-in move to it next, and then the stored
reading goes. CLI and Hub. A daemon without `machine_harness_check_v1` is
never issued or leased a `check`. Recovery is a CI-validated beta reverting
this change.
## Unreleased: a handoff whose successor cannot start goes on to the next Agent

On 2026-11-13 an Agent that ran out of quota handed its work off with
`handoff:@auto`; routing chose a harness that was not signed in on its
machine, its start failed with the sign-in notice, and the work stayed with
nobody for eleven hours. Since routing stopped keeping a record of sign-ins
(#1630), nothing kept a handoff away from such a harness, and unlike an
`@auto` summon a handoff had no second try. A handoff's successor that fails
to start, or refuses its first turn as signed out, now passes the same
handoff (its prompt, the predecessor's conversation and the author's
conditions) to the next Agent, never one it already tried or its source, up
to three times. A handoff to a harness its author named is not replaced.
Hub only. Recovery is a CI-validated Hub beta reverting this change.
## Unreleased: A turn that makes no progress is said in its conversation

An Agent that accepted a message and then neither replied nor failed left the
person looking at nothing: the host already reported the stall (no progress
for five minutes), but only as a small badge on the Agent. The Hub now says it
under the message the turn is answering, once per stall, in the failure
notice's style: which Agent, for how long, and that it can be waited for,
stopped (`@name:N:stop`) or another Agent asked. Hub only; no protocol or
schema change. Recovery is a CI-validated Hub release reverting the notice.

## Unreleased: a summon reaches its machine, and the program says whether it is signed in

On 2026-11-13 summons to Claude Code on a signed-in machine were refused as
"not signed in". The Hub kept its own record that the program had refused
earlier turns as signed out, answered by a later machine report; a sign-in
from the card updated the Hub's copy of that report, and a daemon reconnect
40 minutes later overwrote it with the daemon's older copy, so the refusal
stood again. The same record had refused a recovered program on 2026-10-22.
The Hub no longer keeps or reads that state for routing: a summon is given to
its machine, and a start or first turn the program refuses as signed out
shows its sign-in where it failed. An `@auto` message that Run never answered
goes on to the next Agent; any other is sent again from the notice once the
program is signed in. A summon to a program that really is signed out is
therefore answered a few seconds later, by the program, instead of at once by
the Hub. A handoff whose successor turns out signed out now starts that
successor, which shows the sign-in; after signing in, send it a message.
Hub only. Recovery is a CI-validated Hub beta reverting this change.

## Unreleased: code draws in Cascadia Code, a Norn pipe as a spaced arrow

Code named a monospace font the app never shipped, so it drew in each
machine's own (SF Mono on a Mac), and a Norn program read as
`after(2027-06-04T00:00Z)->wait`: the pipe jammed between two words and the
time split into a number, a dash and loose digits. Code now draws in Cascadia
Code, self-hosted like Inter, whose ligatures join `->`, `=>`, `>=` and `!=`
into one sign each; a Norn pipe written tight is drawn with a character's
room on each side, as `=>` is written, and a date or UTC time takes one ink.
The program's text and a copy of it are unchanged. Web only. Recovery is a
CI-validated beta Web reverting this change.

## Unreleased: a request card says it waits for the reader's answer

A request card that takes a written answer did not tell the person asked
that an answer was wanted: the line to write on was a grey pencil and grey
words, the whole of the program's text ran together as one bold headline
with a Page's raw reference in it, and the message carried the tag
"system fact". The card now leads with the first paragraph of what is
asked and sets the rest under it as text, with a Page or Channel it names
drawn as a link; the person asked reads "Waiting for your answer", and the
line to write on is in the card's brass until they write. The message
carries no "system fact" tag. Web only. Recovery is a CI-validated beta
Web reverting this change.

## Unreleased: a program's question is answered on the card itself

The field on a request card a Norn program sends was a bare underline over
the app's grey input well: the words touched its edge, it showed a resize
grip, and Send and Decline sat under it at equal weight. The answer is now
written on the card, as a pencil and a line that grows with what is
written, the composer's round Send at its end and Cmd or Ctrl and Enter
sending it; Decline is a quiet word at the end of the line saying who
asks. A choice shows only its options until one that takes words is
picked. Web only. Recovery is a CI-validated beta Web reverting this
change.

## Unreleased: a delivered request is read in full, as paragraphs

Cutting a delivered request down to a one-line chip hid the task behind a
hover. The delivery message now shows the whole request in place: the
paragraphs it was written in, in the message's own body text with no
highlight, under a small line saying whom it waits for or how it ended, and
the answer once there is one. A reference to a request inside a sentence is
still the short chip. Web only. Recovery is a CI-validated beta Web
reverting this change.

## Unreleased: a long request stays a short chip

A request's chip carried the whole first line of what was asked. A
program's task is often one long paragraph, so its delivery message drew
the entire task as a wall of highlighted lines that nobody could read. The
chip now says how the request starts, stopping at a sentence or a word,
and its preview shows the whole request as body text in a wider panel that
scrolls. The chip's mark is a task sheet instead of a question mark in a
bubble, which read as a fault beside a task that is under way. Web only.
Recovery is a CI-validated beta Web reverting this change.

## Unreleased: a request's reference reads as the request

Messages about a Norn request named it by its reference (`rhqycstuhxc`),
which tells a reader nothing. A reference is now written `request:<ref>`
and the Web draws it as the request itself: what is asked, of whom, and
whether it waits or how it ended, for whoever can read the request's
conversation. The card a person is asked on carries no reference in its
text. Agents still answer by the bare reference. Hub and Web. Recovery is
a CI-validated beta Hub and Web reverting this change.

## Unreleased: a request card says what it asks where conversations are listed

A request a Norn program made of a person read, in the list of
conversations, as "Request `r343twe5ccg` from a program" under a title made
of the Page's name and the block's English slug: thirteen such rows told
their reader nothing. The card's message now starts with the question
itself, and a program block's name may be a word in any language, so the
conversation is called what its author calls it. Hub only. Recovery is a
CI-validated beta Hub reverting this change; a block named outside ASCII
then stops being read as a program.

## Unreleased: an Agent that works for half an hour and says nothing is asked last too

The breaker for an Agent that connects and does nothing counted only first
turns under 30 seconds. A Grok on the same machine took 28 and 43 minutes
over its last two summons and ended both without a reply; it was chosen in
place of the Cursor the breaker had just moved back. Over seven days no
healthy environment ended two summons in a row unanswered, so the time
limit is gone: three summons in a row that end without a reply, the latest
within 24 hours, put the environment last. Hub and Web. Recovery is a
CI-validated beta Hub and Web reverting this change.

## Unreleased: an Agent that connects and does nothing is asked last

A harness that started and connected but ended every turn in about nine
seconds, saying nothing and reporting no error, kept taking `@auto` work:
routing saw no failure. In our Space a Cursor did this to 24 summons in a
row over two days, among them the daily scheduled jobs sent to it, which
therefore did nothing. An environment whose last three summons all ended
that way (first turn under 30 seconds, no reply), the latest within 24
hours, now ranks after every environment that answers, the same way an
environment that just failed to start does; the summon's reason says so.
An answer to a Norn request now counts as the Run's first reply. Hub and
Web. Recovery is a CI-validated beta Hub and Web reverting this change.

## Unreleased: a Hub build that cannot read a Norn program does not end it

A pass that could not check a program's text stopped the program for good
("The program no longer checks"). Text is checked where it is written, so
that only happened across builds: a Durable Object still on the previous
build during a rollout, or the whole Hub after a rollback, would end every
program that used a newer word of the language. Such a pass now leaves the
program and its ledger untouched and tries again five minutes later; a stop
is still taken. A request handed to another holder also no longer keeps the
person it was first delivered to. Hub only. Recovery is a CI-validated beta
Hub reverting this change.

## Unreleased: a request a changed Norn program no longer makes is called off

When a Norn program's text changed while one of its requests was out, the
program asked again in the new words and left the old request open: its
Agent went on working for a program that would never read the answer, and a
person's card kept waiting on them. The Hub now ends such a request as
`Cancelled` in the pass that finds it unreached, so the Agent is let go and
the card says the program no longer asks. Hub only. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: an event that arrives during a round of a Norn program is not lost

A Norn program heard an event only while it waited on the stream. A second
CI failure, or a second Sentry issue, that arrived while the round the first
one started was still running was dropped; the scheduled jobs these programs
replaced had coalesced such events into the next run. Norn is vendored at
norn-lang/norn#39: a program listens while a round of its loop is out, the
events that arrive are kept in its ledger, and when the round is over they
are one more round with the latest event. `->gather` hands the handler all
of them as a list. Hub and Web (the onboarding text). Recovery is a
CI-validated beta Hub reverting this change; events kept in a ledger and not
yet taken are then never handled.

## Unreleased: Agents are taught Norn programs, and told when one does not run

An Agent's launch prompt, the onboarding prompt and the xMatrix skill still
taught schedule lines (`🔁`, `⏳`), so Agents kept writing them after the
work they describe had moved to Norn programs. All three now teach programs:
a `norn run` block for a routine, a dated reminder, an event and a question
to a person. `xmatrix page edit` answers with each program block that does
not run as written and why, as it did for schedule lines. Hub, Web and CLI.
Recovery is a CI-validated beta Hub, Web and CLI reverting this change.

## Unreleased: a Norn program can open the standard library

A Norn program on the Hub was checked against the built-ins alone, so every
repeating operation moved to Norn wrote out the same loop: its beat, the
round, and the fallback when the first participant did not answer. `open Std`
now gives a program Norn's standard library, vendored at norn-lang/norn#38:
`routine` is that loop in one call, `decide` a choice whose default is taken
only when nobody answered in time, with `remind`, `followUp`, `schedule` and
`all`. Programs that do not open it are unchanged. Hub only. Recovery is a
CI-validated beta Hub reverting this change; a program that opens the
library is then refused at its next pass with the unknown name.

## Unreleased: an Agent asks a person with a command and gets the answer back

An Agent blocked on a person's decision mentioned them with `--wait` and
hoped for a reply: no form for the answer, no deadline, and nothing that said
what silence meant. An Agent Run now asks with `xmatrix confirm`, `xmatrix
choose` or `xmatrix ask`: the Hub writes the Norn program into the Run's
conversation, the person answers on a card, and the answer comes back to the
Run as the program's result. `--by` closes the question at a time and
`--otherwise` names the answer taken then. The Agent contract tells Agents to
ask people this way and keeps `--wait` for waiting on another Agent. Hub and
CLI. Recovery is a CI-validated beta Hub and CLI reverting this change.

## Unreleased: a Norn program can ask a person

A Norn program could ask Agents only: a request of `@Daniel` ended at once
as undeliverable, so anything that waits on a person stayed a `--wait`
message or a line of prose. A holder that names a person is now found among
those who can read the conversation, and the request is delivered as a card
that waits on them: Yes and No for `confirm`, the options for `choose`, a
field for `ask`, and Decline. Only that person's answer is taken, and it is
checked against the request's type. The request stays open until they
answer, its deadline passes (`NoReply`), the program ends, or they lose
access to the conversation; the card then says how it ended. Expand
migration 0252 adds `norn_requests.holder_user_id`. Hub and Web. Recovery is
a CI-validated beta Hub and Web reverting this change; an open request of a
person is then settled as abandoned at its program's next pass.

## Unreleased: a repeating Norn program can keep a time of the day or the week

`every(7d)` in a Norn program ticked a whole number of periods after the
program started: its first round came a week after it was written, on
whatever weekday that was. A weekly operation moved to Norn would have
skipped a round and changed its day. Norn is vendored at norn-lang/norn#37:
`every(7d, ~from=2026-11-16T09:00Z)` counts the beat from that time, so the
first round is then. Without `~from` nothing changes. Hub only. Recovery is
a CI-validated beta Hub reverting this change; a program that uses `~from`
then stops with the label named.

## Unreleased: `xmatrix page read` says how a Page's Norn programs stand

An Agent that read a Page saw its `norn run` blocks as text only: whether a
program was running, where its work was discussed and how its latest request
ended showed only in the Web. `page read` now prints a `programs:` section in
its header, one line a block, from the route the Page's steps are drawn from.
CLI only. Recovery is a CI-validated beta CLI reverting this change.


## Unreleased: a failed round of a repeating Norn program is told in its conversation

When a round of a repeating Norn program ended in anything but an answer
(refused, broke, nobody replied), the loop went on and nothing was posted:
the failure showed only in the steps under the program on its Page. The
round's outcome is now posted once to the program's conversation as xMatrix,
naming nobody, through the same notices a program's `say` uses. Hub only.
Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: rewording a repeating Norn program does not rerun its past rounds

A repeating Norn program was evaluated from its first round on every pass.
Rewording its task on the Page changed the identity of every past round, so
the program asked each of them again in the new words, one after another: a
loop three rounds old ran three extra rounds at once, and one a month old
would have run thirty. Norn is vendored at norn-lang/norn#36: when a round's
handler finishes, the ledger keeps where the loop stands, and later passes
begin there. Evaluation no longer grows with the program's age. Hub only.
Recovery is a CI-validated beta Hub reverting this change; ledgers written
meanwhile carry one extra entry that the older runtime ignores.

## Unreleased: a Norn program can map an event stream

A Norn program that waited on a mapped stream (`ciFailed(…)->map(…)`) ended
at once: the vendored runtime did not implement `map`. A program that listens
to several repositories therefore got a nested `either` and could not read
which event woke it. Norn is vendored at norn-lang/norn#35: a mapped stream
occurs when its stream does and the handler receives the mapped value. Hub
only. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a Norn program hears events from outside

A Norn program could wait for time and for answers only, so work that an
event starts (a failed CI run, a Sentry issue) had to stay an Automation. A
program now waits on `ciFailed("owner/repo")`, `prMerged("owner/repo")` and
`appEvent("sentry", ~feature="issue.created")`, alone or beside a beat
(`every(1d)->or(ciFailed(…))`). Each pass stores the streams the program is
left waiting on (expand migration 0251, `norn_programs.waits_json`); an event
that fires Automation triggers is also recorded in the ledger of each program
waiting on it, under the same authority rule, and the program runs at once.
Norn is vendored at norn-lang/norn#34, which lets a program wait on the
streams its own host declares. Hub only. Recovery is a CI-validated beta Hub
reverting this change; the column then stays unused.
## Unreleased: Stripe messages already in a Channel are cards too

The Stripe card reached only events that arrived after it shipped; a Channel's
history stayed five lines of record per event. The Web now reads such a
message's text (account, event, amount in minor units, status) and draws the
same card, so the whole history reads alike. The words for a Stripe event live
in one place the Hub and the Web share. Web only for what a reader sees; no
message is rewritten. Recovery is a CI-validated beta Web reverting this
change.

## Unreleased: a blocked network is not a signed-out Claude Code

A signed-in Claude Code failed turns with `Failed to authenticate. API Error:
403 Attention Required! | Cloudflare`, a block in front of the API. The
wrapper read the bare "failed to authenticate" as a sign-out, so the
conversation got "not signed in" cards and routing stopped choosing that
machine. Only a refused credential (a 401, an expired or missing one) counts
now; other failures show as the turn failure they are. CLI only. Recovery is a
CI-validated beta CLI reverting this change.

## Unreleased: an Agent whose name is not ASCII starts

An Agent with a non-ASCII name (for example `测试助手`) exited seconds after
every summon. The Hub accepts any
display name and binds the Run to it, but the wrapper took the name as given
only when it was ASCII letters, digits and `._-`, and folded any other name
into `xmatrix-agent`; the Hub then refused the handshake because the name did
not match the credential. The wrapper now sends the name the Hub bound the Run
to, and the sender hint keeps names over 64 bytes that the Hub allows. CLI
only. Recovery is a CI-validated beta CLI reverting this change.

## Unreleased: a Norn program can tell someone something

`say(@who, "…")` in a Norn program was computed and dropped: nothing reached
anyone. What a program says is now stored with the step that says it (expand
migration 0250, `norn_notices`) and posted to the program's conversation as
xMatrix, naming whom it is for. With `after(<time>)` this is a dated reminder
written as a program. Hub only. Recovery is a CI-validated beta Hub reverting
this change; the table then stays unused.

## Unreleased: a message in the conversation no longer fails a Norn request in progress

A newer message in a conversation interrupts the turns in progress there. The
Norn host read an interrupted turn as a turn that ended without an answer:
it settled the request `Broke` and stopped the Agent, 19 minutes into a
diagnosis in the case that showed it. An interrupted turn now leaves the
request with its Instance, which goes on in its next turn and may still
answer; the request is abandoned only once that Instance has ended a later
turn without answering, or is gone. Hub only. Recovery is a CI-validated beta
Hub reverting this change.

## Unreleased: a used-up Google Play quota is called a quota

When Google refused a Play call because its quota was used up (403 or 429),
the receipt told the reader to grant the account a permission and enable the
API. It now says the quota is used up and to try again later. Hub only; no
schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: Billing shows who used a Space's allowance and how it is counted

Settings → Billing showed one meter for the whole Space and no way to tell
which Agent or app used it. Each counted write is now itemized against its
author in the statement that counts it (`data.space_credit_usage`), and
Billing lists this month's credits (or a Free Space's writes) by Agent, app
and paid X calls, the total for you and your Agents, and how credits are
counted. The operator's own Space, whose credits are waived, showed 0; it now
shows what it really used, marked "not charged". The iPhone and Android apps
show the same. Expand-only migration 0249; usage before it appears as one
"counted before itemizing began" row. Recovery is a CI-validated Hub and Web
release reverting the change; the table may stay.

## Unreleased: a Stripe notification is a card

A Stripe event in a Channel was five lines of record: the account id twice,
the amount as `1000 USD (minor units)`, most events by their API type
(`customer.subscription.deleted`) and a status repeating the title. It is now
a card: the event in words with the amount in the currency's own units
(`Payment succeeded`, `10.00 USD`; zero- and three-decimal currencies
included), Stripe's reason under a failed payment, a dispute or a canceled
subscription, then the status when it adds something, the account, and a link
to the object's Stripe Dashboard page. The card reads in each reader's own
language, English or Chinese. The message text under it, which Agents, search
and notifications read, is two lines saying the same, written in the Space's
language setting. Any App event can carry such a card
(`xmatrixEventCard` on the message). Hub and Web, no schema change; a Web
older than the Hub shows the text. Messages already posted keep theirs.
Recovery is a CI-validated beta Hub and Web reverting this change.

## Unreleased: `xmatrix goal` works inside a Claude run

`xmatrix goal set` from a Claude Agent's own turn answered "no goal inbox is
bound to this shell", so a Claude Agent could not set the goal its runtime
says it supports. The wrapper starts the Claude process before it binds the
goal inbox, and exported the inbox to the child only when it was already
bound. The child now gets the inbox of the run's own Instance, which is the
file the wrapper binds and drains. CLI only. Recovery is a CI-validated beta
CLI reverting this change.

## Unreleased: a Norn program can carry work that repeats

Moving the company's scheduled work onto Norn programs needed three things. A
program's participant may carry conditions, `@auto(~repo="acme/app",
~effort="high")`, which the delivery writes into its summon (`repo`, `pwd`,
`machine`, `harness`, `model`, `effort`); an unknown one ends the request with
the reason. `every(d)` now keeps the program's beat instead of drifting by the
length of each round (norn-lang/norn#33). And a Run started for a request
reads that request and the linked Pages, not the conversation's history, so a
daily program does not hand each new Run a longer history. An automatically
chosen Agent is chosen anew for each request. Hub only; Norn is re-vendored at
e2ad669. Recovery is a CI-validated beta Hub reverting this change.
## Unreleased: reading Google Play tracks no longer deletes an upload in progress

`@googleplay:tracks` opened a temporary edit to list tracks. A Google account
has one open edit, so that deleted the edit another Agent was uploading an
app bundle into ("This Edit has been deleted"). It now reads each track's
releases directly and opens no edit; with an edit ID it reads that edit. The
guide states the one-open-edit rule for `release` and `edits.insert`. Hub and
protocol; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a used-up provider account's resting Instances stay resting

When an Agent's provider account ran out, its failure notice woke that
Agent's other resting Instances in the conversation. Each used the same
empty account, failed within a second and posted its own failure card and
handoff, so one message could produce several cards. A registration
whose quota pool reads empty now leaves its resting Instances asleep
(`registration_quota_exhausted`), and the first message after the reset
wakes them. The hold is also recorded before the failure notice commits.
Hub only; no schema change (#1578). Recovery is a CI-validated Hub release
reverting this change.

## Unreleased: A handoff refused for a signed-out successor shows the sign-in notice

When `handoff:@auto` (or a named handoff) found its successor's program signed
out on its machine, the only trace was a line under the handoff message ending
in `(registration_harness_signed_out)`. It now posts the same sign-in notice a
refused summon gets, naming the program and machine, and the handoff goes
again once the owner signs in. Hub only; no schema change. Recovery is a
CI-validated Hub release reverting the notice.

## Unreleased: an Agent's startup error on Windows reads as Windows wrote it

When an Agent failed to start on a Chinese Windows, its card showed the last
lines it wrote as mojibake: `cmd.exe`, running an npm `.cmd` shim, writes
messages such as 「系统找不到指定的路径。」 in the console's OEM code page, and
the stderr tail read them as UTF-8. A line that is not UTF-8 is now read in
the OEM code page, then the ANSI one (#1576). CLI only; Recovery is a
CI-validated beta CLI reverting this change.

## Unreleased: a page's Norn program asks the same Agent again instead of starting another

Every request of a Norn program started a new Run, so a review of three
rounds started six. A program on a Page now sends its next request for the
same participant to the Instance that last answered it for that program,
when that Instance still takes messages: the delivery is addressed to it,
starts nothing, and wakes only it. The program's Instances stay while it
runs and are let go when it ends. A program in a message, where the
conversation is shared, keeps starting and ending one Run per request. Hub
only, with expand migration 0248 (`norn_requests.instance_id`). Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: a page's program shows its steps

The one grey line under a `norn run` block is now the program's steps, joined
to the code as one surface: a row per request with the Agent's face and name,
what was asked, and the answer, how it failed, or how long it has left; then
how the program ended. A block that does not run as written says why there,
and the code is underlined where. Pressing the steps opens the program's
conversation. The Hub's program status gains each request's outcome and
times, and a report reads as its text. Hub and Web; an older Web against the
new Hub keeps its one line. Recovery is a CI-validated beta reverting this
change.

## Unreleased: ⌘F on a page finds in that page

On an open page, Ctrl/⌘+F opened the Space's search. It now finds in the
page: a flat paper slip where the search control stands shows "n of N" with
previous, next and close; every match is washed in wood, the current one in
full and scrolled into view. Enter and Shift+Enter step, Esc closes. The slip
does not cover the page, and matches follow the text as people and Agents
change it. In a conversation ⌘F still opens the Space's search. Web only;
recovery is a CI-validated beta Web reverting this change.

## Unreleased: a page says how its Norn programs stand

Under each `norn run` code block a page now says how that block's program
stands: whom it waits on, how it finished or why it stopped, or why the block
does not run as written. Pressing the line opens the conversation the program
works in. The page asks the Hub only while its text holds such a block, and
again when the page changes. Web only, reading the Hub route that shipped
with page programs. Recovery is a CI-validated beta Web reverting this
change.

## Unreleased: a Norn program lives on a Page

A `norn run` block in a Page is now a program: saving the Page starts it, as
whoever wrote the revision, in a conversation of its own that is named for the
Page and the block and linked to the Page. Editing the block revises the
running program against the same ledger, so nothing already asked is asked
again; editing it after the program ended runs it again; removing the block or
the Page stops it. A word after the tag names the block (`norn run review`).
`GET /api/spaces/:space/pages/:page/programs` says how each block stands. A
program in a message works as before. Hub only, with expand migration 0247
(`norn_programs.page_id`, `page_name`); the Page does not draw the status
yet. Recovery is a CI-validated beta Hub reverting this change.
## Unreleased: the duplicate-code scan takes half the time

The duplicate-code scan runs on every pull request and train and shared the
end of PR CI with the Node tests. jscpd's in-memory store answered each of
the scan's millions of lookup misses by creating an `Error`, so stack capture
and its garbage were most of the scan's CPU, and each token and window was
hashed through a new Hash object. The scan now passes jscpd a store with the
same get/set contract that rejects misses with one shared reason, and the same
MD5 hex through Node's one-shot digest. Locally the full scan drops from about
98 to 50 seconds with the same files, tokens and zero clones; on a sample that
has clones, both stores report identical clones. Thresholds, formats, ignores
and the zero-clone gate are unchanged. CI only; no product or migration change.

## Unreleased: Norn code is highlighted

A fenced block tagged `norn` or `norn run`, in a message or on a page, was
drawn as plain ink. It now takes the code inks: who is asked (`@codex`) reads
like a name, what is asked of them (`run`, `ask`, `wait`) like a built-in, the
outcomes (`Answered`, `Broke`) like types, with `~labels`, durations, strings
and comments in their own inks. Web only; the grammar loads with the other
grammars, after the first code block appears. Recovery is a CI-validated beta
Web reverting this change.

## Unreleased: an approved write or a finished upload no longer refuses the sender's next message

Approving a connector write, or finishing an X video upload, still refused the
command's sender on their next `xmatrix send` with "the Channel moved on after
the last message you read". The Hub names a receipt
`system:<execution id>:<app>`. An immediate run's execution id is the command
message id, which the read-before-send check already left out. An approved
write and a finished upload use `<command message id>:approved` and
`<command message id>:upload-result`, so those receipts still counted. One
suffix list now builds the receipt id and decides which receipts answer the
sender's own command. A denial stays unread: its id is the approval request,
not the command. Messages from other people, Agents and Apps are unchanged.
No schema or client change. Recovery is a CI-validated beta Hub reverting
this change.

## Unreleased: Google Play Console reads a subscription's base plans

`@googleplay:base_plans` shows each base plan of a subscription as Google Play
stores it: state, billing period, how many regions it is priced in and its
price in one region. A plan priced in 174 regions did not fit a catalog read,
so a saved price could not be checked before activating. Hub and protocol; no
schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a large Google Play request body rides as an attached file

A request body that does not fit a command, such as the data safety CSV of
about 180 KB, had no way in. `@googleplay:api_plan` and `api_write` now take
the body from the one JSON file attached to the command message, read as the
person the command runs for, validated against the operation and bound by the
digest. Hub only; no schema change. Recovery is a CI-validated beta reverting
this change.

## Unreleased: Google Play reads can name the fields they want

`@googleplay:api_read` accepts Google's `fields` partial-response mask in its
query. A subscription with prices in every region did not fit the bounded
result, so its state could not be read back; a read now asks for just the
fields it needs. Hub only; no schema change. Recovery is a CI-validated beta
reverting this change.

## Unreleased: a Google Play base plan keeps its stated price at home

`@googleplay:base_plan` used Google's converted price for every region,
including the price's own, where Google's local pattern turned 10.00 into
9.99. The command now names the region the price is for, and that region
keeps exactly the stated price; the others take the conversion. Hub and
protocol; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a Google Play upload URL reaches only the Agent that asked for it

`@googleplay:api_upload` published its resumable upload URL in the Channel
receipt, and that URL alone accepts the file. It now runs only as
`xmatrix call`: the URL returns to the caller, the Channel receipt and
execution history are always masked, and sent as a Channel message it is
refused with that instruction. It needs the app permission to allow writes
without asking. Hub and protocol; no schema change. Recovery is a
CI-validated beta reverting this change.

## Unreleased: Google Play Console creates a subscription base plan in one command

`@googleplay:base_plan` adds an auto-renewing base plan to a subscription from
one price: Google converts it to every region, the plan is saved with all
regional prices, and it can be activated in the same step. The catalog write
could not do this, because the converted prices of every region do not fit a
bounded receipt. Hub and protocol; no schema change. Recovery is a
CI-validated beta reverting this change.

## Unreleased: a command checks a failed app connection again by itself

A connection whose last check failed blocked every command until a Space admin
pressed Check again in Apps, even after the cause was gone. A command by a
Space admin, or by an Agent acting for one, now asks the provider again first,
records the answer as Check again does, and runs when it passes; when it still
fails the receipt carries the fresh reason. Others keep the pointer to Apps.
Hub only; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: a failed app check states its reason once

After Check again failed, an app's page showed the same reason twice: as a red
line above and again in the block that holds the fix. It now appears once, in
that block. Web only. Recovery is a CI-validated beta reverting this change.

## Unreleased: connecting an app from the desktop app returns to the desktop app

A one-click connect started in the Mac or Windows app opened the provider's
sign-in in the browser and then finished, and stayed, on the web. The connect
now records that the app started it; after sign-in the browser page hands the
grant back through `xmatrix://connect/oauth`, the app finishes the connection
with its own sign-in and shows the connector's page, and the browser tab says
it can be closed. It needs this desktop version; an older app keeps finishing
on the web. Google Play Console's "API not enabled" failure now names the API
and the Hub's Google project instead of asking to reconnect. Hub, web and
desktop; no schema change. Recovery is a CI-validated beta reverting this change.

## Unreleased: Google Play Console connects with one sign-in, for every app

Connecting Google Play Console no longer asks for an app's package name. The
sign-in also grants the read-only Play Developer Reporting scope, Check lists
the apps the account can see, and `list_apps` gives Agents their package
names. An existing connection signs in once more for the added scope. The
Google Cloud connector's `enable_api` now accepts the two Play APIs. Hub and
protocol only; no schema change. Recovery is a CI-validated beta reverting
this change.

## Unreleased: a Google Play Console connector

Apps gains Google Play Console (`googleplay`), so Agents release Android apps
without the Play Console website. It pins the official androidpublisher v3
discovery document and offers every operation through `api_operations`,
`api_schema`, `api_read`, a digest-bound `api_plan`/`api_write`, and
`api_upload`, which opens a resumable upload the machine with the app bundle
sends its bytes to. `tracks` and `release` read tracks and roll version codes
out to a track and commit. It signs in with the company Google client and keeps
its own grant for exactly the androidpublisher scope; Check reads the saved
app's production track. Hub, protocol and web copy only; no schema change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: the Android app sells Pro through Google Play

The Android app's Billing settings buy Pro through Google Play Billing instead
of showing Stripe checkout, as Google Play's payments policy requires for a
subscription bought in an app. A purchase is one human seat bound for good to
the Space it was bought for, like an App Store purchase on iPhone. The Hub
reads every purchase from the Google Play Developer API, acknowledges it after
recording it, and re-reads it on each Real-time developer notification
(`/api/billing/google-play/notifications`, Pub/Sub push with an OIDC token).
Expand migration 0246 adds `google` as a billing provider and the
`google_play_account_tokens` and `google_play_purchase_bindings` tables.
Purchases need the production secret `GOOGLE_PLAY_SUBSCRIPTIONS_CONFIG` and an
Android build with Play Billing; until both exist, the Android app shows that
subscriptions are unavailable and the web keeps Stripe. Setup is in
`docs/operations/google-play-subscriptions.md`. Recovery is a CI-validated beta
reverting this change; the two tables then stay unused.
## Unreleased: an Instance at rest that a Norn request started is retired too

Stopping the Run a Norn request started left the Instance when that Run had
already exited: an Instance at rest has no live Run, stays listed, and wakes
with the conversation's next message. The release step now retires such an
Instance as a stop of that exact address does, and stops the Instance's
current Run when it is live. Hub only, no schema change. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: a Run started for a Norn request ends with the request

Every request of a Norn program starts a new Run, and those Runs stayed in the
conversation after answering: a review of three rounds left ten resting
Instances, and each later message woke all of them. Once a request has ended
(answered, refused, broke, cancelled or past its deadline), the Channel's
coordinator now stops the Run its delivery started, once, and the delivery
message says that answering ends the Run. Requests that ended before this
release have their Runs stopped at the conversation's next coordinator pass.
Hub only, with expand migration 0245 (`norn_requests.released_at`). Recovery is
a CI-validated beta Hub reverting this change.

## Unreleased: a Norn program in a message asks Agents typed requests

A message with one top-level fenced block tagged `norn run` starts that
[Norn](https://github.com/norn-lang/norn) program with its author's authority
([Norn host](architecture/norn-host.md)). Each request the program makes is one
xMatrix message under it that starts a Run of the harness it names (or of
`@auto`), and that Run ends the request with the new Hub-defined commands
`xmatrix reply`, `xmatrix refuse` or `xmatrix broke`; `xmatrix requests` lists
the open ones. An answer outside the form the program reads is refused. A
request whose launch was refused, whose Run stopped or exited, or whose turn
ended without an answer is settled `Broke`, so a program never waits in
silence. A stop of the whole conversation ends its programs, and the result is
posted under the program's message. A block tagged `norn` alone is only shown,
and no existing message starts anything. Requests to people and to an existing
Instance are refused with the reason in this version. Hub only, with expand
migration 0244 (`norn_programs`, `norn_requests`); every CLI that passes
unknown words to the Hub has the commands. Recovery is a CI-validated beta Hub
reverting this change; the two tables then stay unused.
## Unreleased: a beta train ships the Hub alone, so a Hub fix no longer waits for client builds

A release holds its first component's place in line until its slowest
component is published. On 2026-11-11 `xmatrix-v4.0.7-beta.5` shipped all six
components: its Hub deployed five minutes in, and the release held the Hub's
place for 41 minutes while the desktop and CLI builds ran, so a Hub fix asked
for at 19:34 UTC started deploying at 19:55. Of the last 39 releases, 13
carried the Hub together with the CLI or desktop and ran 14 to 57 minutes; a
Hub release alone takes 4 to 6.

A beta train whose selection includes the Hub and anything else now ships only
the Hub. A request that names more than the Hub is shipped for its Hub, and
the rest of it stays open under the same request id; requests without the Hub
stay open as they are. The train wakes the next one, which ships the rest
beside or right after that Hub release by the existing dependency rule. The
rest of a request therefore starts a few minutes later than before, and the
Hub's place frees after a Hub deploy. Stable trains, the dependency rule,
concurrency groups, authorization and recovery are unchanged; nothing is
cancelled. A request whose Hub part is in flight while its rest is open is no
longer read as a half-finished move, which is now decided by request id and
scope together.

Release train only (`scripts/release-train.mjs`,
`production-release-request.yml`); no product, schema or client change.
Recovery is a CI-validated main revision reverting this change: open and
in-flight refs written by either version are read by both.

## Unreleased: the connector list says a subscription is sent, not called

`xmatrix connector list` printed `read   @github:subscribe:...`. The manifest's
`read` is the approval class, and every other `read` row is run with `xmatrix
call`, but subscribe has no call executor: it changes the Channel it is sent in,
and `xmatrix call` answered `Unknown connector action`. `GET
/api/connectors/usage` now adds `via` (`call` or `send`) to each action and the
description of a read without a call executor says to send it with `xmatrix
send`; the CLI labels that row `send`. `xmatrix call` on a command the provider
runs only from a Channel message now answers that it is sent with `xmatrix
send`. No action's `effect` or approval changed. An older CLI ignores `via` and
still prints `read`, with the new description; a new CLI against an older Hub
prints `read` as before. Hub and CLI. Recovery is a CI-validated beta reverting
this change.

## Unreleased: a GitHub command the Space cannot reach says who links the account

A GitHub command against a repository whose App installation exists but is not
linked to the Space answered `GitHub subscribe: failed; github installation not
linked to space.`, the internal code with its underscores removed. The receipt
now names the repository and says a Space admin links its account in the
Space's Apps → GitHub (Find my GitHub accounts, then Link), and that installing
the App on github.com alone does not link it. It carries the existing
`reconnect` fix, so the receipt draws the settings card that opens Apps →
GitHub. A Space with no linked installation gets the same treatment; a
repository the App is not installed on gets a sentence and no card, because a
mistyped name gets that answer too. The execution record and every other
caller keep the machine codes. The card does not settle by itself after
linking, because linking an installation does not run a connection check. Hub
only, no schema or client change. Recovery is a CI-validated beta Hub reverting
this change.
## Unreleased: an Agent's own connector receipt no longer refuses its next send

An Agent that ran `xmatrix call "@googlesearchconsole:list_sites:*"` or sent a
connector command such as `@cloudflare:put_dns:…` had its next `xmatrix send`
refused with "the Channel moved on after the last message you read", once per
command, and the identical retry went through. The read-before-send check
counts every App message after the sender's last read as unread, and the
receipt the Hub posts for a command is an App message: nothing related it to
the command's own sender. The check now leaves out an App receipt whose id is
`system:<command message id>:<app>` when that command message is the sender's
own in the Channel. Messages from people, other Agents and sibling Instances,
Apps' native events, and receipts for anyone else's command refuse a send as
before. A write's outcome still reaches the Agent that sent it as queued work
after its turn, so it may post once more before reading it. Hub only, no
schema, protocol or client change. Recovery is a CI-validated beta Hub
reverting this change.
## Unreleased: a card that asks to connect GitHub offers Connect, and a link settles it

A settings card for `connector:github/connect` showed a Space admin "A Space
admin can make this." and no button. The card decided who may act by reading
back the App's typed credential fields, and GitHub, which is connected by
authorizing, has none, so every viewer was treated as unable to connect it.
The card now asks the Space's admin authorization directly for such an App and
shows **Connect GitHub**, which opens the Space's Apps page. Linking a GitHub
account there now also runs the connection check, so the card sees a check
after it asked, settles, and wakes the Agent that asked; before, only a manual
Check did. The link stands when the check cannot run. Hub only, no schema or
client change. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a stale command lease is a fence, not a Hub error

HUB-7F kept reporting `machine_command_stale_lease` after the 409 had already
refused the caller. The latest production case is `complete.owner` on a
harness action: the command is still leased, but to a different holder, so the
old completion must not land. `renew.status` is the same fence after the
command has left `leased`. The socket still returns that non-retryable refusal
and the log keeps the static reason, command type and bounded lease timing.
The log is a warning, so console capture no longer files it as a Hub error.
Hub only, no schema or client change. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: daemons tell the Hub they can start a summon on a catalog model

The daemon kept two copies of its capability list, one in its connect metadata
and one in the list the Hub stores. `registration_native_model_v1` (#1510) was
added only to the metadata copy, so the Hub saw no daemon able to start a
runtime on a model from its own catalog: the `@` menu offered no `model:` rows
and `@claude model:sonnet` was still refused. The daemon now builds one list
for both. CLI only; it takes effect when a Machine's daemon restarts on this
release. Recovery is a CI-validated beta reverting this change.

## Unreleased: a stop or reborn that did nothing tells whoever sent it

`@<agent>:<n>:stop`, `:reborn` and `:handoff:` that address no Instance (a
mistyped name, or the full Instance id in place of the Channel's number, as in
`@deepseek:<id>:3:reborn`) recorded their refusal only on the message. An
Agent sending through the CLI never saw it, and waited for a restart that was
never queued. The send's answer now carries each refusal, and `xmatrix send`
exits with an error that says the message was sent, quotes each refusal, and
shows the address form to resend (`@deepseek:3:reborn`). Hub and CLI; the
message and its recorded result are unchanged, and an older CLI ignores the
new field. Recovery is a CI-validated beta reverting this change.

## Unreleased: Connect with X reaches consent again

X answers an authorize request whose `state` is longer than 500 characters with
`invalid_request` before it shows consent. The Hub's X state carried the Space,
the admin, the PKCE claims and the connection snapshot in about 719 characters,
so every **Connect with X** ended on "Something went wrong / You weren't able to
give access to the App" and no X account, company or personal, could be
connected; a different X account, permission set or callback changed nothing.
The claims now travel compressed and signed in about 407 characters, a state
minted before this release still finishes its flow, and a provider that
declares a state limit refuses an oversized connect instead of letting the
provider reject it silently. Hub only, no Web, client or schema change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: the model tag names the model, not its selector

An Agent's model tag showed whatever id its harness selects the model with.
DeepSeek Harness selects with a JSON pair such as
`["deepseek-official","deepseek-flash"]`, so its tag read
`["deepseek-official","…` and never reached the model. The tag now shows the
name the harness gives the selected model in its own catalog
(`DeepSeek-V4.1-Flash`), on the Agent card and in message headers, and keeps
the id only when the catalog lists no name. The CLI now also reads model
choices a harness lists in groups, as DeepSeek Harness does per provider, so
its models appear in the model switcher. A harness whose catalog names a
model differently from its id (Cursor's `Composer 2.5`) shows that name too.
Hub, Web and CLI; the selected id itself is unchanged, so switching works as
before. Recovery is a CI-validated beta reverting this change.

## Unreleased: `xmatrix send --file` is the message body, `--attachment` attaches

`xmatrix send --file` attached a file while `xmatrix page edit --file` read the
text from one, and `send` had no way to take its body from a file. An Agent
that wrote its reply to a file therefore sent `--file reply.md`: a message with
no text and a Markdown attachment the reader had to open. `--file <path>`
(`-f`) now reads the message body from a UTF-8 file, as it does for a page, and
`--attachment <path>` attaches a file beside the body. A send with attachments
and no body is refused, and so is `--file` beside another body; each refusal
names the other flag. The help, the Agent prompt and the guides say the same.
CLI only: the Hub, the Web and the send wire format are unchanged, so the flags
change with the CLI a Machine runs. A script that attached with `--file` moves
to `--attachment`. Recovery is a CI-validated beta reverting this change.

## Unreleased: a page is always as it is now, and History shows what changed

A page could be in a state its reader had not chosen and could not name: what
changed since they last read it, or since an Agent's edit when they came from
a message's edit card, marked word by word over the text until they found the
card that hid it, and back again each time they returned. A rewritten table
was unreadable that way. A page now has two states. The page is always its
newest version with nothing marked in it; History is the same page, where it
stood, at a version, with that version's changes marked in its text and the
versions listed in the margin. *Since your last visit* is History's first
entry, across however many versions that took, and what History opens on; a
brass dot beside History says there is one (the old dot was drawn in a colour
that did not show on paper). A changed block keeps its words marked one by one
only while most of them stayed; rewritten past recognition, the old block is
struck out and the new one stands whole, and a table keeps its rows and
columns. A message's edit card opens the page as it is now at the change.

Read now means visited: the newest version a person has had open. The Web no
longer times which blocks were on screen or sends the page as its reader saw
it, and the Hub no longer reads or writes `data.page_reads.seen_body`;
contract migration 0243 drops the column once this Hub is verified. Web, Hub and
protocol, no expand migration; an older Web keeps working against this Hub and
this Web against an older Hub. Recovery is a CI-validated beta reverting this
change.
## Unreleased: Gmail paperclip attachments are no longer listed as inline images

Gmail's web composer gives an ordinary paperclip attachment a Content-ID, and
the Gmail connector counted any file part with a Content-ID as an inline
image. A draft carrying a PDF therefore showed in `@gmail:drafts` as
"0 attachment(s), 1 inline image(s)", and its `@gmail:send_draft` approval
card listed no attachments. An explicit `Content-Disposition: attachment` now
counts as an attachment. A part is inline only when its disposition says
`inline`, or when it has a Content-ID and no disposition at all, as quoted
signature logos do. Hub only, no schema or client migration. Recovery is a
CI-validated beta Hub release reverting this change.

## Unreleased: Gmail send and reply carry the files attached to the command

`@gmail:send` and `@gmail:reply` could only send a plain-text email; a file
attached to the command message was ignored, so the email went out without it.
The files on the command message itself (`xmatrix send --attachment`, or a file
attached in the composer) now go as email attachments: at most 20 files and
25 MiB. Each is read as the Human the command runs for, through the same
Channel attachment authority as a download. The approval card lists every
file's name and size; the send rereads each one and refuses a file whose
content, type or version changed after approval. A message with attachments
goes to Gmail's upload endpoint through the short-lived Hub staging that
`send_draft` uses. An approved send reads the files its card froze; the first beta
refused them as unreadable and sent nothing (#1521). No new scope, no reconnect. Hub and protocol only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: a missing harness is refused by name before its Run starts

When npm left `opencode` off a Mac daemon's PATH, xMatrix still listed
OpenCode as installed there and every Run died in the wrapper on a bare
`No such file or directory`. Inventory and launches now search one PATH,
the one a Run gets, which carries each harness installer's directory on
every platform (now including `~/.opencode/bin` and `~/.kimi-code/bin`). At
launch the daemon resolves the preset's launcher on the Run's own PATH; when
it is missing, the launch is refused as `harness_missing`, naming the program
and its install, and the machine reports its inventory again. An install or
update xMatrix runs fails when the launcher cannot answer its own version.
Hub and CLI, no migration (#1516). Recovery is a CI-validated beta reverting
this change.

## Unreleased: a conversation's list copy can no longer stand in for its live Agents

Since Instances became records of their own, a Channel held by a list carries
no Agent Instances, yet its type still said it did: code that read Instances
from a list copy compiled and found none. `ChannelSnapshot` now describes what
lists hold (metadata and people) and `LiveChannel` the Channel with its
Instances; only live reads return a `LiveChannel`, and every Instance reader
takes one. The places this surfaced read live again: mentions in the message
timeline resolve their Instance and show why a mention waits for an offline
machine, the cards beside a Page show which Agents are live in each linked
conversation, and Status counts work in hand while a conversation is open.
Message rows read who wrote them from a sender directory taken when they are
built, not from a subscription, so no Instance report re-renders the shell. Web only; recovery is a
CI-validated beta Web release reverting this change.

## Unreleased: Instance runtime catalogs keep every entry

Runtime catalogs were cut at fixed counts, so a Claude Instance with many
skills lost the tail of its slash menu (production showed exactly 64 stored
commands), and a runtime with more than 64 parameters had its whole catalog
rejected. Commands, capabilities, models, parameters and options now keep every
entry; per-string length and the presence body's byte bound remain. The compact
hibernation attachment leaves out commands and capabilities, and the Instance
row keeps any runtime catalog a report omits (an explicit empty list still
clears it), so a long list can neither overflow the 16 KB attachment nor be
wiped after a restore. No schema migration. The Hub carries the fix; the CLI
change only lifts the ACP parameter count. Recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Summons infer and apply a model from the runtime's own catalog

A summon could choose a model only from a list its Agent's owner declared, and
no registration declares one, so `@claude model:sonnet` was refused and Jev
never chose a model. With no declared list, a summon now chooses from the
runtime's fresh native model catalog, the same set a live `/model` offers. Jev
keeps the runtime's default unless the author or the discussion names or asks
for another model; a written `model:` matches the runtime's model id or any
selector or display name it lists (Claude's `opus`, `Sonnet 5.5`). The launch
stays on the runtime-default authority, with no grant or model resource change,
and carries the choice as `preferredModel`; the daemon requests it of the
runtime as it does an admitted model, so a runtime that rejects it fails to
start rather than running its default. A reborn restarts on the same model.
Stored catalogs keep a collapsed selector as an alias, so live `/model opus`
works too. Needs the Hub and daemons advertising
`registration_native_model_v1`; on older daemons a written model is still
refused. Evidence uses `registration-parameters-v12`. Recovery is a beta Hub
release reverting this change; daemons ignore the field without the Hub.

## Unreleased: Instance command and parameter menus retain their runtime catalogs

Modern clients read versioned Instance records, but their durable projection
omitted commands and capabilities on write and omitted models and parameters
on read. The command palette, model choices and harness configuration therefore
lost the runtime's advertised choices. Both boundaries now retain those catalogs,
workspace and worktree-base presentation. A complete typed checkpoint and
exhaustive normalizer share one field registry with the SQL reader; adding a
presentation field without its durable mapping fails compilation. Explicit
empty catalogs remain withdrawals, including after hibernation. Message headers keep their own smaller
projection; temporary work stays on its live activity stream. Hub only, no
schema or client migration. Existing connections repopulate the missing fields
on their next presence update or ordinary reconnect. Recovery is a CI-validated
beta Hub release reverting this change.

## Unreleased: Agent sends require an Instance or an explicit launch

A CLI or MCP send without an Instance number returned success even though
its Agent summon could not route to an existing Instance. The Hub now refuses
that send before publication with `agent_instance_required`. Use
`@<agent>:<instance>` to address an existing Instance, or `--launch` (MCP
`launch: true`) to start one; message text `launch:force` is insufficient.
Human mentions and code/quoted examples remain valid. The Web composer already
requests launch. Older CLIs receive the Hub refusal too; updated CLI help
explains the contract. No schema migration. Recovery is a CI-validated beta
reverting this change.

## Unreleased: Apple relationship writes require a complete current snapshot

Generic App Store API plans treated every POST as a resource creation, so
adding members to an existing relationship did not bind its current state.
Direct relationship reads and App Review draft attachments could also bind
only a partial response. These paths now share one completeness check, and
relationship POSTs bind current membership before approval and execution.
Pagination, inconsistent totals, malformed linkage and duplicate identities
refuse the plan or draft mutation before any provider write. Inspect the full
relationship at Apple when its bounded response is incomplete. Existing
resource-create plans remain valid; relationship POST plans must be refreshed.
Hub only, no schema or client migration. Recovery is a CI-validated forward
Hub release retaining complete snapshot checks; uncertain Apple writes still
require inspection before retrying.

## Unreleased: ACP Agents without image support still read a message with a picture

A message with an image sent every ACP Agent an inline image block, and an
Agent whose initialize result did not advertise `promptCapabilities.image`
(DeepSeek Harness among them) rejected the whole turn with -32602. Such an
Agent now gets the message text alone, which already names each image's local
copy for its own tools to open. CLI only; no Hub, schema or protocol change.
Recovery is a CI-validated beta reverting this change.

## Unreleased: Apple commerce watch failures keep their phase

HUB-C0 reported only that a commerce watch would retry. The pass still retries
that watch and does not discard its snapshot or pending events. The report now
names the failed phase, a fixed failure kind and code, and whether the retry
was recorded, and keeps a database failure's existing attempt evidence.
Provider response text, bundle ids and credentials stay out of the event. Hub
only, no schema or client migration; recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Windows Agents work with files past 260 characters

`xmatrix setup daemon` now turns on Windows' LongPathsEnabled switch before it
starts the daemon (one administrator prompt; without one it prints the exact
administrator command), Git run by an Agent or any tool under it has
`core.longpaths` on, and xmatrix.exe declares itself long-path aware. Together
they let a checkout hold files deeper than 260 characters. Windows still starts
no program from a folder or an executable path past 260, whatever these
settings say: the short pool path keeps checkouts within it, and an Agent whose
Workspace folder is too long now fails naming the folder and its length
instead of "The directory name is invalid". CLI only; no Hub, schema or
protocol change. Recovery is a CI-validated beta reverting this change.

## Unreleased: New sessions get the short pool path on Windows

A repo pool created before the compact layout (`<64hex>/slots/<32hex>`) kept
taking every new session on that machine, so each checkout was 88 characters
longer than the compact `<8hex>/<6hex>` path. On Windows that put deep
dependency trees past MAX_PATH (260), where a nested executable, such as a
test runtime installed under `node_modules`, could not start. A legacy pool now keeps only the
sessions, handoff predecessors and slots it already holds; new sessions start
in the compact pool, and the sweep keeps no warm spares in a legacy pool, so it
drains as its sessions end. Nothing is moved or deleted. The desktop App's git
probes name the workspace with `-C` instead of starting git inside it, so a
deep workspace no longer shows a blank repository, remote and branch. CLI and
desktop App; no Hub, schema or protocol change. Recovery is a CI-validated
beta reverting #1498.

## Unreleased: Every quote opens with a large quotation mark

A quote above a reply, a passage quoted in a message, and the reply or quote
slip in the composer were a plain yellow slip that read like any other card.
Each now opens with a large curly quotation mark in the slip's own wood, drawn
as a vector so it is the same light mark on every system. Beta Web only;
recovery is a CI-validated Web release reverting the style.

## Unreleased: the details rail lists a conversation's Agents again

Since Instances became records of their own, the right-hand details rail read
its Agents from a Channel list that no longer holds them, listed none and hid
its Agents block: only the Summary was left. The rail now reads the same live
Instance store as the Agents-at-work dock. Beta Web only, no migration.
Recovery is a CI-validated beta reverting this change.

## Unreleased: Launch candidate reads recover a lost response

HUB-BZ lost the model catalog's PostgreSQL response before an Agent could be
selected. Candidate grants, model/parameter observations, response latencies
and directory enrichment now use independent lock-free reads, each recovering
one lost response on a fresh connection. A repeated loss or explicit SQL error
still fails; placed reads recheck the fence and a retried candidate read sees
revoked grants. Preparation, launch writes and unknown-COMMIT reconciliation
keep their existing boundaries. Hub only, no schema or client migration;
recovery is a CI-validated beta Hub release reverting this change. The
underlying database stall remains unattributed.

## Unreleased: A signed-in desktop App with no CLI session hands it one

The desktop App installs its CLI only with a CLI session, and the Web asked
for one only when the daemon reported a sign-in error. An App signed in by a
path that did not hand its session over found no CLI, reported the daemon
`missing` (not an error), and showed the setup command with nothing failing
and nothing reported, leaving a new user stuck there. When the App can
install its own CLI and finds none, the Web now exchanges a CLI session,
saves it and starts the daemon, as after the App's own sign-in. Beta Web
only; recovery is a CI-validated Web release reverting the effect.

## Unreleased: preserve app-owned product items during iOS review updates

The iOS release script accepts an app version alongside subscription, group and
in-app purchase versions in the same review submission. Before refreshing an
editable version or withdrawing a queued submission, it verifies each product's
parent against the app's collections. Unknown, foreign, duplicate or ambiguous
items stop the release before mutation. A queued replacement carries all three
product version kinds forward. An unresolved rejection still requires a factual
review response and explicit resubmission; updating the exact build does not
resolve review issues automatically.

## Unreleased: App Review attachments and draft replies use the saved web session

Review reads now expose thread/message IDs and linked attachment metadata,
with one-file signed downloads fetched without Apple credentials. Optional
thread/message selectors retain the existing newest-thread command. Unsent
drafts can be read, created, updated, deleted and sent. Edits and sends require
the current body/attachment digest, preserve existing drafts unless explicitly
named, and verify the provider result. Sends never retry an uncertain mutation.
Every web-session write revalidates current app permission before fetch, and
responses are bounded while streaming. Hub only; no schema or credential
migration. Recovery uses a CI-validated forward Hub release preserving these
checks. Physical-device testing, truthful review evidence and App Review
acceptance remain independent of these connector capabilities.

## Unreleased: video attachments declare microphone use, and support has a contact page

Recording a video from the iOS attachment picker uses the microphone, but
the app declared only camera use. iOS terminates an app that accesses the
microphone without its purpose string. The app now declares sound capture
for user-initiated video attachments and describes both camera modes;
a hosted test checks the actual built app's capture purpose strings.
Physical-device video capture remains a separate validation step.
The App Store support address now names `/support`, an unauthenticated page
with an email contact and account, purchase and troubleshooting guidance,
reachable from the guide and footer. iOS and Web, no data or API migration.
The new binary and support page require a verified beta followed by stable
before App Review can use them; the old binary is unchanged by a Web deploy.
Recovery is a CI-validated forward release preserving both capture declarations.

## Unreleased: Sentry events follow all current installation bindings

Installation binding storage already accepts more than 50 Spaces, but Sentry
event admission still rejected the entire event at binding 51. Admission now
shares the complete resource-page iterator used by installation retirement and
writes jobs in bounded pages inside one transaction. Current grants and
credential versions are checked on every page; replay, delivery fencing and
the 1,000-pending-job backpressure remain. A failed later page rolls back all
new jobs and the receipt. Cleanup still takes at most two expired receipts,
now at most 2,000 child jobs under the existing transaction deadline. Hub only,
no schema or client migration; recovery is a CI-validated beta Hub build that
retains complete reads for already-saved bindings. Events already acknowledged
by the provider are not recreated; rejected deliveries depend on its retries.

## Unreleased: CLI release feeds are read before the cron opens its other connections

HUB-BX lost the dev CLI feed twice while waiting for response headers. The
waits were 15s and 7s, past the five-second abort, while the stable feed in
the same minute succeeded and both public feeds answer within a couple of
seconds on their own. A minute cron may keep only six connections waiting on
headers. Each other pass opens a Hyperdrive connection, which counts, so a
feed fetch queued behind them does not see its abort until a slot frees.
Hyperdrive's connect wait is 15 seconds. Both feeds are now read, including
one retry of a lost response, before any other pass opens a connection. Owner
queries and socket delivery are unchanged and still are not replayed. Hub
only, no schema or client change. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Expired Machine leases retain their timing

HUB-7F reports expired harness-action renewals, but the refusal alone could not
separate delayed initial admission from a later heartbeat gap. The existing
locked command read now supplies a database observation clock, and the single
rejection log keeps the grant window, expiry lateness and command age as bounded
millisecond durations. Raw timestamps, identities and payloads stay private;
socket replies and all lease fences are unchanged. This adds missing evidence,
not a confirmed fix of the underlying delay. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this diagnostic change.


## Unreleased: personal browser history stays with its signed-in user

Input and search history used a Space-only browser key, so signing into the
same Space as another person on that device could offer the previous person's
inputs and searches. Page summon markers and the preferred writer also lacked
a reader boundary. All four now share storage addressed by the current user
and Space, and in-memory choices follow the same scope. Old ownerless records
are left unused because their author cannot be recovered. A blocked or full
store never interrupts sending, searching or calling an Agent. Beta Web only;
no Hub, schema or client protocol migration. Recovery requires a forward beta
that preserves this ownership boundary.

## Unreleased: the last message scrolls clear of the Agents at work again

Since Instances became records of their own, the Conversations view asked a
Channel list that no longer holds them whether an Agent was in the Channel,
always heard no, and kept no room under the last message: the floating Agent
card covered it and it could not be scrolled out from under it. The timeline
now asks the same live Instance store the card is drawn from. Beta Web only,
no migration. Recovery is a CI-validated beta reverting this change.

## Unreleased: ↑ in an empty composer lists what was sent before

The composer now keeps what the reader sent in each Space, on this device.
↑ in an empty composer opens that history in the composer's own panel, newest
beside the field; ↑/↓ move the highlight, Enter or Tab puts the entry back to
edit or send, and Escape, typing or ↓ past the newest closes it. Picked pages
and channels come back picked; Agents come back as their written `@name`.
Beta Web only, no migration. Recovery is a CI-validated beta reverting this
change.

## Unreleased: a read Gmail message opens in Gmail when its card is clicked

Clicking the email card a Gmail read draws in a Channel now opens that
message in Gmail's web app, in the signed-in Google account that holds its
mailbox (`authuser`). The card tints slightly on hover; its own links,
toggles and text selection keep their meaning. The Hub now names the mailbox
on every read and notification read, not only when several are connected.
Hub and beta Web, no migration. Recovery is a CI-validated beta reverting this
change.

## Unreleased: Transfer proposal lists recover a lost database response

HUB-BW lost its connection at BEGIN while listing Channel transfer proposals.
This lock-free read now combines the current Human admin check and the bounded
queue in one placed single read. One lost response retries on a fresh connection,
rechecking both admin authority and placement; repeated loss stays visible.
An authorized empty queue remains distinct from a denied reader. Transfer
confirmation, writes and unknown-COMMIT recovery are unchanged. Hub only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change. The underlying connection termination is not attributed.

## Unreleased: Registration presentation keeps its own clock

The ordered Instance store no longer accepts writes to its derived Channel
view. Registration quota now updates a separate account pool and joins local
Instance counters when displayed, including on cold reads. A registration's
name travels with its own Space-scoped version, so a rename reaches an idle or
ended Instance on focus, reconnect or cold read without changing its lifecycle.
The same database projection now includes the persisted goal and current Git
branch. Hub, beta Web and additive shared protocol; no migration. Recovery is a
CI-validated beta reverting this change.

## Unreleased: a Gmail draft's approval card says when it carries no real attachment

A reply to TradeStation was approved and sent whose card listed "7
attachments", all the logos of the quoted signature, while the two PDFs its
text promised had never been attached. The card and receipt now list real
attachments and inline images (parts with a Content-ID or `inline`
disposition) separately, and say "Attachments: none" outright, so a card of
logos cannot read as carrying documents. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: Instance status has one ordered source

A newly running Agent could speak while its message said `instance offline`:
bounded Channel windows replaced the whole roster, while live cards could
only update an Instance already in it. Messages also cached a second live
status. Self-contained Instance records now merge by lifecycle version and
socket sequence; empty or late windows cannot remove a live record. Only an
explicit ended record means offline, and exact reads reconcile held IDs after
reconnect or focus. Message headers, avatars, Reborn and the work dock share
the live state without rebuilding Markdown on activity. Hub, Web and shared
protocol; capability-negotiated legacy compatibility, no schema migration.
Recovery is a CI-validated beta reverting this change.

## Unreleased: A page's comment thread no longer hides its own words

An open thread in a page's margin floated the Conversations view's Agent
disc (46px) and composer over its last lines, a "back to the last person"
capsule over its first, and showed its Agent again as a chip in the head.
The same glass disc and composer now stand in flow under the comments at
the thread's scale (a 32px disc on the comments' avatar column, a 40px
composer), the head names the conversation on the passage's column without
the chip, comment avatars drop their status dot, the jump capsule is gone
from the margin, and text fades at the scroll edges. The Conversations view
is unchanged. Web only.
## Unreleased: page edit takes what page read printed, never its header alone

Agents wrote `xmatrix page read`'s header into pages: 62 revisions of 10
Lambda Labs pages since 2026-10-02 carry its lines, first written by codex,
claude, opencode and grok. `page edit -f` took a file as the page's text, so
each Agent cut the header off by hand; a cut one line short or mid-header
landed above the page's heading. `page edit` and `page create` now take the
page's text or all of what `page read` printed, whose header is left out. A
line only that header writes (`pageId:`, `headRevision:`, the `writeLive:`
hint) elsewhere outside fenced code means it was cut by hand: nothing is
written, and the refusal names the line and what to give instead. CLI only;
no Hub, schema or protocol change. Older CLIs write what they are given.
Recovery is a CI-validated beta CLI reverting this change.

## Unreleased: An idle Agent's 5h/1w usage comes back when its Channel is opened

A registration's quota reading counts for fifteen minutes, and since idle
Instances stopped polling their provider (#1328) nothing read it again while
an Agent sat idle, so its Channel card lost its 5h/1w tags. Opening the
Channel is now the event that reads it: when the Agents it shows have no
reading in force, the Hub asks their machines' daemons for one (the existing
once-a-minute-per-daemon probe), and the reading reaches the owner's card
when the probe lands. Hub only, no schema or client protocol migration.
Recovery is a CI-validated Hub reverting the change.

## Unreleased: A page's name is its first top-level heading, wherever it stands

Two Lambda Labs business-line pages read "Untitled" in the page tree,
Schedules and root tables while their documents carried `# NomadCafe` and
`# 酒店积分数据产品（常旅客）`: an Agent's edit had left `page read` header text
above the heading, and only a heading a document opened with named it. There
is no stored title to drift; production history shows 49 revisions of 18
pages unnamed this way, by notes, stray rules and pasted headers. A page's
name is now its document's first top-level heading outside fenced code,
wherever it stands (`data.page_title` in SQL, `pageTitleLine` in the protocol);
a document without one, or whose first one is empty, still reads "Untitled".
Rename rewrites that heading where it stands; the editor draws "Untitled" only
for a document without one, and the byline and the published page stand under
the title wherever it is. Hub and beta Web with expand migration 0238;
`data.page_name` stays for the Hub this replaces until contract migration 0240
drops it. Recovery is a CI-validated beta Hub and Web reverting this change.

## Unreleased: A schedule says what its latest runs produced

Learning which of a Space's schedules earn their cadence took a manual,
hours-long audit of their conversations. Each page Automation listed by its
page or its Space now carries `outcomes`: its ten latest occurrences that were
not cancelled, newest first, each a pull request it opened, a page it changed,
nothing, failed to start, or still running. The Hub reads them from each
occurrence's own conversation (its launches, Runs, page revisions and activity
entries) in one bounded statement per list; nothing new is stored and merges
are not shown. `xmatrix page automation list` and `page read` print
`last 10: 4 PR · 3 page · 2 none · 1 failed to start`, and Schedules shows the
summary in each row and every run, with its conversation, in its detail.
Expand migration 0239 adds online indexes for those reads (a GIN index on page
revision conversations and a partial index on activity entries and failure
notices). Hub, Web, CLI and shared protocol; older clients ignore the additive
field. Recovery is a CI-validated beta reverting the change; the indexes may
stay.

## Unreleased: Phone conversation heads share state without inspecting the app tree

The phone navigation bar inferred its paper tone from a Summary plaque found
by an app-root `:has()` selector. The shell now supplies the same summary and
linked-page data to the bar and plaque, keeping their shared tone, spacing and
page actions. A stylesheet architecture gate rejects this root dependency,
and the existing scroll scope test now covers phones as well as desktop.
The pre-fix bounded scroll sample passed its element-count budget; this change
does not claim a measured jank reduction. Web only, no schema or client
protocol migration. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: System judgments recover a lost database response

HUB-BV lost the outbox INSERT response while recording a Machine result on
its command message, before COMMIT. System annotations now close the failed
session and replay their database-only transaction once on a fresh session,
including when the caller owns a request session. Each attempt rereads the
message and annotation, preserving recall and idempotence; live publication
stays outside recovery. A second loss or an answered rejection still fails,
and an unknown COMMIT is never replayed immediately. The underlying stall
remains unconfirmed. Hub only; no schema or client migration. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: Socket overloads keep their failed Runtime fetch evidence

HUB-BS/BT reported only an opaque platform error at the Agent and Machine
Daemon WebSocket routes. The socket router now adds bounded wall duration,
owner/unassigned routing, the platform remote flag and a fixed message category
to the single original report, readable through Sentry. These distinguish a
quick refusal from a slow fetch without retaining owner names or request data;
they do not establish the cause of the overload. No immediate retry is added,
and existing 503 responses and client backoff remain. The same investigation
found daily harness notices rejected for having no version registry despite
an official update recipe: action admission now matches the daemon and accepts
those notices. Hub and shared protocol only; no schema or client migration.
Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: A Codex CLI too old for xMatrix is named instead of started

Codex threads start with the goal tools as one namespaced dynamic tool, which
Codex CLI 0.140 and older reject at `thread/start` ("missing field
`inputSchema`"). A first message on such an older Codex CLI failed with only
that protocol error. The Codex preset now requires 0.141.0, the first
release with namespaced dynamic tools: routing leaves an older Codex out, the
connect flow says it is too old, and a refusal names Codex CLI, the machine and
its update. Protocol registry only; no schema, daemon or client migration.
Recovery is reverting this change.

## Unreleased: OAuth cookie refusals identify the failed browser binding

HUB-BR found and parsed its stored OAuth state, then refused its signed browser
cookie. Google and GitHub callbacks now retain the original error with a fixed
cookie diagnosis and parameter-presence flags, readable through the Sentry
connector. Request-local evidence keeps simultaneous flows separate and retains
no state, code, cookie, URL or identity. Validation, state consumption, callback
recovery and SDK deduplication are unchanged. This adds the missing
diagnostic; the original browser cause remains unproven. Hub only, no schema or
client migration. Recovery is a CI-validated beta Hub reverting the change.

## Unreleased: An idle Machine Daemon no longer wakes the Hub or writes PostgreSQL

The daemon's minute session probe and its at-least-minutely load report each
woke the owner's Relay Runtime, and every report wrote PostgreSQL. The daemon
now probes with the edge heartbeat the Runtime auto-answers without waking, and
the Hub reads liveness from the platform's timestamp of that answer: a daemon
silent past 45 s is closed and shown offline at the next event in its owner's
cell, or within 30 s while it carries a Run. Load history is kept on the daemon
one sample per minute and sent with the next report, at most five minutes late;
placement load is reported on material change. A failed delivery no longer
closes the daemon with the client-upgrade code that stopped it reconnecting.
Old daemons keep the previous behaviour; no schema migration. Recovery is
reverting this change: the Hub ignores the new capability and field.

## Unreleased: A reconnected daemon keeps its fresh Machine credential

HUB-A9 received a refresh credential that had expired 901 seconds earlier.
The reconnect path could enroll a fresh token, then replay a queued old refresh
and roll its local HTTP credential cache back.
Refresh now captures the live connection epoch before minting and is sent only
on that same connection. Offline and replaced-connection refreshes are discarded;
current refreshes retain their wire format. CLI daemon only; no schema or Hub
compatibility migration. Existing daemons receive the fix when they update to a
release containing it. Recovery is a CI-validated CLI release reverting this
change; Hub credential verification remains unchanged.

## Unreleased: Markdown round-trip tests reuse their parsed documents

The shared Node gate parsed both the original and canonical Markdown twice for
every document in the repository corpus. The round-trip test now reuses those
documents for its idempotence and equivalence assertions. Every corpus input,
syntax case and assertion remains; focused tests still cover the convenience
API. Product behavior, required gates and release authority are unchanged.
No migration is needed.

## Unreleased: Literal attachment examples survive sending in every Markdown context

An attachment-looking line inside multiline inline code or HTML was treated as
a draft picture: sending deleted it without an upload, or rewrote it when an
upload matched. Removing a real picture also erased literal references to the
same file. Draft widgets, file removal and sending now inventory actual image nodes in
the shared GFM tree, using the same parser configuration as Page documents and
operational mentions. Whole-line uploaded pictures keep their existing format
and selection offsets. Web only; no schema, API or saved-message migration.
Recovery is a CI-validated beta Web release reverting this change.

## Unreleased: The timeline stays put while rows above the reader load

A reader who had scrolled up in a conversation saw it jump when a row above
the screen grew late, most often a Gmail card filling in its private result,
and the same while scrolling up with a wheel or trackpad. The list made up for
rows above the first one in view only while the reader was scrolling up, and
that direction resets 50ms after the last scroll event. It now makes up for
them in any direction and at rest. Web only, a react-virtuoso patch; no schema
or client migration. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: Release storage tests skip idle retry waits

The R2 upload regression spent 24 seconds in production retry backoffs on every
PR and release gate. It now records and fast-forwards only those waits while
keeping real abort deadlines, child-process termination, retry counts, phase
diagnostics and credential redaction checks. The file runs in the bounded
child-process test lane because it launches Wrangler fixtures. Production
transfer behavior and required gates are unchanged; no migration is needed.

## Unreleased: Message files follow the pictures actually shown

An attachment could disappear when its picture syntax was inside code or beyond
a folded preview, while a Markdown image reference showed the same file twice.
The message now prepares its displayed body and consumed attachments from one
final Markdown tree, after quote replacement. Files not actually drawn remain
under the words, including in long plain-text messages and system cards. The
independent line scanner is removed. Editing before a composer quote also no
longer strands its remove control: it reads the widget's current editor position.
Web only; no schema, API or saved-message migration. Recovery is a CI-validated
beta Web release reverting this change.

## Unreleased: Recorded database connection terminations remain recoverable

HUB-BQ failed both fresh connections at BEGIN before business SQL. Recovery
already replayed once, but the common CONNECTION_TERMINATED code erased the
difference between pg termination messages and Hyperdrive's explicit egress
severance. Each failure attempt now retains a fixed driver reason, readable
through Sentry without copying driver text, SQL, credentials or causes. This
fills a diagnostic gap; the underlying outage remains unconfirmed. The Hub also
uses the database's recorded termination evidence to answer retryable unavailable
after the single replay is exhausted, instead of a permanent session failure.
Arbitrary text and explicit SQL rejections retain their classification. Existing
retry limits and unknown-COMMIT reconciliation are unchanged. Hub only, no
schema or client migration; recovery is a CI-validated beta Hub reverting this
change. Historical events remain readable.

## Unreleased: A jumped-to message stays where it landed

Opening a Needs-you conversation landed on and highlighted the message, then
private result cards above it loaded their content and pushed it off screen a
second later. The timeline now holds a landed message in place while rows above
it change height, until the reader touches, scrolls, clicks or types, jumps
again, or switches conversation. Web only, no schema or client migration.
Recovery is a CI-validated beta Web reverting this change.

## Unreleased: Gmail hands a large approved draft to Composio by short-lived link

The upload-endpoint fix still ended in 413: Composio's proxy, not Gmail,
refuses a request body of a few MB, so an approved draft of about 5 MB of
attachments could not be sent through it at all. The Hub now stages the
checked snapshot under an unguessable token for at most ten minutes, lets
Composio fetch it from `/api/connectors/mail-snapshots/<token>` and deletes it
as soon as the send ends. What is sent is still exactly the approved snapshot.
Hub only, no schema or client migration. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Gmail sends a large draft through the upload endpoint

The first real `@gmail:send_draft`, an application email of about 5 MB of
attachments, was approved and then refused by Gmail with 413 Request Entity
Too Large: the checked snapshot went in an ordinary JSON body, which Gmail caps
at about 5 MB. It now goes to Gmail's upload endpoint as multipart/related
(the draft id and the snapshot's own message bytes), which takes up to 35 MB.
Nothing was sent by the failed attempt. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: Gmail sends a saved draft, attachments included, after approval

The Gmail connector could only send a plain-text email it composed itself, so
an email with attachments drafted in Gmail could not go out through an
approval. `@gmail:drafts:*` now lists your drafts with their recipients and
attachment count, and `@gmail:send_draft:<draft id>` sends one as it is. The
approval card names its sender, recipients, subject, text and every attachment;
a draft edited after approval is refused rather than sent. The existing Gmail
grant covers drafts: no new scope, no reconnect. Hub and protocol only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change.

## Unreleased: The welcome says an agent is in, in one line, with no cards

Once a new person's agent was in, the welcome showed four cards (start a new
conversation, several AIs together, write with AI, connect another computer).
Of the external people whose agents were in, 8 of 39 in 28 days still never
sent a message. Daniel's call (2026-11-04): no menu; the welcome says
"@codex is in. Mention it here to give it work." and the composer below it
already says "@ to summon an agent". A Space without GitHub is offered
"Connect GitHub so agents can work in several repositories in parallel."
(it used to say the repositories "become pages"); once GitHub is connected the
welcome says nothing more, and no longer lists repositories to draft pages from.
The welcome's one-click co-writing page and the code only it used are gone;
co-writing from a page is unchanged. Web only; no schema or client migration.
Recovery is a CI-validated beta release reverting this change.

## Unreleased: xMatrix's own messages no longer use a Free Space's writes

A Free Space's 500 writes were also spent on what xMatrix itself said: the
welcome steps it writes into a new person's conversation (written under their
name, kind `xmatrix.onboarding.v1`) and the `@<agent>` summon it sends for a
first message nobody was named in, so a new Space spent several writes on one
message of its owner. Only messages from people, Agents and apps now
count, as `docs/design/agent-credits.md` already said for system notices; a
paid Space's credits were already untouched by these. Writes counted before
this release stay counted (the counter never goes down). Hub only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this
change.
## Unreleased: Reloading a conversation no longer waits for a page render

Reloading the app (Ctrl+R / Cmd+R) or opening a link into a Space, view or
conversation kept the old page on screen while the Web Worker rendered the
startup frame for that address; a cold Worker took up to about 2 s, longer from
far networks. Only the bare `/app` was served as the prerendered page. Every
address the app shell answers itself now gets that same prerendered page, so
these loads wait only for a static file. Legacy addresses still redirect as
before. Beta Web only, no API, schema or native change; recovery is a
CI-validated beta Web release reverting the change.

## Unreleased: Gmail automatic read failures retain their failing step

HUB-BP reported only 502 when a notification's private message read failed,
losing the distinction between an oversized response, a Composio HTTP/proxy
failure, Gmail's refusal and message formatting. One explicit report now keeps
the read step, fixed failure kind, status and uploaded Worker code locations;
Sentry issue reads expose the same bounded diagnosis. Provider text, mail,
credentials and mailbox/message identity remain private. Notifications still
arrive with their manual read command after failure. This supplies missing
evidence; the original 502's underlying cause is unconfirmed. Hub only, no
schema or client migration. Recovery is a CI-validated beta Hub reverting this
change.

## Unreleased: Pictures are blocks of what is written, a row at a time

Pictures waited in a strip above the words and showed under the message, in
no relation to what was written. A picture now goes into the draft where the
caret is, as its own attachment card (preview, Original, retry, ×) among the
lines; pictures put together, or one after another, are one row that wraps,
and words between them start a new row. Sent, each picture is named by its
place among the message's files (`![name](attachment:1)`), so the message
draws it where it was put and Agents read the pictures in order with the
words; any file the words do not name, and every file of older messages,
stays under them as before. Backspace or Delete beside a picture, or its ×,
removes it and its file. An image card's Original toggle and × now sit over
the picture in the light theme instead of below it. Web only; no schema or
client migration. Recovery is a CI-validated beta release reverting this
change.
## Unreleased: Receipt recovery verifies the release channel's Web

The archive recovery reader accepted either Web origin for every beta, so a
current beta receipt claiming the stable Web could pass. It now requires
`beta.xmatrix.sh` from `1.3.1-beta.7`, the first immutable train that selected
the beta Web; older betas and stable releases require `xmatrix.sh`. Exact
scope, SHA, tag and run checks remain required. Production validates each new
receipt with the same reader before persisting it to R2; recovery uses the
default branch's reader without changing historical tags or receipts. No product,
schema or client migration is needed. A CI-validated forward change to this
reader can recover a mistaken historical boundary; do not rewrite receipts.

## Unreleased: Quotes are blocks of what is written, as many as wanted

A composer held one quote, above what was typed, and a message drew only the
quote it opened with as a slip. Quote now puts the passage into the draft as
a yellow block on the line after the caret, so a message can quote several
passages, each among what is written around it, in the order they were put;
the caret steps over a block, and Backspace or Delete beside it, or its ×,
removes it whole. The draft is the message's own Markdown (`> passage`, then
`— [source](link)`), so drafts save, restore and send unchanged, and Agents
read the quotes in order. A message draws every such passage as its slip
where it was put, and previews and automatic names read what was written
around them. Discuss in new channel opens the new conversation's draft
holding its passage as the first block. Hub and Web; no schema or client
migration. Recovery is a CI-validated beta release reverting this change.

## Unreleased: Connected mobile conversations slide in

Opening a conversation from the channel list now runs its push transition when
the Human socket is connected. Sending channel focus stamps the incoming
history acceptance refs before the route commits; navigation now decides
whether the channel changes before that stamp, so it cannot mistake the new
channel for one already open and skip the animation. The temporary browser
Sentry push diagnostic is removed. Beta Web only, no API, schema or native
change; recovery is a CI-validated beta Web release reverting this change.

## Unreleased: Gmail reads currency and punctuation entities

A Gmail read showed `&yen;` and similar named HTML entities literally, for
example in a bank statement's amounts. Common currency, typographic and
spacing entities now read as their characters; unknown names stay as written.
Hub only, no schema or client migration. Recovery is a CI-validated beta Hub
reverting this change.

## Unreleased: Gmail reads a statement-sized message body

The large-body read shipped in the previous beta still failed on a real bank
statement with "Provider response is too large": the fetched body exceeded the
Hub's default 256 KiB provider response bound. That one call now allows up to
3 MiB, enough for the 2 MB body limit once base64-encoded; every other provider
call keeps its bound. Hub only, no schema or client migration. Recovery is a
CI-validated beta Hub reverting this change.

## Unreleased: Gmail reads large message bodies

`@gmail:read` showed "(no text body)" for mail whose HTML body is large, such as
a bank's credit-card statement: Gmail returns such a body by reference
(`attachmentId`) instead of inline, and the connector did not fetch it. A read
now fetches up to four such text bodies of at most 2 MB each through
messages.attachments.get; real attachments are still never read. The existing
Gmail grant covers it: no new scope, no reconnect. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: A quote is one yellow slip

A quoted passage in a sent message was a grey block followed by a dashed,
underlined "— author in #channel" link. Every quote is now one yellow paper
slip, the open ask card's wood thinned into the paper, sized to its words:
above the composer before it is sent, in the message once it is, and on the
words it marks when opened. A quote of a message in the same conversation is
its own reference: the slip alone, with no author, time or channel, which
jumps to that message and highlights exactly the quoted words. A quote from
another conversation keeps a quiet source line inside the slip. Same-channel
is decided by the link's path, so quotes written on xmatrix.sh, beta or the
desktop app all count. The Markdown Agents read is unchanged. Web only, no
schema or client migration. Recovery is a CI-validated beta release reverting
this change.
## Unreleased: Desktop navigation does not report a missing mobile push

The conversation push diagnostic added for WEB-Z also ran for desktop
selections, whose driver deliberately declines mobile animation. Reporting now
requires a mobile viewport and spends its once-per-page allowance only then;
a desktop page later resized to a phone can still report its first failure.
The missing-driver path supplies that same viewport flag. Animation behavior
is unchanged. Web only, no schema or client change; recovery is a CI-validated
beta Web release reverting the report scope.

## Unreleased: Conversation push diagnostics can be read

WEB-Z captured why the mobile conversation push declined, but the Sentry issue
reader omitted the shell conditions already attached to the event. Reads now
retain only its fixed boolean flags and allowlisted view/client labels, so an
existing event can identify the blocking condition without exposing arbitrary
extra data. The animation's underlying cause is still being investigated.
Hub only, no schema or client change; recovery is a CI-validated beta Hub
release reverting this projection.

## Unreleased: Floating menus highlight edge to edge

A floating paper menu's hovered item was a rounded box inset in the slip,
and its corners did not follow the slip's. Items now run to the slip's edges,
whose own corner cuts the first and last, with a hairline between groups: the
message and page selection menus, the table tools, the insert and mention
menus, a heading's menu and a message's More actions. Pill-shaped bars keep
their round items. The shared slip clips highlights with automatic overflow,
so a height-bounded menu still scrolls by wheel or touch; clipping with hidden
overflow had overridden the page editor's scrolling and made later options
unreachable by pointer. Consumers set their size, and the material owns this
common clipping and scrolling behavior. Web only, no schema or client migration. Recovery is a
CI-validated beta release reverting this change.

## Unreleased: A list's + row is centred, quieter, and shows Ctrl/⌘+N

The desktop "+ New conversation" row (and New page, Manage machines) drew a
bold, left-aligned label behind a thin + icon. The label now sits centred in a
lighter ink without the icon, and a faint ⌘N / Ctrl+N at the row's end, on the
label's baseline, shows the shortcut that already worked. Only actions Ctrl/⌘+N
performs show it; New workspace does not. Web only, no schema or protocol
change. Recovery is a CI-validated beta Web release reverting this change.

## Unreleased: Agent message headers name their repository

Agent message headers omitted the repository even though the Run already knew
it. The message commit now reads the admitted repository from the proven Run
in the authorization transaction and captures it as a Repository status tag,
including sends before runtime presentation arrives. A stale Instance chip
array cannot override or erase that repository.
It uses the sanitized repository reference rather than a managed checkout path;
later presence changes cannot rewrite historical headers. Existing Web and
native clients already render this tag. Hub only, no schema or client migration;
older messages without the snapshot remain unchanged. Recovery is a CI-validated
beta Hub release reverting this change.

## Unreleased: Claude runs report xMatrix as their client

Claude Code labels every request with the client that drives it. A Claude
started headless with `--print`, as every xMatrix Agent and one-shot text task
is, labelled itself `sdk-cli`, and Claude subscriptions currently use up the
5-hour window about twice as fast per token under that label as under the
interactive TUI's (anthropics/claude-code#97074). The daemon now sets
`CLAUDE_CODE_ENTRYPOINT=xmatrix` on every Claude it starts, overwriting a value
inherited from a parent Claude session, so transcripts and requests name
xMatrix. Client only; Agents pick it up when their Claude process next starts.
No schema or protocol change. Recovery is a CI-validated release reverting this
change.

## Unreleased: Quote a selected passage of a message

Selecting text in a message offered only Discuss. It now offers **Quote ｜
Discuss in new channel**: Quote puts the passage above this conversation's own
composer, with its author and Channel, and the next message sent there opens
with it as a quote linking back to the message; Discuss in new channel is the
former Discuss. Floating paper menus (this one, a message's hover actions, a
page's selection and `/` menus) are now a flat wood-tinted slip without a
shadow. Web only, no schema or client migration. Recovery is a CI-validated
beta release reverting this change.

## Unreleased: Handoff preserves explicit placement and Instance ownership

Handoff now parses launch conditions after the successor address and carries
an explicitly selected source machine forward by its admitted identity. An
override passes ordinary launch authorization; unavailable placement remains a
visible refusal. A successor starts only after its source's stop is confirmed.
Reborn stop failures retain the daemon's bounded reason. Exact Instance
assignments remain context for peers, while unaddressed messages and broadcasts
keep their existing behavior. Bootstrap identifies the current Instance and Run
and asks completed temporary helpers to stop, preserving unfinished waits.
Hub and CLI; no schema migration. Existing wrappers need a normal reborn after
updating CLI to load the new bootstrap. Recovery is a CI-validated beta release
reverting the change.

## Unreleased: Gmail sends from a verified send-as alias

`@gmail:send:<to> from:<address>` refused any address that was not a
connected mailbox, so a verified Gmail "Send mail as" alias (a company address
forwarded into a personal Gmail) could not be used. `from:` may now name an
alias Gmail lists as primary or accepted on one of the caller's mailboxes; the
mail goes out through that mailbox with the alias in From, the approval card
names both, and the alias is checked again just before sending. A reply to mail
addressed to such an alias goes out from it. The existing Gmail grant covers the
send-as read: no new scope, no reconnect. Hub only, no schema or client
migration. Recovery is a CI-validated beta Hub reverting this change.
## Unreleased: A new Gmail message is one card

A new-mail notification was followed by a separate Gmail read receipt that
held the automatic read, so every arrival took two messages. The connector now
reads first and posts one notification per Channel that carries the read as
its private result: the owner sees the email card; others and every Agent see
the unchanged notification text, which still wakes Agents and fires
Automations. A failed read says so in that text. The 30-per-hour automatic
read cap is removed; every read stays metered as `auto_read`. Hub and Web; no
schema change. History keeps its earlier receipts. Recovery is a CI-validated
beta release reverting this change.

## Unreleased: Content lock holders retain their last statement

HUB-BN's About write waited behind `content.ref.commit`, but the captured
idle transaction did not identify its last statement. The existing bounded
lock sample now retains a fixed, allowlisted content/billing query label and
query/state ages for content intent and reference transactions. Sentry's issue
reader exposes those fields without SQL, values or identities. This is missing
diagnostic coverage; the underlying slow round trip remains unproven. Locks,
timeouts, replay and unknown-COMMIT handling are unchanged. Hub only, no schema
or client migration. Recovery is a CI-validated beta Hub reverting this change.

## Unreleased: An agent that vanishes while starting says so, and Windows sees its running daemon

A Run whose process ended in `relay_registered`, `channel_joined` or another
phase before its agent was ready got no startup-failure notice and did not
count against routing, because the Hub and the routing breaker each kept their
own, shorter list of startup phases. Both now read one list in the protocol
(`RUN_PHASES_BEFORE_READY`), and a process the daemon only found gone says
that rather than the agent's bare name. A Run someone stopped is not a failed
start. On Windows the desktop App took a running daemon for a stopped one when
its two-second PowerShell scan ran out, reporting `service_not_up` with no
detail and offering a restart that ends the daemon's agents. A daemon lock
that refuses the App's read now counts as a running daemon, and the scan has
ten seconds. Hub and Desktop; no schema change. Recovery is a CI-validated
release reverting these files.

## Unreleased: CLI release feed reads recover one lost response

HUB-BM lost a CLI release feed response and flattened the failure into a
message without its origin or stage. A feed transport failure now gets one
fresh read, each bounded to five seconds and 64 KiB. Invalid feeds still fail;
owner queries retain their existing single-read recovery, and socket delivery
and the whole pass are never replayed. Failed attempts and independent cell
failures retain their original causes and fixed channel, stage, attempt,
duration and HTTP status in Sentry and its issue reader, without response
content or owner/cell identities. The external timeout's cause remains unknown.
Hub only, no schema or client change; recovery is a CI-validated beta Hub
release reverting this change.

## Unreleased: Database maintenance waits through release status changes

The lifecycle broker could select an older beta when a newer release moved
from queued to running between its separate status reads. Each poll now reads
one complete, unfiltered release-run list for both successes and active runs,
including waiting, requested, pending and older stuck trains. The existing
45-minute wait, annotated tag/SHA verification and executor authority gates
remain in force. Workflow and selection policy only, no schema or client change;
recovery is a CI-validated revert through the same broker, never direct executor
dispatch or a changed production tag.

## Unreleased: Gmail reads the HTML body behind a "view in HTML" stub

Some senders put only "Please view this email in an HTML capable client" in
the plain-text alternative and the real message in the HTML one. Gmail reads
and the automatic read receipt returned that stub. A short plain alternative
that is a prompt to read the HTML, or only a template's empty value such as
`None`, now yields its longer HTML sibling's readable text (no images,
scripts or remote loads). Any other plain alternative still wins, even a
short summary worded differently from the HTML or one that mentions HTML,
and mixed segments and attachments are unchanged.
Hub only, no schema change; recovery is a CI-validated Hub release reverting
this change.

## Unreleased: Page headings with leading separators can commit

HUB-BK exposed a mismatch between generated heading slugs and the page
repository's validator: `🚀 Launch` becomes `-launch`, which the repository
refused because it started with a separator. Live edits then stayed pending.
Commits, reads and discussion links now accept leading hyphens and underscores,
preserving existing anchors, the 200-character bound and other character checks.
Retained edits can commit through the session's existing alarm. Hub only, no
schema or client migration; recovery is a CI-validated Hub release reverting
the validation change.

## Unreleased: Public pages declare their own language and sharing URL

The Chinese homepage declared English until browser scripts ran. Separate
static language roots now send `zh-CN` in its initial HTML, matching its
hreflang, while sharing one document shell. English routes keep their URLs
and static rendering. Downloads, legal pages and versioned release notes now
name their own canonical URL in Open Graph metadata, instead of inheriting
the old domain's homepage. The Calendar guide link opens its repository
document directly. Web only; no schema or client change. Dual hosting, App
redirects and robots policy remain as configured. Recovery is a CI-validated
Web release reverting this change.

## Unreleased: No page slides in over another on a phone

A phone slid whole pages in and out as a stack (a View Transition) whenever
the lists could not trade places themselves: a notification tapped in another
conversation, a search result, and the Back from them. It is removed. A phone
moves in its two designed ways only: a conversation and its channel list
trade places, and the dock tabs slide. A notification tapped over the channel
list slides its conversation in as a tapped row does; over anything else it
replaces the screen; Back goes to the channel list. Web only; no client or
schema change. Recovery is a CI-validated Web release reverting this change.

## Unreleased: App Store Connect reads and submits one-time In-App Purchases

The App Store Connect connector listed and submitted only auto-renewable
subscriptions, so an app's consumables (credit packs), non-consumables and
non-renewing subscriptions could not be checked before a review or included
in one. `in_app_purchases` lists them with type and review state;
`submit_in_app_purchases` submits the ready ones (or those named). Hub only,
no schema change; recovery is a CI-validated release reverting this change.

## Unreleased: Legacy Desktop feeds can fetch their beta installers

The legacy metadata route still serves dev, but versioned file requests treated
beta filenames as stable and returned 404. The filename's version now selects
its channel: beta files read dev, stable files read stable, and unversioned
metadata keeps dev. Reads remain confined to that channel's published asset
catalog. Explicit native feeds, signing and stored artifacts are unchanged.
Web only; no client setting or schema migration. Recovery uses a new validated
Web release correcting the mapping, never a moved tag or changed artifact.

## Unreleased: Stable Desktop manifest URLs keep their channel

The dedicated and aggregate stable manifests now link every Desktop asset
through the existing explicit stable download route. Their YAML metadata used
the legacy unversioned route, which intentionally reads dev, so downloading it
returned beta bytes beside a stable version and checksum. Native stable updater
feeds were already explicit and remain unchanged; legacy URLs retain their dev
meaning. Web only, no schema, signing, artifact or pointer change. Consumers
follow the corrected URLs without migration. Recovery is a CI-validated forward
Web release correcting the mapping; published releases stay immutable.

## Unreleased: Settings guidance fits the CLI launch budget

The settings-card guidance pushed the CLI's compiled fallback launch text past
its existing 9,000-byte budget. Concise wording brings the default launch back
under that bound while retaining settings cards, commands, Page scheduling,
authority boundaries and the Channel contract. Hub-provided templates still
replace the fallback as before. Hub and CLI, no schema or API change; recovery
is a CI-validated forward release revising the wording. The existing bootstrap
owner test continues to enforce the unchanged budget.

## Unreleased: A web session counts only once a call needing it works

App Store Connect's connection check signs with its API key, so an expired web
session beside the key still read as checked. `xmatrix settings status` said
`in`, and a settings card for it could settle with nothing proven. A credential
field may now name a `verify` read in its manifest. App Store Connect's web
session names `web_session`. The field's state follows the Space's recent calls
that needed it: the latest one that ran makes it verified, and the latest one
that stopped on it makes it invalid, in that call's words. Saving it on a card
runs that read in the card's Channel. Asking for a setting now reads it as of
the request. Hub only, no schema change; recovery is a CI-validated release
reverting this change.

## Unreleased: The Agents page asks for quota when you look, not every 15 seconds

While the Agents page was open, every 15-second refresh asked the Hub to read
provider quota again, a daemon request a minute for as long as the tab stayed
open. It now asks when the page opens or comes back into view; a reading that
lands meanwhile (an Agent's turn, a refused summon's check) is pushed and
shown at once. Web only, no visual change; recovery is a CI-validated revert.

## Unreleased: Any setting only a person makes goes on one card

An Agent stopped on a sign-in, credential, Space secret, secret access or
harness login can now ask for it with `xmatrix settings ask <address>…`. This
is a Hub-defined command, so a CLI needs no update. One settings registry
turns each address (`connector:`, `secret:`, `secret-access:`, `harness:`)
into a descriptor from its own store. The card, the Agent's status read and
the wake use only that descriptor. The Web draws one settings card from it,
under a stopped connector receipt and on an Agent's request. Once every
setting is in, xMatrix answers the card, and that answer wakes only the
Instance that asked. Hub-written request cards (settings, secret, secret
access, harness sign-in, cross-Space read) now arrive live instead of after a
reload. Hub and beta Web, plus CLI help text; no schema change. Recovery is a
CI-validated release reverting this change. See
[settings cards](design/settings-cards.md).
## Unreleased: Machine scope timeouts retain the command holding the lock

HUB-BJ rejected a daemon report at its first SQL statement, waiting on the
Machine's advisory scope. The event could not identify the holder because
this lock was absent from the existing bounded wait sampler. A slow scope
wait now retains the holder's operation, state, wait type and capped age
before PostgreSQL removes the wait edge. The original lock rejection and
rollback still propagate without replay; the holder's underlying cause is
not established. Hub only, no schema or authorization change; recovery is a
CI-validated release reverting the sampler selection.

## Unreleased: Agents start without waiting on a quota read, and idle ones stop polling it

A Codex, Grok, Cursor or OpenCode Instance read its provider quota over the
network before its first turn, and a Claude Instance before announcing itself
ready, so every start waited on that request (seconds on a slow link, up to a
ten-second timeout). The read now runs beside the start and its reading
follows when it lands. An idle Codex Instance no longer asks for its quota
every minute; it reads it when a turn ends. A daemon answers a Hub probe that
checks a refused summon (`fresh`) from the provider rather than its
two-minute cache, so a reset or top-up is seen at once. CLI only; recovery is
a CI-validated forward release.

## Unreleased: A refused summon starts once its quota is back

A summon refused because a stored reading said its provider quota was used up
stayed refused after a reset or top-up until someone summoned again. Now the
refusal records what it rested on and asks that pool's daemon for one fresh
read. The reading that shows headroom, from that read or an Instance's own
report, marks the wait in the same transaction that records it; the Hub then
wakes the summon and the launch coordinator starts it under full admission. Many refusals of one pool
share one read. A summon's ordinary refresh reads only quota no current
reading covers, at most once a minute per daemon, and a waiting retry is
checked at its reset rather than every few minutes. Recovering a stopped
Instance still waits for its author's choice. Daemons from before this release
may answer the fresh read from their two-minute cache; the summon then starts
on the next newer reading. Hub release with expand migrations
(`0236_expand_registration_quota_waiters.sql`,
`0237_expand_quota_retry_refusal_fence.sql`); recovery is a CI-validated
revert, and the added tables and columns are unused by older code. Deleting
a Channel or Space erases its quota waits with its other records.

## Unreleased: Follow-up messages wait for the Agent already being started

Before a chosen Agent had a Run, a second message could offer another picker
and two concurrent picks could both succeed. The Hub now treats the Channel's
pending launch decision as startup ownership in both the Ask projection and
its locked claim. Follow-up evidence stays available for explicit recovery
after a failed, cancelled or expired startup; exact retries keep the original
decision. Hub only, no schema or client change; recovery is a CI-validated
Hub release reverting this pending-startup check.

## Unreleased: Runtime control-head deadlocks retain the live blocker

HUB-BH aborted a registration launch while advancing its Space control head.
The original event names the failed query but cannot identify the other
transaction in the cycle. Runtime and machine lifecycle head updates now use
the existing bounded lock-wait sampler before PostgreSQL removes the wait
edge, retaining only the other operation, state, wait type and transaction age.
The original rejection, rollback and replay boundaries are unchanged; no
underlying lock-order cause is claimed. Hub only, no schema or authorization
change; recovery is a CI-validated release reverting the sampler selection.

## Unreleased: Used-up quota pools are no longer re-read on a clock

The minute re-read of pools held used up (#1321) is withdrawn: quota is read
when work needs it, never on a timer. Hub only, no schema or authorization
change; recovery is a CI-validated revert of this change.

## Unreleased: An agent that quits or waits for a sign-in is not chosen

The daemon's can-it-take-work check counted only credential errors, so an ACP
agent that quit before opening a session (a WorkBuddy-bundled CodeBuddy on
Windows) stayed "unknown" and routing kept choosing it. Any failure before a
session opens now reads as unable to take work, in the agent's own words, with
the existing Check again. A credential retry that waits on a browser login
(CodeBuddy Code without a sign-in) fails as signed out after 20 seconds instead
of hanging the start. CLI only, no protocol or schema change; recovery is a
CI-validated CLI release reverting `runtime_acp_session.rs`.

## Unreleased: Daily PostgreSQL maintenance waits for a release to finish

A concurrent Production Release could outlast the lifecycle broker's six
short polls and skip the daily cleanup. The broker now waits up to 45 minutes,
within a 60-minute job, and reselects the latest successful beta before
verifying its annotated tag and exact SHA. An exhausted wait still refuses
to dispatch a stale tag. No retention, schema or credential change; recovery
is a CI-validated revert of the broker workflow. See
[lifecycle retention](operations/postgres-lifecycle-retention.md).

## Unreleased: Update manifests name their actual publication workflow

Public client update manifests now identify Production Release beside their
exact commit and run, replacing the retired CLI workflow label shared by all
client manifests. Beta Web only, no schema or authorization change; recovery
is a CI-validated Web release reverting the label.

## Unreleased: CLI releases use the compiler their pull requests checked

Unix release builds used the runner image's default Rust while PR Clippy used
1.96.0, so new compiler warnings could first fail a production release. Linux
and both macOS CLI targets now install and verify the same reviewed compiler
as PR Clippy, matching the existing Windows pin. No API or schema change;
signing, artifact verification and release gates are unchanged. Recovery is a
CI-validated forward release updating the shared compiler pin after native
qualification.

## Unreleased: A daemon reconnect leaves old snapshots behind

HUB-BF exposed a snapshot queued before disconnect and sent after the next
connection authenticated. The Hub correctly refused its stale epoch. The CLI
now discards full and partial snapshots from a replaced connection at the
socket writer boundary; reconnect captures a fresh full snapshot instead of
restamping an old observation that could retire a newly admitted Run. Durable
spawn results keep their original causal fields for reconciliation. CLI only,
no protocol or schema change; existing daemons need the updated CLI. Recovery
is a CI-validated CLI release reverting the sender check.

## Unreleased: The CLI uses the panic-safe hash buffer patch

The CLI now locks block-buffer 0.12.1, the same-line fix for
[GHSA-qwgh-2vcv-g2f7](https://github.com/RustCrypto/utils/security/advisories/GHSA-qwgh-2vcv-g2f7).
The old buffer could retain an invalid cursor after a compression or block
generation callback panicked and its caller caught the panic and reused it.
The CLI uses this dependency through SHA-2; no such application callback path
has been identified. Hash formats, APIs and stored data are unchanged. CLI
only; recovery is a CI-validated CLI release reverting the lock, which would
restore the advisory exposure.

## Unreleased: The phone's loading dock waits until it can navigate

The startup frame drew enabled Pages/Channels/Status/More buttons with inert
handlers. A tap before session resolution disappeared when the real shell
mounted. Those placeholder buttons are now disabled; the real dock enables
them when it can navigate. Web only, no API or schema change; recovery is a
CI-validated release reverting the disabled startup state.

## Unreleased: Codex on credits no longer shows LIMIT

ChatGPT now reports a Codex account as not allowed as soon as its plan week is
used up, even while credits keep serving it. Such Instances showed LIMIT and
routing could treat them as refusing work. The CLI now records the account as
serving while it has credits and no overage or spend limit is reached, so the
Agents list shows credits and routing keeps using it. CLI only, no API or
schema change; recovery is a CI-validated CLI release reverting the check.

## Unreleased: Every client names a file's type from one table

Which type a file extension names, which extension a saved copy gets and
whether a conversation or a page shows a file inline now come from one table
the Web, the Hub and the CLI all read. A conversation shows MKV, AVI and MPEG
videos as video wherever the Web already did, downloads of audio get their
extension, `xmatrix send --file` names every listed type (AVIF, Opus, WebA and
more), and an Agent's local copy of an `audio/mp4` voice note is `.m4a`, not
`.mp4`. Web, Hub and CLI, no API or schema change; recovery is a CI-validated
release reverting the table.

## Unreleased: The site also answers at xmatrix.page

xmatrix.sh is a country-code domain Google does not treat as generic, so the
site was indexed as a Saint Helena site. The stable Web now also serves the
marketing site at xmatrix.page: the home pages, docs, download, release notes
and legal pages answer there, and canonical URLs, the sitemap and robots name
xmatrix.page on both origins, so search engines index it there. Every page
still answers at xmatrix.sh and nothing redirects away from it; at xmatrix.page
any other path, the app and sign-in among them, goes to xmatrix.sh with a
temporary redirect. The Hub, its OAuth callbacks, webhooks, MCP endpoint, token
issuer and the session cookie are unchanged. Stable Web only, no API or schema
change; recovery is a CI-validated stable Web release without `web.siteOrigin`.

## Unreleased: Seeing a CLI behind checks for its update at once

The daemon updated only when the Hub's release push reached it, and a Machine
page could not tell a check that ran from one that never arrived. A view that
shows a Machine's CLI behind now asks its daemon to check now, and the daemon
reports each step it actually takes (checking, installing a version, current,
or failed with the reason) for the page to show. The Hub joins requests within
a minute and touches only that Machine; the daemon folds requests into a
running check and answers a request during its post-failure hold with that
failure. Older daemons are answered "unsupported" without being asked. Hub,
CLI and a Web proxy route, no schema change; recovery is a CI-validated release
reverting the request route and report.

## Unreleased: The daemon updates its CLI when a release is published

A machine could run the previous CLI for up to 30 minutes after a release,
because the daemon read its release feed on a 30-minute clock while the web
already marked it "Update". The daemon now keeps no clock: besides its startup
check it updates when the Hub pushes `machine_cli_release`. Every minute the Hub
reads the stable and dev CLI feeds and tells, over their existing connection,
the online daemons on that channel still behind it, until they reconnect on the
new version. Hub and CLI, no schema change; older daemons keep their clock
until they update. Recovery is a CI-validated release reverting the notice.

## Unreleased: Approved connector actions explain stale approval failures

An action approved after its OAuth token approached expiry could refresh the
credentials and then fail the approval's credential-version check. The receipt
called that internal refusal a provider failure. Known approval and credential
authority errors now report a blocked action with the required connection review
or new approval. Unknown exception details stay hidden; approval checks, single
use and write retry rules remain unchanged. Hub only, no schema change; recovery
is a CI-validated release reverting the receipt mapping.

## Unreleased: Connector JSON commands keep working with web addresses

A connector command containing a URL in a JSON string could be treated as
ordinary speech and never run. Markdown's generated autolink lacked source
positions, so context filtering excluded the entire message. Plain autolinks
now recover their offsets when their ancestor reconstructs its source exactly,
preserving the command outside them; links, code and quotations still cannot
invoke anything, and unmappable literals still fail closed. Hub and beta Web, no schema or permission
change; recovery is a CI-validated release reverting this parser correction.

## Unreleased: On a phone only the lists move between a conversation and its list

Opening a conversation and going back slid the whole page, bar included, and
the iOS left-edge swipe slid a snapshot of the screen with a shadow. Now the
bar, its wood sign and the controls at the bottom stay where they stand: only
the conversation and its Space's channel list move, side by side as one flat
strip with nothing drawn between them, and the names slide through the still
sign. The bar's glyphs (share and more, search) and the bottom controls
(composer, dock and +) trade places where they stand. The iOS swipe follows the
finger and lands on a critically damped spring from the finger's speed; the
page draws it from the distances the app sends (`window.__xmatrixBackGesture`),
and the native tab bar fades in with the list. The bar's chevron and opening a
conversation from the list play the same motion. Switching dock tabs moves the
whole page, sign included, so the two read apart. A Back the page does not draw
(an open page, channel details) keeps the snapshot slide, without its shadow
(#1229), and a list no longer scrolls under the same finger while the page
draws the swipe (#1244). Each frame touches only the dozen elements that move,
through their own inline styles, and starting or ending the change renders only
the layer that draws the list's bar and controls, not the shell: a move costs
12 ms instead of 144 ms at 4x CPU throttle (#1250). Everything that moves is
then its own compositor layer moved by transform or opacity alone, the rest of
the way after release runs on the compositor as keyframes sampled from the same
spring, and the iOS app reports a touch at the left edge so the page sets the
change up before the swipe is recognized: the swipe begins in 2 ms, a move
costs 3.5 ms and repaints only the sign, and a swipe that catches the
spring-back carries on from where it is (#1255). The moving parts' own CSS
transitions are off for the length of the change, so none trails the finger
(the leaving name had stood 48 px behind it), and a drag seeks paused
animations laid once for the whole way instead of writing inline styles: a
drag frame takes 3.6 ms of main thread instead of 6.2 (#1260). Beta Web and
iOS, no API or schema change; recovery is
a CI-validated release reverting the change (an iOS build without it falls back
to the snapshot slide, since the page answers only the new bridge call).

## Unreleased: A failed redial no longer re-reads every workspace list

Since #1225 the Human socket also announced a redial that failed and waits out
backoff, and the shell re-read every workspace resource (launch targets,
Automations, transfers, cross-Space reads, connector approvals) on each such
announcement. While the Hub was unreachable each failed redial fetched all of
them again, although nothing had changed. They are now re-read only when the
socket connects or drops (#1243). Beta Web, no API or schema change; recovery is
a CI-validated release reverting the change.

## Unreleased: An App's Recent activity is a call log that names the calling Agent

Recent activity printed each run's whole answer on the page, so a calendar list
ran as raw JSON across the background. It is now a call log on one rounded
tinted sheet: per call the day and minute, the action and its command, who made
it and how it ended, and under it the sentence it answered with; the returned
content stays in the conversation. A call an Agent made now names that Agent
with both faces ("claude for Daniel"): the Hub records the Agent's name and
harness when the call runs, in new nullable `requested_by_agent` and
`requested_by_harness` columns (migration 0232); earlier calls show only
their person. The copy line on App pages shares the sheet's tint,
radius and width (#1234). Beta Web and Hub; additive schema change; recovery is
a CI-validated release reverting the change (the columns may stay).

## Unreleased: A page's code blocks take syntax colours

A page's code blocks were plain text. They now take the same low-chroma inks
as a code block in a conversation (#1238): in the live editor as decorations
over the text, in the read-only preview and public pages once drawn. A fence's
language picks the grammar; a fence without one is coloured only when a
grammar clearly claims it. Beta Web, no API or schema change; recovery is a
CI-validated release reverting the change.

## Unreleased: Code blocks in a conversation are the same paper as a page's

A fenced code block without a language drew its code as an inline chip, so in
the light theme every line wore its own rim and long lines were cut off; every
block also carried a bold uppercase CODE title band and a border. A code block
in a message is now one piece of tinted paper, the same as a page's code block
and quote: plain monospace ink that scrolls sideways, the language as a quiet
label (an icon and the language's name in the interface face, so it never reads as
the first line of code) only when the fence names one, and copy at the corner. Code takes
syntax colours in low-chroma inks (highlight.js, loaded only once a code block
appears): by the fence's language, or, for a fence without one, only when a
grammar clearly claims it, so a table or a log stays plain. A quote in a
message is the same tinted paper instead of a rule beside grey text. Beta Web,
no API or schema change; recovery is a CI-validated release reverting the
change.

## Unreleased: Apple sign-in names why native authorization stopped

An Apple authorization error 1000 with no underlying error could be a missing
window, an empty nonce, a failure before Apple showed its sheet, or an unknown
system failure, and those were the same report. The attempt now keeps whether
the page's window, another on-screen window, the window captured at the start,
or no window was available, whether Apple asked for a presentation anchor, the
application phase, the nonce shape (empty, 64-character hex, or other), and
whether the error carried userInfo keys outside a fixed allowlist. Descriptions,
key names, values, and the nonce are not included. A missing window or an empty
nonce is reported as that fact and Apple is not asked. A replaced attempt cannot
complete the new one. Authorization is not replayed. The native string stays
inside the browser defect limit. iOS only; recovery is a CI-validated beta iOS
release reverting this change.

## Unreleased: The Mac app opens with its traffic lights centred on the rail

The Mac app's first frame, drawn before the app's script runs, laid out the
browser's 64px rail, so the traffic lights spilled off the wood onto the paper
until the script added the macOS frame and everything jumped to the 80px rail.
The window frame (macOS and Windows) now reads the platform from
`<html data-desktop-platform>`, which the root layout's inline script sets
before the first paint, so the window opens in its final layout. Beta Web, no
desktop, API or schema change; recovery is a CI-validated release reverting
the change.

## Unreleased: Stripe Checkout returns open Billing again

Since #1203, Stripe Checkout and portal returns to `/billing`, and the
allowance notice's link outside the shell, opened Settings › Account, so a
returning payer had to find Billing before their payment was confirmed. They
open Billing again, and confirmation runs there (#1227). Each view's address
field is now named once in protocol, and the shell, provider returns and the
Hub's Apps redirects build addresses from it. Beta Web and Hub, no API or
schema change; recovery is a CI-validated release reverting the change.

## Unreleased: Text-task answer failures retain the failing database path

HUB-BC completed a text task but timed out applying its Channel About. Its
best-effort handler discarded the original stack and database evidence. It now
reports that exception once, retaining the named query and transaction phase;
slow Channel metadata root/control-head locks also capture the bounded live
wait graph, with a fixed catalog writer category. Diagnostic connections share
the existing one-per-isolate budget. This fills missing evidence, not a proven
repair of the underlying contention. Completed commands are still acknowledged;
replay, authorization and unknown-COMMIT rules are unchanged. Hub only, no
migration; recovery is a CI-validated beta Hub release reverting the change.

## Unreleased: Returning to the iOS app no longer says "Reconnecting"

The iOS app replaces its live connection every time it comes back to the
foreground, and on cellular the new connection often took longer than the
4 s grace, so the open app said "Reconnecting to xMatrix…" when nothing had
failed. The tile now waits until a redial has actually failed (#1225).
Offline still shows at once. Beta Web only, no API, schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Unreadable Channel catalogs answer not found

Opening a Channel list for a Space the account cannot access returned an
internal error even though authorization correctly withheld the rows. Catalog
pages, counts and resolution now return the same non-retryable 404 for an
unreadable or nonexistent Space. Membership and Channel access checks stay in
PostgreSQL; this changes the rejection response, not access. Hub only, no
schema or client change; recovery is a CI-validated Hub release reverting the
error classification.

## Unreleased: The app downloads a sixth less code before its first screen

Tool views (Status, Agents, Machines, Schedules, Apps, Settings, Team, Profile,
Platform admin), the Agent configuration page, the trace window and error
reporting no longer load before the first screen of `/app`: initial JavaScript
falls from 3.64 MB to 3.02 MB (1.17 MB to 0.98 MB gzip). Each view loads when first
opened and shows its loading skeleton meanwhile; errors before error reporting
starts are held and sent. Measured in [Channel startup](performance/channel-startup.md#cold-start-tool-views-and-error-reporting).
Beta Web only, no API, schema or native change; recovery is a CI-validated beta
Web release reverting the change.

## Unreleased: Opening the app no longer waits for a page to be rendered

`/app`, where every desktop, iOS and browser launch starts, was rendered by the
Web Worker on each request; on a fresh connection a cold Worker took 0.7–2.1 s
before the first byte. The page is the same for everyone (the startup frame;
sign-in and the signed-out redirect happen in the browser), so it is now
prerendered once per build and the Worker answers with that copy before any
route code loads, as it already did for other prerendered pages such as sign-in.
The copies ship in the same deploy as the scripts they name, and every cache is
told to revalidate them (`public, max-age=0, must-revalidate`), so a deploy never
serves a page naming removed scripts. Deep links under `/app/<space>/…` are still
rendered per request. Beta Web only, no API, schema or native change; recovery is
a CI-validated beta Web release reverting the change.

## Unreleased: Launching the app reopens the last conversation

Opening the bare `/app` now goes straight to the conversation this account
last had open on this device (its address, ids only, kept per user in
localStorage), as soon as the account is known, so its history read starts
with the first reads. A notification's `/app?channel=` and `?view=` launches
keep naming their own screen. When that conversation can no longer be read,
the launch settles on its Space's list. Web only.

## Unreleased: Each app start reports how long it took for the person

Once per page load the app sends when it first reached its shell, signed in,
its Channel list and its first messages (ms since navigation; absent when not
reached), its device, and whether it painted this device's cached list
(`warm`/`cold`). The Hub writes one diagnostics point per start under the
person's keyed hash (`startup`/`startup_timing`, doubles 3–6), with no Space,
Channel or content. Nothing waits on it. Hub and Web; an older Hub answers 404
and the start simply goes uncounted.

## Unreleased: The Apps list groups by connection state and ticks what works in green

The Apps list put category headings (Code & CI, Chat…) beside Connected, mixing
a state with what an app does, and connected rows carried no state mark. Sections are
now connection states only: Needs attention, Connected, Disconnected, Not
connected and Coming soon. Categories are subheadings inside Not connected, and
each connected row ends in a green tick. Unit and browser coverage check the sections,
the subheadings and the mark. Beta Web only, no API, schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Stripe payment notifications include the App's publishing account

Temporary refresh conflicts, storage/network failures and rate limits in the
publisher's event confirmation return 503 for Stripe to retry. Confirmed
401/403/404 read refusals remain acknowledged without delivery; temporary failures no
longer silently lose a notification. No configuration, schema or scope change.

Stripe Channel notifications cover paid invoices, successful payments and
subscription creation as well as failures, disputes and later subscription
changes. Subscription creation keeps its real status and does not imply a
successful payment. Amounts are labeled as Stripe minor units.

Stripe excludes an App's publishing account from Connect webhooks, even after
OAuth installation. A separate operator-configured own-account endpoint now
verifies its independent signature and reads the same event using each Space's
current OAuth grant before posting. Reconnection or removal fences an in-flight
delivery. It keeps all retained merchant grants, the five read-only permissions,
and billing unchanged. The platform endpoint still ignores events without an
account. Hub only, no schema or client change; the endpoint stays unavailable until its optional configuration pair is deployed. See [Stripe accounts](connectors/stripe.md#the-app-publishers-own-account).

## Unreleased: The iOS app says when its page cannot load and retries

A main-frame load that fails (not a cancelled navigation) now shows a
tinted-paper tile over the app's paper, "can't be reached" or "offline", with
Try again; it retries when the network returns (NWPathMonitor) and every 15 s,
and a page whose web process iOS reclaimed reloads instead of staying blank.
iOS only.
## Unreleased: The open app says when it is offline or reconnecting

A tinted-paper tile over the reading column, just under the top band, says
"You're offline" while the browser is offline, and "Reconnecting to xMatrix…"
when the live connection has dropped for more than 4 s after it had connected.
It disappears when the connection returns; nothing on screen is blocked. Web
only.

## Unreleased: A desktop window always appears and says when the app cannot load

A new window shows within 1.5 s even while the app's page is still on its way.
A main-frame load that fails (not a cancelled navigation) shows a tinted-paper
status in the window, "can't be reached" or "offline", with Try again; it
retries when the network returns and every 15 s, and a crashed renderer
reloads. Desktop only.

## Unreleased: Android opens its own copy when the edge answers with a server error

A main-frame 5xx from the Web origin (an edge error page) now opens the copy
of the app the Android shell carries, as a network failure already did, so the
person sees the app's startup frame and its connecting status instead of an
error page. Android only.

## Unreleased: Startup reads answer in time and failures show in place

A sign-in session read (Web and native) now gives up after 15 s and counts as
a transient failure the existing backoff retries, and each Channel list page
attempt after 20 s, retried as a dropped connection, so a silent network no
longer holds startup forever. A conversation whose latest messages cannot be
read shows why where the messages would be, instead of a skeleton that never
ends; the periodic read keeps retrying. While the Space's list has not
answered, the reading pane shows its skeleton rather than "No conversations
yet". Web only.

## Unreleased: A Space keeps every Stripe account it connects

Connecting another merchant previously replaced the Space's single Stripe
grant. Each account now has an independently encrypted grant, refresh lease
and event binding, shown under Stripe accounts with Add and Remove actions.
Stripe's own picker still authorizes one merchant at a time. Uninstalling or
removing one merchant leaves the others connected. Check reads events using
the existing `event_read` permission, including an empty list, and fails on
a refusal; it no longer requests account profiles with an ungranted permission.

Hub and beta Web, with additive migration 0231 and no client protocol change.
The new Hub adopts each old verified grant atomically under its parent lock;
pending copies cannot route events. Retained grants use the new account store,
so Hub recovery is a CI-validated forward fix that keeps that store. Do not
roll the Hub back to the old single-grant reader after adoption. Web recovery
can revert its UI independently. See [Stripe accounts](connectors/stripe.md).

## Unreleased: The app opens on its own frame and says what it waits for

The preparation progress bar and the signed-in shell's full-screen spinner are
gone. Both waits render one `StartupShell`: the wood frame with the account's
last list, or the list's skeleton, from the server's first frame onward. List
skeletons no longer name a section before the list arrives. A tinted-paper
status, timed by CSS so it works before scripts run, says "Connecting to
xMatrix…" after 2 s, that it is still trying on a slow network after 6 s, and
offers a reload after 15 s; an offline device says so at once. Web only.

## Unreleased: Automatic harness updates keep trying until installed

With the Machines switch on, harnesses still sat weeks behind. The Hub stopped
telling a daemon once it had seen a new version, the daemon queued that update
in memory only, and the update waited for every Run on the machine to end.
Self-updating harnesses were assumed to update themselves, but they do not in
xMatrix's headless launches. Now, while the switch is on, the daemon runs the
official update. The Hub tells it every 30 minutes until the inventory shows
the latest version installed, and daily for harnesses without a registry. Only
live Runs of that same harness delay it. Hub and daemon, no schema change.
Recovery is a CI-validated beta revert.
## Unreleased: Shared links name the selected object

An Apps link such as `?connector=stripe` previously stayed on the list because
detail selection read `item`, while only OAuth returns interpreted `connector`.
Apps now uses `connector` for opening, switching and closing details, including
OAuth and Gmail returns. The old Apps `item` parameter is removed without an
alias. The shared item hook and helpers are removed; Agents use `agent`,
Machines use `machine`, Schedules use `schedule`, Settings/admin use `section`,
and Team uses `space`. Existing item-only links return to their destination
list; this is an intentional address change across Web consumers. Beta Web only, no protocol
or schema change. Recovery is a CI-validated beta Web reverting this change.

## Unreleased: A new Page keeps its first pasted image

Pasting an image or video into an empty new Page captured its still-null id
while the first write was creating it. The media ref then failed to bind.
The editor now awaits that same creation before uploading against the permanent
Page id. A browser regression reproduces the null owner id before the fix.
Beta Web only, no schema or protocol change; recovery is a CI-validated beta
Web reverting this change.

## Unreleased: Unchanged Page edits preserve a word being typed

A repeated Markdown write could parse an unchanged projection back into the
live document and remove the trailing space a reader had just typed. The next
word then joined the preceding one. The Hub's fragment writer and the parallel
Web preview writer now leave an unchanged projection alone; empty documents
still initialize and actual edits still apply. Real Yjs regressions reproduce
`Shipped andverified` on both old paths. This independently establishes the
bug; the original browser first attempt has no trace proving its timing. Hub
and Web, no migration or native update; recovery is a CI-validated beta revert.

## Unreleased: Agents can upload Page images and videos

Agents previously could only preserve images pasted by a person; new local
images were refused with an editor-only instruction. `xmatrix page upload
<page> <file>` now uploads images and videos to the Page's private content and
returns Markdown for ordinary edits or live writing. The Hub checks current
Page write access and canonical Space/Page/hash refs on every binding, including
replays. Text never causes an implicit local-file upload. Hub and CLI, no schema
or wire migration; older CLIs continue to preserve existing media. Recovery is
a CI-validated beta reverting the change. See [Page media](design/pages-live-document.md#66-images-and-videos).

## Unreleased: Pasted page images upload to the Hub straight

Pasting an image into a page sat at about 80% and then the image vanished.
The Web's Worker (OpenNext) reads a whole request into memory before its route
runs, so the upload body sent through it showed no progress while the Worker
re-sent it, and the 30-second stall watchdog gave the upload up. The browser
now sends the body straight to the Hub from the app's own origin, with its
bearer and client identity and never a cookie, as page reads already do; a
`401`, `426` or no answer across origins goes through the Web. Message
attachments share the path. Hub and Web, no migration. Recovery is reverting
#1196. See [Client resilience](architecture/client-resilience.md).

## Unreleased: The app starts one Hub round trip sooner and paints its last list

Web sign-in now takes the bearer from the `set-auth-jwt` header the Hub's jwt
plugin already returns on a signed-in `get-session`, instead of a second
`/api/auth/token` request, so every launch reaches its first reads one Hub
round trip sooner. A remembered compatibility admission is keyed by Hub,
component, protocol and platform rather than the exact version, so the first
load after a release no longer waits behind the preparation bar; the Hub is
still asked in the background and a refusal still opens the upgrade wall. The
presentation-only Channel list snapshot is now written whenever the list
settles, so a returning account sees its last list while its session is
confirmed; it remains inert and user-partitioned. App routes preconnect to the
Hub while scripts download. Web only. See
[Channel startup performance](performance/channel-startup.md).

## Unreleased: Message append recovers a lost pre-COMMIT response

HUB-B6 lost its final live-routing read after publication writes, before COMMIT.
The database-only append now closes that session and retries once on a fresh
connection, checking authority and rebuilding reply/attention recipients for
each attempt. Real PostgreSQL coverage verifies one committed message, mutation
and outbox entry, fresh reply targets, bounded repeated loss and the unchanged
unknown-COMMIT boundary. Delivery remains outside the transaction; unknown
commits use existing receipt reconciliation. This repairs recovery without
attributing the underlying disconnect. Hub only, no migration or client change;
recovery is a CI-validated beta Hub reverting this change. See
[PostgreSQL recovery](operations/postgres-hyperdrive-origin.md).

## Unreleased: Stackless Durable Object outages retain their HTTP caller

HUB-B5 reached the common HTTP outage handler without an originating stack;
its console report discarded the route, leaving only the common capture stack.
The original exception now reaches Sentry once with its registered method and
route template, or the fixed PageSession/Harness watch boundary, and boolean
platform flags. The issue reader exposes only that bounded diagnostic, never
path values, request data or identities. Different routes retain independent
fingerprints. Existing 503 responses and replay boundaries are unchanged.
HUB-88/9C share this diagnostic gap; their underlying invalidation remains
unproven. Hub only, no migration or client update. Recovery is a CI-validated
beta Hub reverting this diagnostic change. See
[Runtime delivery errors](operations/runtime-delivery-errors.md).

## Unreleased: Bounded schema collections reject oversized input early

The Hub authentication and AI SDK dependency graph now resolves Zod 4 to
4.6.6, fixing GHSA-mrhx-c7xc-m3w5 for constrained collections: size checks
reject oversized arrays, maps and sets before validating their elements.
Unbounded schemas still need transport limits; the authentication stream
limit remains the protection for those inputs. Zod 3 in the build tooling
is outside this change. Hub and beta Web, no schema or protocol migration.
Recovery is a CI-validated beta reverting the dependency constraint and lock,
which also restores the dependency risk; keep the transport limit in place.

## Unreleased: A failed App run is fixed where it shows

Apps → Recent activity showed a failed private call as a user id and
"Result: [hidden — private call]", with no cause and no next step. A failure
now records its remedy: sign in again for a credential, replace one, or
reconnect. The failed row names the problem and offers that fix in place
(App Store Connect sign-in in the desktop app, a paste field in the browser,
Reconnect for OAuth apps), then runs the read again and shows the result.
Every stopped read has Retry, through a new retry route that runs the recorded
command as the person asking, with its original visibility. A private call is
private from the rest of the Space, not from the person it ran for: their row
shows the original, and the Hub's own guidance is never masked. Hub and beta
Web, with additive migration 0229 and no host update. Recovery is a
CI-validated beta reverting the change while keeping the additive columns.

## Unreleased: An empty Channel cannot keep another Channel's history

A connected focus request stamps its target before its history arrives. An
empty fallback page could therefore mistake the previous Channel's retained
rows for the target's current window and keep them. Returning to the previous
Channel then showed a blank until the next read restored its render authority.
The empty-page guard and merge base now verify the rows' Channel as well as
the focus refs. The existing painted-frame switch case covers a connected
socket with a delayed focus page and an empty HTTP fallback; it fails before
the fix. Beta Web only, no API, schema or native change; recovery uses a
CI-validated beta Web reverting this change.

## Unreleased: Slow Channel opens keep their messages in place

A Channel's hidden virtual list could finish measuring after the 1.2-second
bottom-stick grace. Its growth then started the ordinary bottom-follow glide
behind the opening rows; taking them over mid-animation moved the messages
down and back. Bottom following now lands directly while the opening tail
exists, retaining the existing glide once the conversation is open. Browser
coverage crosses the wall-clock grace during a populated Channel switch and
checks every painted frame. Beta Web only, no schema or native change;
recovery is a CI-validated beta Web release reverting the change.

## Unreleased: Choose to wait when provider quota blocks every Agent

Usage exhaustion still attempts the ordinary automatic handoff first. When no
eligible Agent can take over, the task owner can choose **Retry when quota
recovers** or **Not now**. A rejected initial summon has the same choice.
Waiting survives closing the browser, can be cancelled, and has a fixed 35-day
limit covering monthly resets. Only a newer provider quota reading authorizes
retry; expiry of a routing hold never does. Staged launch and original-session
continuation replay retain one attempt, current permissions and stop/source
fences. Hub and beta Web, with additive migration 0228 and no host update.
Older clients retain the ordinary failure text. Recovery is a CI-validated beta
reverting the feature while retaining the additive table. See
[quota recovery](operations/agent-quota-recovery.md).

## Unreleased: Message preflight lock failures retain their blocker

HUB-B3 timed out while append's combined authorization preflight waited for
the Channel row. The existing execution-owner and Agent Channel-lock sampler
did not cover this query. It now shares their one bounded diagnostic connection
per isolate, retaining only fixed waiter/blocker state, owner category and capped
transaction age. Real PostgreSQL append coverage checks a held Channel lock,
unavailable diagnostics, the original rejection, no partial message and a
successful uncontended retry without extra sampling. This closes missing
diagnostics; the underlying holder remains unproven. No lock, authorization,
deadline or replay policy changes. Hub only, no migration; recovery is a
CI-validated beta reverting this diagnostic change.

## Unreleased: Channel catalog stalls retain evidence and GitHub invalidation recovers

HUB-B0 exhausted its existing single-read recovery without source activity
evidence. Channel catalog reads now share the placement-read diagnostic from
HUB-B1: each slow attempt samples only its own active source statement, keeping
fixed state, wait and blocker categories without SQL, parameters, identities or
the ephemeral marker. Fast reads open no diagnostic connection. This closes a
diagnostic gap; the underlying stall remains unproven. HUB-B2's database-only
GitHub catalog invalidation now replays once on a fresh session when a response
is lost before COMMIT. Unknown COMMIT and answered failures still fail the
webhook, and notifications remain outside replay. Hub only, no migration;
recovery uses a CI-validated beta Hub reverting these changes.

## Unreleased: Placement read timeouts retain origin wait evidence

HUB-B1 exhausted both fresh-connection single-read attempts while resolving a
Page's Space placement. Recovery already existed, but the event could not show
whether the origin was still executing or waiting. Placement reads in flight
for 500 ms now take one bounded live origin sample, sharing the existing lock
diagnostic connection limit. Each attempt uses a temporary SQL marker; failure
evidence retains only fixed state/wait/owner categories and capped ages, never
SQL, parameters, identities or the marker. Missing and unavailable samples do
not establish a transport cause. Real PostgreSQL coverage checks blocked reads,
both attempts, diagnostic failure and fast reads; the Sentry reader checks its
strict projection. Hub only, no migration or native update. Recovery is a
CI-validated beta reverting this diagnostic change; replay boundaries stay intact.

## Unreleased: Welcome text and provider quota recovery agree with the UI

The welcome conversation's stored fallback text now excludes Agents whose
program is reported signed out, matching its live Web card, and reads every
registration page. It remains a one-time historical message; the Web card
continues to reflect registrations arriving later. Provider quota refusal
text identifies the provider account limit and asks the person to choose
another Agent or resend after their provider resets it; unavailable reset
times are not invented. This ships in the Hub and beta Web with no migration.
Recovery is a CI-validated beta reverting the text change.

## Unreleased: Run credentials recover after computer sleep

The daemon now measures its one-minute token reuse window by the wall clock,
and wrappers check wall-clock refresh deadlines at most every 15 seconds.
macOS monotonic timers stop during sleep while the Hub's ten-minute Run
credential continues to expire; a long sleep could therefore reuse an expired
credential and fail relay registration. Initial registration refreshes a
refused Run credential through its existing daemon grant and retries once;
repeat refusal and revoked Run authority still fail. Real local broker and
WebSocket coverage checks recovery and the retry bound. This ships in the CLI
and Desktop seed with no protocol or data migration. Recovery is a CI-validated
beta reverting the client change; existing Runs and grants are preserved.

## Unreleased: Calendar approvals preserve notification and recurrence meaning

Calendar approvals described `externalOnly` as an organization boundary and
discarded week-start and exact-cutoff details while translating recurrence.
Hub validation and Web approval copy now share the protocol's notification
modes; external-only means guests who do not use Google Calendar. Repeat
rules are translated only when every clause is represented, otherwise their
complete original is shown. Unknown modes cannot be approved. Regression
cases reproduce the prior behavior at the projection and browser boundaries.
Hub and beta Web, no migration or native update; recovery is a CI-validated
beta reverting this change. Existing stored approval previews stay readable.

## Unreleased: Each app has one permission

Apps now have one Space-connection setting: Read only, Ask first, or Read and
write. Calendar defaults to direct scheduling; Gmail, Ads, X and Linear default
to Ask first. The same choice applies in every conversation. Per-action and
Channel policies, their command parser and their runtime queries are removed;
legacy API bodies are rejected rather than interpreted as wider authority.
Claude's one-row selector ships with the backend. Migration adds the connection
field and freezes the retired writer after checking the live policy inventory;
contract migration 0227 drops the old table after the new Hub is verified. See the
[retirement procedure](operations/connector-permission-retirement.md). Recovery
uses a CI-validated forward release preserving configured permissions, not an
old Channel-policy executor.

## Unreleased: Page comments continue the existing conversation

The Page comment box showed a live Agent but created a new conversation before
calling its existing Instance. That first message could summon another Agent.
Comments now go directly to the selected Instance's own conversation, addressed
to it with the quoted passage and a link back; bare Agent mentions also reuse
that Instance. With no live Agent, the section's latest unambiguous readable
editing conversation receives the comment. Only a comment with no existing
destination or an explicit request for another Agent starts a new discussion.
An existing destination outside the loaded catalog page is resolved through
the authorized catalog read before sending; a failure or unavailable result
reports an error instead of creating a replacement discussion.
Browser coverage checks the actual message destination and absence of Channel
creation; the existing new-discussion case covers the remaining startup path.
Beta Web only, no API, schema or native change. Recovery is a CI-validated beta
Web release reverting the change; existing conversations and messages remain.

## Unreleased: Google authorization failures retain their cause category

Google's Cloud-session reauthentication subtype was discarded, leaving the
same `invalid_grant` message as an expired or revoked authorization. Google
token requests now retain that typed distinction and identify rejected company
app credentials, using fixed text without arbitrary provider details. Refresh
scheduling, credential persistence and approval remain unchanged. Existing
OAuth boundary coverage reproduces the missing subtype on prior code and
checks refusal without retry or private-detail disclosure. Hub only, no
migration; recovery is a CI-validated beta reverting this diagnostic change.
See [Google grant expiration](operations/google-oauth-grants.md).

## Unreleased: Google Calendar connects separately

Spaces can connect Google Calendar to read calendars, search events in an
explicit time interval and check availability, then create, edit or delete an
event under the app permission (Calendar defaults to write). It uses a separate scoped
Google grant; existing Drive and other Google connections do not gain calendar
access. Approvals resolve the calendar and show the proposed event, guest
notifications and recurring-series impact. Edits/deletion retain the exact
ETag so concurrent changes fail safely; ambiguous writes are not replayed.
Enable Calendar API and consent to its scopes before native acceptance. Hub
and beta Web only, no migration; recovery uses a CI-validated beta reverting
the connector and preserves events already created in Google Calendar.

## Unreleased: The @ menu says once what each row does

Every row of the `@` menu now says one thing: what choosing it does. `auto`
is written as it is typed and says it picks an Agent by what each is good at,
which is where those descriptions are used, so the separate hint line above
the Agents is gone. An Agent with a description shows it; one without
shows **Say what it's good at** in the same place and grey, only to people
who may write it, instead of a second "Choose automatically" that collided
with `auto`. Badges that repeated the section or the row's own name (human,
app, repo, model and the like) are removed; live presence and "offline" stay.
`@co` no longer lists every App, because kind words and descriptions match
from three letters. Conditions after a summon no longer offer `auto`, use the
condition icon, and an Agent condition wears its face. Following the rule that
early screens name no Run, Instance or Harness, the live Agents section is
"In this conversation", the Agent condition reads "Agent", and instance
actions say plainly what they do. `auto` wears the Agent mark rather than a
lightning bolt. The Agents editor uses the same words in English and Chinese.
No migration or native update is needed; recovery is a CI-validated beta Web
release reverting the change.

## Unreleased: Mention keyboard checks address their trigger

The independent invocation timeline browser case presses Enter on the intended
trigger in one locator action. Its former separate focus and global key could
race the previous popup's frame-delayed initial focus, sending Enter to a close
button or the document instead. Controlled delayed-focus evidence reproduces
that misdirected key on the same deployed client; targeting the trigger passes
the original dialog/progress assertions. This changes the fixture only, with
no production behavior, timeout, tolerance or retry-policy change.

## Unreleased: The first sign-in keeps one query lifecycle

The first sign-in keeps both the open page and its QueryClient, so observers
and actions remain on the same cache without re-consuming a one-time callback.
Leaving any signed-in reader advances a separate mount generation and creates
a fresh client, including first sign-in followed by sign-out; using the word
anonymous for both keys could previously skip that reset. Returning to an
earlier account cannot revive its old mounted state. Existing pin/browser and
callback owner cases cover initial sign-in and account changes. No API, schema
or native change is needed; recovery is a CI-validated beta Web reverting it.

## Unreleased: Message catalog checks start after bootstrap refreshes

The unpaged-message browser case now installs its fixed catalog before one
navigation and drains startup's refresh window before injecting arrivals.
Previously a reconnect and the synthetic messages could share one window:
the normal full-refresh path then read the fixture's permanently old catalog
instead of exercising message promotion. The two-message count and the
shared snapshot without viewer read state keep their original assertions.
No product, API, schema, timeout, retry policy or native behavior changes.

## Unreleased: Page link editing checks start at the selected text

The Page link browser case now verifies that closing its discussion returns
focus to the editor, then moves within the selected guide to expose its link
address. Jumping to the document start and counting one visual Down key could
leave the caret in a decorated title, so the case waited for a control outside
its actual caret paragraph. Drag selection, address editing, continued writing
and unsafe-link assertions stay intact, with unchanged timeouts and retries.
This is browser setup only; no product, API, schema or native behavior changes.

## Unreleased: Message Channel lock failures retain their blocker

HUB-AZ timed out while an Agent append waited for a Channel lifecycle lock.
The event had no holder evidence, and console capture lost the database's
named-query diagnostics. The message failure boundary now explicitly reports
the original exception with that bounded evidence once. The existing slow-lock
sampler also covers Channel lifecycle admission locks, retaining waiter and
blocker owner categories, states and transaction ages before PostgreSQL removes
the wait edge. It shares the execution-report sampler's one-connection bound;
fast locks open no diagnostic connection. Lock order, authorization, public
errors, retry policy and unknown-COMMIT reconciliation are unchanged. This is
missing diagnostic coverage, not a confirmed fix for the underlying contention.
No migration; recovery uses a CI-validated beta Hub reverting this change.

## Unreleased: Query observers follow the signed-in identity

Changing the signed-in identity already creates a fresh QueryClient, but its
mounted query observers could still belong to the previous client. A screen
could therefore show an existing pin while its action read an empty current
cache and pinned it again. Key the QueryClientProvider subtree by identity so
observers and mutations move together; an unchanged identity keeps its client
and mounted state. The existing unpin browser case now changes sessions first,
then checks the empty saved pin list. Pending old-session Done responses and
rapid pin/unpin remain covered. No API, schema or native change is needed;
recovery is a CI-validated beta Web reverting this change.

## Unreleased: Channel catalog tests advance on a committed revision

The catalog-notification browser fixture no longer changes its rows after a
second read. Initial hydration or a legitimate refresh could consume that
response before the test sent its revision notification, inventing a new
Channel prematurely. Install the initial snapshot before navigation and replace
it only when simulating the commit, then send the existing notification. The
owning case now holds the old snapshot across an additional refresh and keeps
its original absent-before/present-after assertions. This changes test data
only; no product, schema, retry policy or native artifact changes.

## Unreleased: Successful stops no longer repeat their status as a message

Stops from UI controls lacked a source command, so their successful Machine
result still posted a separate system fact after inline status replaced that
feedback. Routine success now updates state alone; the Web hides historical
typed success notices too. Stop failures, failed-startup cleanup and external
causes such as access withdrawal remain explained. This ships in the Hub and
beta Web, with no data migration or native update. Stored history is preserved;
recovery is a CI-validated beta reverting this change.

## Unreleased: Spaces can store more than 128 secrets

A Space with 128 secrets refused the next credential even when it was needed
for normal work. The Hub removes that storage quota, and catalog, Run value
and approval reads also work beyond the old boundary. Reads use ordered,
bounded SQL pages and per-request byte budgets; alias listings do not fetch
encrypted values. Existing encryption, live Run authorization and admin
approval remain in force. This ships in the Hub without a schema or client
change. Recovery is a CI-validated Hub release reverting this change; keep
stored secrets intact and restore forward support for catalogs above 128
before relying on an older read implementation.

## Unreleased: Page links open with a click or tap

Bare URLs and Markdown links in an editable page now open directly in a new
tab. Before, opening them required Ctrl/⌘, leaving phone readers without that
gesture. Dragging across link text still selects it, and its visible Markdown
destination still opens the address editor. This ships in the beta Web; no
schema or native change is needed. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Explicit activation keeps mention details open

A mention's delayed hover-close can already be queued when Enter or a click
pins its details open. Both invocation and prose-detail cards now reject that
stale hover close after explicit activation. Escape, an outside press, focus
leaving and ordinary hover-only dismissal retain their existing behavior. A
controlled-clock browser regression reproduces the old disappearance without
changing position, timeout or retry tolerances. No API, data or native update
is needed; recovery uses a CI-validated beta Web reverting the change.

## Unreleased: Sending does not wait for summon previews

Pressing Enter or Send with an Agent mention previously waited up to six
seconds for the draft intent preview before the message appeared. Sending
now takes completed readings for the exact current draft immediately;
unfinished previews use the existing post-send intent check. Changed drafts
cannot carry an older reading. This ships in the beta Web, with no API or
data migration. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: Page edits in a Channel fold to a summary with a preview

An Agent message that changed a page drew its first three changed lines in
full under the message, and clicking anywhere on it opened the page. The card
now folds by default: one line names the page, the sections changed and the
lines added and taken out (+3 −3), and two changes preview on one line each,
cut to where the words changed and leading with what the page says now.
Unfolding lists every change by section; Open page is its own button. This
ships in the beta Web; no API or data migration is needed. Recovery is a
CI-validated beta Web reverting the change.

## Unreleased: Automatic Gmail reads use the Hub's Composio key

Live receipts for automatic Gmail reads reported a failure. A stored Composio
grant holds only account ids, and the Hub adds its project key per call; the
notification worker read without it. The automatic read now adds the key the
same way, and a Hub without one fails the read and names Composio. This ships in the Hub.

## Unreleased: Automatic Gmail reads now reach the Channel

The first release of automatic Gmail reads posted no receipt: each one replied
to the notification, and an App's message cannot be a reply target, so the
append was refused. The receipt now follows its notification, and a refused
receipt is logged by failure kind without mail content. This ships in the Hub.
## Unreleased: Share says who reads a page and who changes it

A page's Share now opens just under its button as one glass pane. "Who can
read" names everyone in the Space, with the page's own link beside them, and
"Anyone with the link" as a switch; once a page is public, its public link
stands under that switch with its own Copy. "Who changes it" holds the
Agents-only-suggest and Space-rules switches. Copying confirms on the button,
and a switch that fails says why beneath itself instead of behind the
dialog. Before, Copy link only ever gave the in-app link, and a failed
suggest-only change said nothing. This ships in the beta Web; no API or data
migration is needed. Recovery is a CI-validated beta Web reverting the change.

## Unreleased: New Gmail messages arrive already read

When a new message reaches a mailbox with notifications on, the Gmail
connector now reads it itself, as the mailbox owner, and answers the
notification with a private Gmail read receipt. The owner sees the message
right there in the Web; everyone else in the Channel, and every Agent, sees
only the mask, and Agents read a message with their own `@gmail:read` as
before. Reads also report Gmail's own SPF/DKIM/DMARC results, so a forged
sender is visible. A failed read never holds back the notification, and after
30 messages in an hour a mailbox's notifications skip the read. This ships in
the Hub; no migration is needed. Recovery is a CI-validated Hub reverting the change.

## Unreleased: An App's page leads with the one thing to do

Every App's page is rebuilt around one lead. Its name, what it does and one
status line come first. When the reader has something to do (connect,
reconnect, fix a broken connection) that one step is a tinted sheet with the
page's only solid action; a credentials-only app shows its form there instead
of below twenty command descriptions. A working app shows no call to action.
Below come what it reaches (accounts, mailboxes, logins, groups), the command
that subscribes a channel, recent activity, permissions (its defaults in one
sentence, then each channel rule), settings, the command reference folded,
and Disconnect last. Every part uses the same rows, quiet actions and "add"
row. The Apps list groups what needs attention, what is connected and what
was disconnected, then every other app once under its category.

## Unreleased: Native scrolling stays free while older history settles

After an older history page loads, a layout callback no longer consumes a
wheel or other pending scroll before the browser has moved the timeline.
That race could mistake the subsequent movement for layout drift and pull
the reader back in either direction. The anchor keeps waiting for movement;
its own corrections and compensated virtualizer changes update the pending
baseline without claiming reader input. Existing quiet and maximum lifetimes
still apply. This ships in the beta Web; no API or data migration is needed.
Recovery is a CI-validated beta Web reverting the change.

## Unreleased: Shared pages read as the page does in the app

A published page (`/p/…`) is set with the live editor's styles on the app's
paper: headings, lists and tables come out formatted instead of bare text. A
thin bar carries where the page sits and the xMatrix mark; the title stands
large, with the faces of who keeps the page current and when it last changed
under it; the page's sections are rules at the right edge. In the app and on a
shared page, tables drop their cell grid for hairline rows, columns fit their
content and short cells keep to one line, and a page's reminders read as their
names in ink instead of sky-blue pills. Web only; recovery is a beta Web
reverting this change.

## Unreleased: The iOS swipe back shows its parent once

An iPhone edge swipe now reveals the parent screen directly. The Web page
commits Back synchronously under UIKit's moving snapshot, without starting a
second Web animation of the outgoing conversation. This fixes the appearance
of returning to the current conversation before reaching its channel list.
The existing iOS bridge is unchanged, so the fix reaches current TestFlight
apps through the beta Web; no new native build or migration is required.
Chevron, Android and browser Back keep their Web transitions. Recovery is a
new beta Web reverting this change.

## Unreleased: The iOS swipe back follows the finger again

On iPhone, dragging from the left edge moves the screen with the finger again.
Let go far or fast enough and the screen goes Back to its parent (a
conversation to its channel list, a page to the page list) and slides off;
short of that it settles back. #1027 had replaced WebKit's history swipe with
one that acted only on release and waited behind the page's own scrolling, so
the gesture felt gone. Back still never walks browser history. This ships in
the iOS app (TestFlight); Web and Android are unchanged. Recovery is a new
iOS build reverting this change.

## Unreleased: Machine registry rejections retain their cause

The daemon socket keeps the exact registry fence and legacy compatibility,
but reports a rejected snapshot or successful spawn with a fixed reason,
full/partial snapshot category, advertised capability and bounded client
version. Sentry retains the originating stack and its issue reader exposes
those fields without report payloads, identities, leases or raw epoch/sequence
values. HUB-AX's generic console event could not distinguish stale evidence
from missing or malformed fields; the next event can. This is diagnostic
coverage, not a confirmed repair of its underlying cause. No schema or client
update is needed. Recovery uses a CI-validated beta Hub reverting this change.

## Unreleased: History anchoring regressions fail on the first attempt

The history-prepend reading-position spec overrides shared CI retries and runs
each case once. Frames are read in a task posted after animation-frame work,
without installing a ResizeObserver that changes layout delivery order. Both
scroll directions are covered, and raw frame coordinates are attached to the
result. The downward case stays short of the finite tail and verifies that it
has room to move. A measured jump cannot become a successful stable gate by
passing a retry. Position tolerances and CPU throttling are unchanged; unrelated
Web specs retain their existing retry policy. This tightens the existing test gate
without changing deployment, signing or publication authority. A known reading
regression is repaired on main and verified in a new beta before another stable
request; runner setup failures retain the existing failed-job recovery path.

## Unreleased: Archive the nested Desktop publisher

Archive Release Assets recognizes the exact historical and nested Desktop
publisher names, as it already does for Android. The nested publisher's successful
job previously failed the archive's component proof despite a complete scoped
production receipt. Both names appearing together remain ambiguous and fail;
missing CLI, unrelated jobs, wrong source/attempt/scope and incomplete receipts
remain rejected. This only repairs mirroring of sealed R2 artifacts to GitHub;
deployment, signing and channel publication are unchanged. Migration uses the
existing workflow, and recovery reruns that archive for the same successful
production SHA, run, attempt and scope without rebuilding or moving tags.

## Unreleased: Apple sign-in failures retain native diagnostic evidence

Apple authorization failures keep up to three native error-domain categories
and codes, plus the app version, build and iOS version, across the string-based
iOS bridge. Unknown domains become `other`; descriptions, userInfo values,
account details and tokens are excluded. The Web captures the native call's
source-mapped boundary before exchanging a token with the Hub. Older shells
still supply their existing error text; older Webs accept the diagnostic string.
Cancellation remains silent and authorization is never automatically replayed.
This supplies missing evidence for XMATRIX-WEB-S's unknown Apple error 1000;
it does not establish or fix the underlying authorization failure. No schema
migration is needed. The native diagnostics require the new TestFlight build;
recovery uses a CI-validated beta Web/iOS release reverting this change.

## Unreleased: Keep history anchoring until scrolling and layout settle

An older history page keeps the reader's place while the virtualizer measures
it. The quiet timer now follows scrolling and layout activity, including
measurements that need no correction, instead of treating stable text as a
settled list. Margin/padding swaps that move text without resizing a border box
are also corrected. Pending input movement is credited before those corrections
even when the browser has not delivered its scroll event yet, so anchoring does
not cancel the reader's scroll. The existing quiet-release and ten-second
deadline remain bounded; iPhone momentum still releases the anchor instead of
writing a scroll. No protocol or schema change is needed. Recovery is a
CI-validated beta Web reverting this fix.

## Unreleased: Installer progress emits complete UTF-8 characters

The Unix download bar repeats full Unicode strings rather than passing them
through byte-oriented `tr`. Its spinner indexes complete symbols in a Bash
array, so even a C locale cannot split a multibyte character. This keeps
terminal output and captured install logs valid UTF-8 for both known and
unknown content lengths. Download integrity and installation behavior are
unchanged; a CI-validated beta Web reverting this change is the recovery path.

## Unreleased: Delayed components validate their frozen release

CLI, Desktop, Android and iOS component jobs verify consistent manifests, the
remote annotated tag and its exact SHA, then the clean checkout's tag/version
and main-history or version-stamp proof. The train still enforces ascending
versions when it cuts a new tag, and component channel pointers still move
only forward. A later parallel Hub tag is not a new version floor for a
component that was already authorized.

In 1.11.2-beta.12, Desktop started after CLI publication and a Hub-only beta.13
had been tagged. Its late global version-order check rejected that frozen
release before Desktop published, although Web and CLI had succeeded.
Migration uses the same release workflows with the shared corrected check;
there is no new deployment, signing or authorization path. Immutable old
tags remain untouched. Recovery is a new CI-validated beta containing this
fix and the failed beta's intents; retrying its old immutable script cannot
repair the check. The real-Git regression reproduces that failure and keeps
new-cut downgrades, wrong remote SHAs, tag/version mismatches and dirty
checkouts rejected.

## Unreleased: Starting two-step sign-in over abandons the old app handoff

After signing out, the two-step page replaces the document with the cleaned
sign-in URL before showing another email form. Previously the form could
appear while client navigation still retained the old app continuation.
Other account switches keep their existing request destination. No schema or
native bridge change is needed; recovery is a CI-validated beta Web reverting
the change. The existing browser regression protects the transition.

## Unreleased: Keep standalone Agent launch context within its budget

The shared bootstrap and Channel reporting text uses shorter wording while
retaining identity, access, approach, progress, final-reply and working-mode
requirements. This restores the existing 9,000-byte standalone/old-Hub launch
budget without raising its limit or weakening the contract. Hub-delivered
launches and the CLI's compiled fallback share the same text; no protocol or
schema migration is needed. Recovery is a CI-validated beta reverting the text.

## Unreleased: Binary-only installation and Agent setup boundaries

The Unix and PowerShell installers can install an integrity-verified binary
without changing shell PATH, sign-in, daemon services, tasks or processes.
Use `--binary-only`, `-BinaryOnly` or `XMATRIX_INSTALL_BINARY_ONLY=1`; connection
setup is rejected in this mode. Default interactive installation is unchanged.

Agent Runs now refuse `setup daemon` and `setup install --daemon` before
Profile admission or installation, matching the existing Human-only Profile
registry and DaemonHost-start boundary. The owner completes connection setup
in their terminal; a Run cannot use installation setup to change its own
identity. No schema migration is needed. Recovery uses a CI-validated beta
reverting this change. See [local connection Profiles](operations/local-connection-profiles.md).

## Unreleased: A page's @ to a live Instance says which one and how the call goes

Calling a live Instance with `@` on a page now writes the conversation it was
called in beside its name, so another Instance of the same name (each
conversation has its own `grok:1`) no longer takes it as its own and answers
twice. The `@` menu names each Instance's conversation and marks busy ones,
listing free ones first. On the page the call is one chip, `@grok:1 # Daily
costs`, with the Instance's live presence for every reader. The caller's chip
follows the call: Sent, Queued while the Instance finishes something else,
Working with its time, then Replied (opening the reply), Done or Failed. The
Agent bootstrap says an `@` naming another conversation is not addressed to it.

This is a Web change plus a CLI bootstrap line; older CLIs still receive the
call correctly but lack the hint. No Hub or data migration. Recovery is a
CI-validated beta Web and CLI release reverting the change.

## Unreleased: Agent controls follow native capability data

Claude controls now derive models and effort choices only from native
initialize data. Discovery merges the built-in effort command's declared
workflow modes with each model's own reasoning levels, so Ultracode and
future modes using that grammar are selectable without a per-name patch.
The static alias/effort fallback is removed. Missing discovery leaves controls
unavailable while ordinary work may continue; explicit parameter requests
still fail. Native command inventories, including empty ACP inventories and
Claude overlays, also prevent documentation lists from restoring absent
passthrough commands. That precedence applies before the first discovery as
well, through one shared merge for session controls and presence. Fixed
protocol bindings remain separate from choices.

This needs a CLI/daemon release and restart or reborn of existing Instances;
no Hub, Web or data migration is needed. Older harnesses without native
catalogs lose guessed controls. Recovery uses a CI-validated CLI beta
reverting the change. See the [capability audit](operations/provider-capability-audit.md).

## Unreleased: A release train records the gates it passed

Production Release Request now writes the full-tier CI jobs it passed into
the content ledger, under the tree those jobs tested. The recorder accepts
that workflow only from the default branch, and only a commit the dispatch
SHA may ship: the SHA itself, its beta version stamp, or a stable stamp of a
source that SHA contains. The recorder identifies that request by its workflow
path: the request's run-name replaces `workflow_run.name` with the train
title. The stamp check is the same one the gate runs
before it checks the release commit out. Manual Public Snapshot CI still
does not record. A later train of the same tree skips gates this run already
passed; if the ledger is missing, those gates run in full.

## Unreleased: Bounded body reads reject without waiting for cleanup

Oversized authentication and connector bodies no longer wait for upstream
cancellation to finish before returning their existing error. A cloned stream
can otherwise wait for another reader indefinitely. Authentication/request,
connector, harness registry and Apple JSON readers now use the same protocol
collector; limits and domain errors remain with their owners, and existing
request/deadline signals also cover body reads. Reader locks always release.
No schema, client or UI change is required. Recovery is a CI-validated beta Hub
release reverting the change.

## Unreleased: Exhausted database recovery retains session progress

Feishu lifecycle cleanup already retries a lost pre-COMMIT response once on a
fresh session. HUB-AV lost the cleanup SQL response and then the new BEGIN
response; its event could not show the rest of either session's progress.
Failures now retain bounded stage durations and attempted query/round-trip
counts, and Sentry issue reads display them beside the failure. Old events
remain readable. No SQL, parameters, identities or driver messages are added,
and no extra queries, retries or COMMIT replays are introduced. This diagnoses
repeated loss; it does not establish or fix its underlying transport cause.
No migration or client update is needed. Recovery uses a CI-validated beta Hub
release reverting the change.

## Unreleased: Auth public-key reads recover a lost database response

JWT verification loads public keys with one independent `single_read`, avoiding
the unnecessary BEGIN that failed for HUB-AT. A lost response retries once on
a fresh connection; repeated loss and answered database errors still surface
as failures, distinct from unknown keys. Adjacent independent Auth directory,
profile, session, handle and OAuth application reads use the same recovery.
Signature, issuer, audience, expiry and revocation checks remain in force;
Auth writes and the multi-query admin detail retain their transactions.
No migration or client update is needed. Recovery is a CI-validated beta Hub
release reverting this change; the underlying transport stall is unassigned.

## Unreleased: Page section awareness recovers lost database reads

Page section awareness and the adjacent blame reader use independent
`single_read` statements for access checks, revision metadata and bodies. A
lost response retries once on a fresh connection; repeated loss and answered
database errors still propagate. This closes HUB-AS's unnecessary BEGIN
timeout path without attributing the underlying transport stall. Placement
fences, page access checks, comparison outside the checkout, and purge-safe
transactional cache writes remain in force. No migration or client update is
needed. Recovery is a CI-validated beta Hub release reverting this change.

## Unreleased: A GitHub App merge no longer speaks its bot login

A pull request subscription tells its conversation when someone else merges
or closes it. The GitHub App's own bot used to post
`xmatrix-connector[bot] merged pull request <link>: <title>` directly under
the merge receipt, restating that card in GitHub's notification voice. That
line is now `Merged <link>: <title>`, or `Closed <link>: <title>` when it was
not merged. A person's merge still names them. No migration or client update.
Recovery is a CI-validated beta Hub release reverting the change.

## Unreleased: The mention menu says an agent's strengths can be written

Typing `@` already shows the first sentence of what a harness is for. The Agent
list now says that text can be written, and each harness has a control that
opens its When to pick it editor with the caret in the text. Those words
follow the person's language, English or Chinese. This is a Web change with
no schema or client migration. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Channel detail reads recover lost database responses

Channel details, including the access check for connector approval lists, now
use independent single reads for the authorized Channel, Instance presence and
visible Human members. Each statement keeps its placement fence and retries a
lost response once on a fresh connection; answered failures still propagate.
This removes the unnecessary BEGIN/COMMIT that exposed HUB-AR to a transaction
opening timeout. As in the catalog, these reads have individual snapshots;
mutations retain their transaction contracts. The real PostgreSQL regression
suite now runs the existing catalog read recovery file as well.
No migration or client update is needed. Recovery is a CI-validated beta Hub
release reverting the change; the underlying transport stall remains unassigned.

## Unreleased: Registration quota reads recover a lost database response

Channel quota projections and owner quota refreshes use one independent
`single_read` rather than opening a transaction for their lock-free SELECT.
A lost response retries once on a fresh connection; a second failure still
surfaces. This closes HUB-AQ's recovery gap without attributing the underlying
transport stall. Authorization, quota freshness and observation writes are
unchanged. No migration or client update is needed. Recovery is a CI-validated
beta Hub release reverting the change.

## Unreleased: Migration regressions execute in the PostgreSQL release gate

The Hub release suite now runs the index drift, Machine query plan and online
migration recovery regressions against its isolated PostgreSQL database.
Ordinary Node checks skip database integrations, and these files were missing
from the real database suite's explicit list. This completes the regression
gate for migration 0220; it needs no new production migration. Release and
recovery still use the existing CI-validated beta train.

## Unreleased: Daemon reports and reconnects use their Machine indexes again

Migration 0137 retired `host_id`, and PostgreSQL dropped the two indexes that
contained it. Since then every daemon report scanned all Machine Run routes
and every reconnect scanned all Launches. Expand migration 0220 rebuilds both
concurrently without the column, during the release's normal migration step;
no query, behavior or client changes. A new schema test fails whenever an
index disappears without a migration naming it. Recovery is a CI-validated
beta release; the indexes are inert to older Hubs and need no rollback.

## Unreleased: Channel replies explain the work and wait for presence

The shared Agent reporting contract keeps material findings and decisions in
separate Channel replies, explaining the cause and chosen fix. Routine status
edits keep the approach visible; Codex's compact reminder explicitly says
local commentary does not reach the Channel. This is guidance for new Runs,
not automatic publication of runtime output or a guarantee of model compliance.
Hub deployment supplies the updated text; existing Runs retain their launch
instructions and older daemons retain their compiled fallback.

Message headers no longer declare an Instance offline while the Channel's
presence snapshot is unavailable. An authoritative empty snapshot still
marks a departed sender offline. This is a hosted Web fix with no schema or
native migration. Recovery is a CI-validated beta Hub/Web release reverting
these changes.

## Unreleased: Failed turns show their actual cause and exhausted quota

Turn-failure cards use the program's original error as their title for every
cause, including unknown failures and historical notices. The error passes
through without requiring a category-specific title. The Hub projects
its existing used-up-account classification into additive failure evidence;
the Web uses it for English/Chinese reset-or-handoff steps instead of immediate
retry advice, without replacing the original error. Structured reset times display in UTC;
prose-only reset hints remain as written. HTTP rate limiting stays distinct,
and the existing quota hold and automatic handoff are unchanged.
This needs a beta Hub/Web release, no native update or data migration. Older
clients ignore the added field. Recovery is a CI-validated beta reverting the change.

## Unreleased: Unaddressed evidence commits with its publication

The Human message append now records recipient absence inside its existing
transaction and Channel lock. Post-commit only publishes state: an Agent that
exits after receiving the message cannot turn that delivery into an unaddressed
action. A lost post-commit no longer loses a named/later message's witness.
Expand migration 0222 adds a nullable commit witness flag; prior observations
stay unknown and cannot authorize new choices. Imported history is excluded.
No Web or native update is needed. Recovery uses a CI-validated beta Hub release;
keep the additive flag and never backfill it from current Instance state.

## Unreleased: Unaddressed messages have an explicit Agent choice

Human speech that the Hub positively confirms has no recipient gets a choice
under its original message, including named conversations, later messages and
the welcome conversation. Connecting a computer or reopening the UI does not
launch it. The author explicitly selects an Agent; this claims the existing
per-message launch decision and durable summon lane. Missing tracking remains
unknown. Existing execution failures retain their current notices.

Expand migration 0221 adds unaddressed publication evidence and optional source
snapshots to launch choices. Source edit/recall/delete, current permissions and
Channel stop fence late admission. The invocation response adds optional `asks`;
older clients ignore it and keep the legacy connection reply, whose instructions
mention the Agent with the question so untracked history also has a working path. No native update
is required. Rollback uses a CI-validated beta Hub/Web release reverting the
code; additive schema can remain. See [message asks](architecture/message-asks.md).

## Unreleased: Machine reports and enrollment recover a lost database response

Machine daemon commands, Run lifecycle mutations and execution report storage
retry once in a fresh database session after a connection loss before COMMIT.
The failed session closes first, and locks and authority checks run again;
socket wakes, route publication and notices remain outside the replay.
Unknown COMMIT results keep their existing receipt reconciliation. This fixes
HUB-AN/AP's recovery gap without claiming the transport stall is diagnosed.
Page search also uses independent single reads with the existing membership,
page access and placement checks, recovering HUB-99's lost response without
an unnecessary transaction opening.
No migration or client update is needed. Recovery is a CI-validated beta
release reverting this change.

## Unreleased: Page conversations are easier to find

The page margin uses one quiet line at each edge for conversations above and
below, with an explicit unread count. Its cards stay clear of those lines.
The position rail marks live conversations at their document anchors, turns
unread marks red and outlines the current viewport; clicking a mark jumps
to that passage. The toolbar comment count opens the existing conversation
list with All / Open / Resolved filters, including on phones. This is a Web
change with no data migration. Recovery is a CI-validated beta Web release
reverting the change.

## Unreleased: Page references stay readable in compact previews

Co-writing notices in page margin cards, conversation rows and other compact
previews display current Page titles instead of `page:<id>` locators. Missing
context, unavailable references and truncated locators use generic labels;
message reference chips also stop falling back to raw IDs. References to an
unnamed Channel use a generic label rather than a fragment of its ID. A Web lint rule
rejects direct Page ID text/labels and DOM text assignments, including local
aliases and string formatting. Dynamic preview contents pass through the shared
reference renderer. Routing, stored messages and Agent instructions are unchanged.
This is a hosted Web fix with no data or native migration. Recovery is a
CI-validated beta Web release reverting the change.

## Unreleased: Billing reads recover a lost database response

Billing summaries, including the plan check used by search reranking and Jev
admission, now use independent single reads with the existing Space placement
fence and membership check. A lost response gets one fresh connection attempt;
exhausted recovery still surfaces the database failure. The read no longer
waits for an unnecessary BEGIN or COMMIT. Billing mutations keep their existing
transaction and reconciliation behavior. This repairs HUB-AM's recovery gap,
without claiming the underlying transport stall is diagnosed. No migration is
needed; recovery is a CI-validated beta reverting this change.

## Unreleased: Workspace refresh rejections identify the receiving build

Rejected workspace refreshes retain a fixed validation stage, a known resource
kind and the receiving Worker version in the publisher's existing error report.
They never echo event contents or identities. This distinguishes protocol
rejection from envelope, watermark and recipient failures for HUB-AK; its
original rejection is not reproduced and remains under investigation. Valid
refresh delivery and rejection behavior are unchanged. Recovery is a
CI-validated beta release reverting these diagnostics; no migration is needed.

## Unreleased: Escape closes the focused attachment preview

Markdown and video previews close on Escape even when their own controls have
focus. Their container still keeps keyboard events out of the conversation.
An image opened inside Markdown closes first; a second Escape closes the
Markdown preview. This is a hosted Web fix with no data or native migration.

## Unreleased: Repository completion loads once per Space

Entering a Space preloads its launch candidates once and shares the result
across composers and repeated `@` picks. There is no repository polling timer.
GitHub connection changes and signed repository/installation events invalidate
the affected Space's query; socket reconnection recovers missed notifications.
GitHub catalog events advance the connection version used by edge caches, so
an older regional cache write cannot undo an invalidation. Reconfirming an
existing installation also advances that version, even when its linker stays
the same. Existing clients
ignore the new resource notification; the hosted beta Web consumes it.

Cold catalog reads avoid redundant personal-owner permission requests using
GitHub's current stable owner id, and keep eight permission workers occupied
without batch barriers. The actual repository credential mint retains its live
permission checks. App webhook subscriptions determine which provider changes
arrive; missed events may leave suggestions stale until reconnect or Retry.
No schema migration is needed. Recovery is a CI-validated beta release reverting
the change; candidate queries then return to loading on completion.

## Unreleased: A remembered session cannot skip a login's second factor

An app's provider sign-in that asks for an authenticator or backup code stays
on that step until this visit verifies it, even when the sign-in browser already
has a website session. The same pending step holds webpage redirects and device
approval. Starting over abandons that app handoff and signs out before offering
another login. Successful login handlers now feed one signed-in exit, preserving
the app's finish address and a new account's welcome path without competing
navigations.

This is a hosted Web change; no native shell or CLI update is needed. Recovery
uses a CI-validated beta Web release reverting the change and restores the
previous remembered-session behavior; there is no data migration.

## Unreleased: Search timeouts retain recovery diagnostics

The common Hub PostgreSQL outage response reports the original exception and
both failed database attempts in one Sentry event. Failed message searches add
filter categories and pagination progress, without search text, cursor values,
identities or SQL. The issue reader exposes this bounded evidence so repeated
slow queries can be distinguished from transport stalls. Recovery remains one
fresh connection attempt and exhausted requests remain retryable HTTP 503s.
This adds diagnostics; the cause of HUB-AG's two read timeouts is not yet known.

## Unreleased: Authentication request bodies are bounded before validation

The Hub refuses authentication bodies larger than 64 KiB with HTTP 413 and
`request_too_large`, before JSON decoding or Better Auth schema validation.
It counts actual streamed bytes and cancels oversized input, even with a
misleading Content-Length. Login, passkey and OAuth requests within that bound
keep their existing formats; attachment uploads retain their separate limit.
This mitigates oversized unbounded collections in the current authentication
schemas; a Zod version bump alone does not bound those collections.
Rollback is a beta release of a CI-validated revision reverting this limit;
it reopens the larger validation-input boundary and needs no data migration.

## Unreleased: CLI resource limits compile across supported Rust versions

The acknowledged Page-output queue and live trace-read limit share a checked
atomic reservation loop. This preserves their capacity limits on both Rust
1.96 and current stable Rust, where `fetch_update` was renamed. Recover the
failed beta.6 CLI build through a new CI-validated main revision and Release
Intent; its immutable tag and already deployed Hub/Web stay unchanged.

## Unreleased: The Hub writes each message an Agent reads

Each Channel message an Agent receives now comes with the Hub's rendering of
it: the header with its Channel, ids, delivery time and sender, the message it
replies to, its body and attachments. The runtime uses that text as the turn
and adds only where it saved attachments on the machine, so the wording of a
turn changes with a Hub deploy. Older CLIs, and terminal (PTY) harnesses, still
write the message themselves.

## Unreleased: The Hub handles streamed page writing

Page-writing markers in conversation replies and answers to “write together”
now use one acknowledged output path. The Host forwards assistant text and
resolves local attachment references; the Hub interprets writing instructions,
checks current Page access and confirms text only after applying it. A lost
reply can be retried without writing twice, and rate-limited text stays on the
Host until the Page accepts it. Human edits, undo and suggestion-only policy
keep their existing Page semantics. Cancelled or disconnected answers cannot
be adopted by a new co-writing session. Unclassified Codex raw events remain
diagnostics and cannot enter this writing path.

This needs the new CLI once. After that, Page parsing and writing policy can
change with a Hub deploy. Older Hubs keep the previous transport. If a live
writer's state is lost, the runtime reports an unconfirmed write and stops that
output instead of replaying the model's task. This does not promise exactly-once
model execution or a fixed model response time; first visible text is measured
separately in the end-to-end release verification.

## Unreleased: Some xmatrix commands now come from the Hub

`xmatrix automation …` is now defined by the Hub: the CLI passes the command
line on and prints the answer, so its options, help and output change with a
Hub deploy. `xmatrix commands` lists every command defined this way, and
`xmatrix --help` points to it. The commands behave as before. Commands that
work on the machine itself stay in the CLI. This needs the new CLI once; older
CLIs keep their built-in `automation` command.

## Unreleased: Machines take the harness list from the Hub

The list of supported harnesses, with how to find, install, update and sign in
to each, now comes from the Hub when a Machine connects, instead of only from
the copy built into its CLI. Adding a harness that speaks a protocol xMatrix
already supports, or fixing an install command, reaches every Machine with a
Hub deploy. A Machine resends nothing when its list is already current. This
needs the new CLI once; older CLIs keep their built-in list.

## Unreleased: Official runtime texts can change with the Hub

The Hub can now send the runtime further official texts by name, beside the
launch prompts it already sends. The words a resumed session starts with are
the first: they are now edited in the repository and reach the next Run with a
Hub deploy. Moving another fixed runtime text this way needs no protocol
change. This needs the new CLI once; older CLIs keep their built-in copies.

## Unreleased: The Hub writes what a new Agent reads first

The conversation a newly launched Agent reads before its first turn is now
chosen and worded by the Hub in one request. Changing that text, its order or
its size limit no longer needs every Machine to update its CLI. Long
conversations read only their newest part instead of every message, and the
conversation's About is fetched only when the transcript had to be cut, which
removes a directory read from most launches. This needs the new CLI once; older
CLIs keep reading history as before.

## Unreleased: Live updates reach each person in their own Runtime cell

Every product socket has lived in its owner's own Runtime cell since 1.0.0, but
deliveries were still routed through a directory that listed a person's cell
only for the conversation they were viewing. A Space's catalog changes and
workspace lists went to a cell that held no socket at all, and a message in a
conversation nobody was viewing reached only the owners of its live Agents. A
new conversation therefore appeared in its creator's list only once an Agent
replied.

- **Addressing.** The authority names who a delivery is for as it commits it:
  the people who may read it and, for a message, the owners of the Channel's
  active Runs. The publisher sends each of their cells one request saying what
  that cell serves, within a bounded budget, and serves its own cell locally.
  An Agent receives a message once however many people read the Channel.
- **Admission.** A cell admits only its owner's sockets. A connect is checked
  as soon as its credential names the account, before it claims, counts or
  announces anything, and a socket back from hibernation before it is restored.
  A socket that names no owner is told to upgrade.
- **Presence.** An Agent's status report asks who may read the Channel at every
  report; a remembered audience no longer decides. A Channel snapshot built from
  Agent presence says it speaks for the Agents alone (`presenceCoverage`), and
  only clients that declare `presence_coverage_v1` receive it. A person who
  opens a Channel is sent each of its Agents' cards as they are now (branch,
  goal, model catalog, commands, offline while its machine is), read from the
  cells that hold them; before, only the owner's own Agents were shown this way.
- **Web.** A resolve asked after a message or a create never takes the answer
  of one asked before it, and a conversation joins its creator's list as soon as
  the Hub confirms it.
- **Retired.** The Runtime route directory and Channel fanout objects stay
  bound as 410 shells, and `XMATRIX_RUNTIME_CELL_MODE` is gone.

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
  simulator) gate the stable that ships them. Every train runs CodeQL on its
  source for Hub, Web and Desktop JavaScript and TypeScript, and for the
  workflows it releases, before anything deploys. Rust, Kotlin and Swift
  CodeQL run on the stable train that ships that client, beside those client
  suites (`docs/operations/ci-lint-and-public-runners.md`).
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
requires `xmatrix.sh` for betas before `1.3.1-beta.7` and `beta.xmatrix.sh`
from that first split train onward. Before a train deploys
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
- macOS CLI releases publish `xmatrix-macos-arm64` and `xmatrix-macos-x64`; hosted builds use Apple Silicon and Intel respectively, and sign both with the same Developer ID identity. The self-hosted Apple Silicon runner still cross-compiles Intel. Both artifacts must execute their exact-version probe before publication. `install.sh` installs the native arm64 binary when its shell runs under Rosetta.
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

## Unreleased: Leaving a newly made Page preserves its first edits

A new Page's creation snapshot can contain only its first character. Leaving
once creation returns, before the first live sync, now keeps that session
alive for the same bounded 15-second handoff already used while creation is
pending. Its response to the server's state vector includes the rest of the
local document before closing; repeated disposal cannot cut that handoff
short. Ordinary established sessions and unseeded creation keep their existing
behavior. No schema or native change is needed. Recovery uses a CI-validated
beta Web release reverting the change. Browser/process termination or a sync
that cannot complete within that bound retains its existing limitation.

## Unreleased: The Agent picker keeps one complete selection

The strengths editor control stays independently clickable while the Agent
choice keeps its full inset selection surface. A hidden, inaccessible copy of
the same responsive label reserves its width; the actual control is a sibling,
so buttons are never nested. Hovering that control uses the row's existing
selection fill. This restores the established mention geometry contract without
changing keyboard selection, routing or profile permissions. No migration or
native update is needed; recovery is a CI-validated beta Web release reverting
the change.

## Unreleased: Execution report lock failures retain their blocker

HUB-AY lost a Run-lock response, then its one fresh-session replay hit a lock
timeout. The event did not identify the holder. A slow execution-owner query
now takes one bounded, independent read of the live PostgreSQL wait edge,
before a lock timeout erases it. Failures retain waiter and blocker state,
transaction age and fixed owner categories; SQL, parameters, backend ids and
user identities stay out of the event and Sentry issue reader. Fast queries
open no extra connection, and each isolate permits only one concurrent sample.
Unavailable diagnostics preserve the original error. Existing replay and
unknown-COMMIT boundaries are unchanged. This is missing diagnostic coverage,
not a confirmed repair of the underlying contention. Hub only, no migration;
recovery is a CI-validated beta Hub reverting the change.


## Unreleased: Agent catalog reads recover one lost response

HUB-B4 exposed an Agent catalog read that held a member lock and failed after
a lost PostgreSQL response. Membership, visibility and pagination now share
one placed single read; machine and quota enrichment uses its own directory
single read. Each retries a lost response once on a fresh connection, while
a second failure remains visible. Nonmember rejection, private projections,
mutation locks and unknown-COMMIT reconciliation are unchanged. Hub only, no
migration or native update; recovery is a CI-validated beta Hub reverting
this change. See [PostgreSQL recovery](operations/postgres-hyperdrive-origin.md).

## Unreleased: A skipped check cannot announce that CI passed

A pull request with a merge conflict did not start CI, but its skipped
external-PR closer alone made the conversation hear "CI passed". The GitHub
check reader now requires a check that actually concluded success before
announcing a passing verdict. All-skipped or all-neutral checks stay pending;
failures still report, and success beside skipped jobs still passes. Hub only;
no schema or client migration. Recovery is a CI-validated beta Hub release
reverting this verdict change.

## Unreleased: The Intel CLI builds on an Intel runner

GitHub's ARM64 runner capacity shortage cancelled both macOS CLI jobs before
assigning them a machine. The Intel target now uses the standard
`macos-26-intel` pool; ARM64 keeps `macos-26` and its native executable probe.
Desktop also stays on Apple Silicon to retain its signed ARM app startup
check. Target architectures, pinned Rust, Developer ID identity and R2 byte
verification retain their existing gates. Qualification is a complete beta
with both native CLI version probes and publication verified. Historical tags
retain their original workflow; recovery is a CI-validated forward release
restoring the Intel build host if needed. No client or schema migration.


## Unreleased: Sentry event claims reconcile an unknown COMMIT

HUB-BY lost the response to a Sentry recovery claim's COMMIT, leaving its jobs
leased until expiry. Claims now assign independent lease nonces before their
transaction. After an unknown COMMIT, one lock-free read returns only this
invocation's committed, unexpired leases and live receipts. It never repeats
the claim; absent results retain minute/expiry recovery, and read failures
remain visible with the original commit evidence. Current grant checks also
recover one lost read on a fresh connection. Capacity, grant and lease fences,
and delivery idempotency stay intact. Hub only, no migration or client change;
recovery is a CI-validated beta Hub release reverting this change. This repairs
the recovery gap without attributing the underlying connection termination.

## Unreleased: Agent binding refusals identify the failed comparison

HUB-C1/C2 duplicated one handshake refusal without identifying which binding
comparison failed. The Hub now reports one event with a fixed comparison source
and field, available through the Sentry issue reader and correlated with the
socket's diagnostic reference. Credentials, names, routing ids and compared
values are excluded. This supplies missing diagnosis, without attributing the
original mismatch. Existing refusal codes, retry policy, failed-handshake close,
connection claims and strict authority checks remain unchanged. Hub only; no
schema or native change. Recovery is a CI-validated beta Hub reverting the change.
