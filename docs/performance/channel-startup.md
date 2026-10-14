# Channel startup performance

## North star

Target: p95 navigation-to-first-authorized-message paint at or below 2 seconds
for an authenticated browser opening a Channel with an empty HTTP cache and no
local message replica. This is a product target, not a measured production result
of this change. Report empty Channels separately, using the authorized empty-state
paint as their endpoint.

Compare at least 30 baseline and candidate runs on the same network, device,
Channel, and production build. Retain the session but isolate the HTTP cache and
local message storage deliberately; disabling HTTP cache alone does not simulate
an empty local replica. Also report warm reopen separately.

Supporting measures:

- Navigation to history request start, and admission-ready to history request start.
- Compatibility request count: one successful admission per Hub/client identity
  per page lifetime, including the anonymous-to-authenticated transition.
- Exact-ID route history starts before Channel resolve completes. A delayed resolve
  must not cause another identical initial history read after it completes.
- p50/p95 first-message paint and API response time, plus request and SQL counts.
- No regression in account isolation, revoked grants, DM isolation, Channel moves,
  pagination, runtime reconnect recovery, or compatibility rejection.

## Implemented critical path

App admission is keyed by Hub origin, component, version, protocol, and platform.
The page-lifetime admission cache survives the per-user QueryClient replacement;
it shares in-flight work and does not cache failures. The preparation gate's
observers use a separate, gate-owned QueryClient containing only client identity
and admission, so replacing the account-scoped client cannot briefly unmount the
admitted shell and cancel/restart its authenticated reads. User data remains in
the account-scoped QueryClient. Socket recovery explicitly
invalidates admission and checks the server again. Server compatibility checks
and cookies remain unchanged.

Once admission and authentication are ready, exact-ID links start a bounded
initial history prefetch while resolving metadata. The prefetch is private to one
shell and keyed by user, token, Channel, and presentation epoch. It expires after
15 seconds, aborts when superseded/unmounted, and is consumed through the normal
history query. A newer known Channel head or changed identity discards it. Metadata
and existing render-authority checks still gate display; a speculative response
never grants permission to render or installs a verified local replica.

After startup settles, recent-Channel history read-ahead considers only the first
eight Channels in the current Space's catalog order, with two concurrent reads
and a 600 ms initial delay. Each free lane selects from current eligibility:
open, empty, cached, or recently attempted Channels are skipped. There is no
separate queue of Channel IDs to keep synchronized with navigation or cache
writes. Catalog churn does not abort reads already in flight; changing the token
or unmounting aborts them and clears the pending timer. Attempt timestamps belong
to that token's lifetime, with a 60-second retry window.

Read-ahead fills only missing in-memory history windows. It neither replaces a
window populated by an interactive open nor persists a verified local replica.
Normal history authorization still gates rendering. The browser warm-up tests
hold both lanes while an interactive open overtakes a waiting Channel, then
verify that the newly open or cached Channel is not read again speculatively.

The current route resolves with `includeParticipants: false`. This additive
request option skips closed-member enumeration, Agent presence, open-Space member
lists, and live Human presence. Participant fields are omitted rather than set to
empty arrays/maps, so merging metadata does not clear an existing roster. Omission
of the option preserves the full response for existing consumers. The Web client
uses separate full/metadata query keys and hydrates full participants after the
initial history settles.

Workspace projects/events, Automations, Agent Profile/machine reads, root
catalog/counts, and ancestor page hydration yield to route metadata/history.
Bare `/app` and Channel-list routes also defer this background work until the
selected Tree/Flat root page settles. Interactive list reads remain enabled;
empty and failed pages release background work too. The saved view preference
must settle before a provisional Tree result can release a saved Flat view.
Focus and non-Channel destinations load their own data immediately. Workspace
readiness depends on Spaces, not deferred project metadata. An
8-second escape hatch releases background loading when the Channel cannot settle;
a failed or empty history must not starve navigation indefinitely. Authentication,
Spaces required for route resolution, and projection safety preparation remain
immediate.

On desktop, a list route that automatically selects a Channel also waits for
that Channel's initial history before releasing background reads. The startup
gate predicts the same selection as the selection effect, avoiding a one-render
gap between catalog settlement and selection. Its catalog-scoped eight-second
deadline is retained across the automatic selection. Mobile list-only routes
still release after their catalog page; empty lists and non-message views do not
wait for a nonexistent transcript. Unavailable history still releases via the
bounded startup escape hatch.

Catalog page requests carry `includeCounts=false`; the separately deferred count
request carries `countsOnly=true`. The Web proxy forwards both flags to Hub.
Otherwise each request reverts to the combined page-plus-counts read: foreground
pages perform an unnecessary count query, while background counts also enumerate
Channel rows and load presence. Omitting the flags preserves the existing combined
response for older callers; authorization and pagination remain Hub-owned.

Catalog pages start the optional Runtime Human-presence read alongside the
authority query, with a 250 ms total presence budget including response-body
reading. Timeout, failed responses, or invalid snapshots omit `memberPresence`
instead of interpreting missing data as an empty roster. The request is aborted,
an in-progress body reader is cancelled, and late responses are discarded and
their bodies cancelled. This bounds only the optional read, not authorization or
the database query. A successful empty snapshot remains a real empty Human
presence result and retains the authoritative Agent snapshot.

Web merges omitted presence without clearing previously hydrated state. A Human
with no known snapshot is presented as `Status unknown`, with no offline status
badge; complete snapshots and existing realtime/catalog updates restore the
usual presentation. No retry loop or new presence authority is introduced.
Ship this Web presentation support before or with the Hub deadline change so
older Web code does not interpret an omitted cold-start roster as offline.
Full Channel resolve/detail reads retain their existing behavior.

Single-Channel details now use a dedicated authorized query. The shared capability
predicate includes current membership and grants in that query; there is no
separate membership round trip or unused catalog-head read. Its full public shape
is preserved. History combines cursor, content revision, and history head in one
metadata statement, saving one additional database round trip.

Placement routing and authoritative transaction fences remain in place. The
existing catalog placement-hint cache is retained; this change does not turn a
cached route into authority or combine transactions across migration fences.

## Cold-start editor loading

The shared shell imports Pages for navigation and list presentation. Its document
editor previously pulled CodeMirror and Markdown editing into every initial app
load, including iOS and Desktop lists with no open document. The editor now has a
client-only dynamic import and loads only when an open page renders it. Existing
HTTP document presentation and live-session authorization remain unchanged. The
ProseMirror editor and the page document model (`@xmatrix/protocol/page-document`)
stay in that lazy chunk; the shell imports only their types.

Local production builds of this change measured the unique initial JavaScript
files in `.next/app-build-manifest.json` for `/layout`, `/app/layout`, and
`/app/page` (sum file bytes; gzip each file with Node's default `gzipSync`):

| Metric | Before editor split | After editor split |
| --- | ---: | ---: |
| Initial JS bytes | 2,911,370 | 2,369,274 |
| Gzip bytes | 881,666 | 693,161 |
| Initial JS files | 28 | 27 |

This removes 542,096 uncompressed bytes and 188,505 gzip bytes (21.4% of compressed
initial JS). It measures the build dependency graph, not network transfer,
device parsing time, or iOS/macOS process-restart latency. The browser regression
checks that the Channel list does not request editor assets; the Pages suite
checks live co-editing and document presentation after lazy loading.

## Foreground recovery

Visible, online pages refresh the loaded Channel catalogs and the selected
Channel's authorized latest history page on focus, visibility restoration,
network restoration, and `pageshow`. Signals within one second are coalesced.
History catch-up bypasses the socket grace period and prior focus-page response,
so an OPEN but unresponsive mobile socket cannot hold it behind its pong timeout.
The existing account, Channel, and projection-scope fences still gate history
application. Failed catch-up keeps the existing presentation and recovery paths.
Periodic online history fallback also stops trusting a focus response after one
history refresh interval. Message activity refreshes flat catalog indexes even
when the changed Channel was outside their loaded pages or filter, including
imperatively loaded lists without an active query observer.

`mobile-foreground-refresh.spec.ts` covers mobile list recovery and catch-up
with an OPEN socket that stops delivering. These are controlled behavioral
regressions, not measured device or production latency results.

## Startup verification

`apps/web/e2e/channel-startup.spec.ts` holds resolve pending to verify history starts
first, cannot paint early, and reuses its initial page. It also delays a real-shaped
auth session to verify admission survives QueryClient replacement. These are
controlled browser ordering tests, not production latency measurements.

The preload/admission unit tests cover in-flight reuse, identity changes,
cancellation, expiry, failures and explicit revalidation. The PostgreSQL catalog
integration test checks omitted participants, full hydration, dedicated detail
query counts, DM isolation, and grant revocation against PostgreSQL 17. Existing
catalog/move, message history and Hub presence tests remain applicable.

## Child-Channel expansion

The interaction target is approximately 50 ms from clicking Expand to showing
prepared child rows. A cache miss still needs an authorized network response;
50 ms is not a promise for an arbitrary unprepared branch over the public network.

After startup history yields, loaded catalog pages prepare the first child page
of up to four branches. Pointer intent and keyboard focus can prepare another
branch. Speculation uses one request at a time, at most four queued selectors,
a five-second request timeout with no automatic retries, and up to eight cached
pages per Space with 30-second garbage collection. Promotion accepts only pages
less than 15 seconds old. Queued selectors recheck the visible cache before running, so an intervening
interactive read suppresses redundant speculation. It never recursively
downloads the whole tree.

Speculative pages have a separate cache namespace under the same Hub/user/Space
identity. They do not enter the visible entity table or open a collapsed branch.
Clicking promotes a ready page immediately, or joins its in-flight request using
the normal loading state. Catalog revisions and structural/message notifications
discard speculative pages; an invalidated in-flight result cannot be promoted.
Permissions remain enforced by the same server catalog endpoint. Pagination and
explicit retry continue through the existing interactive path.

Controlled Chromium desktop measurements (10 isolated browser contexts, local
production Web build, synthetic API responses, prepared first child page):
p50 32.0 ms, nearest-rank p95/max 34.4 ms from click to the animation frame after
child-row insertion. All ten clicks used the prepared page without another child
request. This is a small local interaction benchmark, not production p95 or a
measurement of cold network fetches. Desktop/mobile failure recovery and catalog
invalidation are covered separately, including changes during an in-flight
prefetch and interactive reads overtaking queued speculation.

## Native repeat-start asset caching

The Web Worker applies `public, max-age=31536000, immutable` only to successful
200/304 responses for hash-named JS/CSS under `/_next/static/chunks` and
`/_next/static/css`. The policy is applied where the ASSETS response is returned;
Next.js headers do not govern that branch. HTML, APIs, unhashed files, redirects,
and error responses retain their prior behavior. A new Web build uses new asset
URLs, so native shells keep loading live Web updates. This does not change asset
retention, offline fallback, native signing, or the release workflow.

## Electron browser storage

Electron now selects the same IndexedDB/OPFS and Worker replica implementation
as Web, even when an installed shell advertises the legacy `relayV2` bridge.
History, local search, attachment reads, scope revocation, and browser cache
maintenance use that backend. The existing bounded recent-history cache remains
in the embedded browser's own profile; it is not shared with external Chrome.

The shell no longer starts its native projection sync or lifecycle timer at app
startup. Legacy native read IPC explicitly starts that runtime on demand so older
Web pages can still use their existing contract. New Web pages never issue those
reads. Old installed shells require a Desktop update to stop their automatic
background sync; the Web routing change alone cannot change an old main process.

Existing daemon bytes are not imported into browser storage. Browser data uses
the same browser/OS profile protection and cleanup guarantees as Web, rather than
the daemon encrypted-store guarantee. Explicit Remove All Local Data and logout
retain the old native cleanup path when the bridge is present, in addition to
browser cleanup, so previously saved native data does not become unreachable.
CLI/Agent history caches and management baselines retain their existing owners.

Coverage includes backend selection with legacy bridge metadata, browser Worker
creation and message paint under an Electron-shaped bridge that rejects native
reads, and absence of readiness/sync requests before a legacy native read starts.
These are behavioral checks, not a measured production speedup. Measure cold and
warm opens separately before attributing the reported macOS delay to storage.

## Live Instance load

The shared Web, Desktop and native WebView shell keeps Channel and Agent live
projections in session-owned external stores. Conversations subscribe to their
own Channel key; mounted desktop and mobile list rows do the same. Presence
reports do not replace the catalog snapshot used for navigation and message
reference names. Fleet destinations subscribe to the complete live projection;
the rail's working indicator subscribes to its boolean result. Account changes
clear the projections, and authoritative catalog changes still update every
consumer. These are presentation caches, never authorization evidence.

A flush builds member/global Instance routing once and stages Agent cards and
partial Channel snapshots in socket order. Interleaved card/snapshot pairs
materialize and publish the live collections once per contiguous state run. A
roster, catalog or access change publishes before its invalidation side effects;
message/history/control handlers see all preceding state synchronously. Snapshot
merges retain read cursors, quotas and omitted compatible fields. Each event
batch is merged and sorted once. Messages, history replies and request answers remain immediate ordering
barriers; lifecycle and Channel snapshots wait for the same flush but retain
every frame, so omitted fields in compatible patch snapshots are not lost. Compatible whole-Channel
snapshots that change only member presence notify their Channel key. Instance
roster additions/removals also update the catalog so offline message badges and
reborn controls cannot lag behind avatars; any other
field change for a known Channel still updates the catalog and revalidates trace
access. Snapshots of unloaded Channels hydrate live keys without repeatedly
refetching the entire catalog; its own pages, create/delete frames and revision
watermarks discover navigation rows.

A rank-preserving live run stages complete replacements in a small overlay over
its immutable input. The collection applies those cards to its private live
index instead of rebuilding and diffing the full Channel table. A complete
array is captured before synchronous subscribers can publish another snapshot.
Catalog and rank changes retain an immutable full commit whose index follows
the final row order; ordinary catalog, read-state and account-reset writes
retain full reconciliation. A sealed producer rejects further writes.
The next run may take the completed run's member/Instance routes and private
Channel positions once, only
when its input is the exact published snapshot. Any intervening writer or a
failed publication discards that handoff and rebuilds from current state.
Agent cards replace entries in the same live index; their full array is
materialized only when a reader needs it. The first update after an external
index or catalog publication forks the index, protecting earlier snapshots.
New or renamed cards still sort immediately, preserving stable name ties
across runs. A small number of newly seen cards uses binary insertion into a
private ID order; renames, larger additions and unknown external order retain
the stable full sort. The keyed index no longer needs rebuilding just to sort
new cards. Catalog promotion materializes once and relinquishes that private
write ownership before notifying readers.

An inherited sidebar order also avoids a full sort for a few new or re-ranked
Channels: binary insertion uses the existing comparator and stable tie order.
Unknown input order and larger changes retain the normal full sort. The private
position index passes to one successor only; when newly seen Channels append
after the existing order, only their tail positions are added. Public arrays
and completed commit indices never share this private routing index.
The Channel header follows structural catalog fields and selects only live Human counts,
so Agent activity neither rerenders its controls nor resynchronizes its name
draft.

A Run's activity, intent, token counters and last-seen clock stay in its Channel.
Only account quota travels to sibling Channels, and repeated quota readings
reuse unchanged objects. The work dock selects its visible presentation, including
trace-derived status, intent, waiting details, notices, quota verdicts and control
capabilities. Activity-only reports retain the selected array and Instance cards;
new event/query inputs also share equal views. The view contains no actionable
Instance snapshot: Trace, Stop, Reborn and Handoff resolve the exact current key
from the live Channel at execution, including the second confirmation press.
Removed keys do not fall back to an older catalog item.
Unchanged intents retain their age without dispatching a no-op state update.
Channel ordering parses timestamps once per immutable snapshot; replacements
receive fresh keys and discarded snapshots are held only weakly.
The selected Channel's subscription belongs to its header, composer and work
dock. Message avatars select only their visible status; trace opening and
lifecycle controls read the current Channel/Agent projections on demand.
Activity never becomes a historical message-row dependency. Timeline building
indexes thread roots and origin Channels once and consumes a structurally
shared Channel event slice instead of scanning the catalog for each message.
Head catch-up still probes the socket after successfully applying missed rows,
even when that application synchronously commits and cleans up the read effect.

Regression coverage counts workspace, conversation-row, work-dock, Instance-card and message-row renders
in `live-agent-load-render-scope.spec.ts`, including cards and whole-Channel
snapshots. The presence owner tests cover sibling-Run isolation, unchanged quota,
and a 1,000-report digest with a bounded number of Channel inspections. The
Agent browser benchmark sends 100 legacy two-frame reports per second
for 60 seconds of ten-report bursts every 100 ms and 240 seconds of single
reports every 10 ms, including ten working Instances with live intent text in
the open Channel. Performance cases run one worker at a time so another load
generator cannot contaminate a renderer's wall-clock budget. Each cadence checks receipt counts, the final
report, the last focused Instance activity in the real trace window, one
uninterrupted socket and the delivery deadline, plus absolute renderer
`TaskDuration / elapsed` below 10% overall and in every ten-second window. Normal
animations remain enabled and idle work is included. Frames arrive through a
real loopback TCP WebSocket in the production Human Worker. Both the physical
connection and the Worker's connection/packet counts are witnessed, so native
fallback cannot silently stand in for Worker coverage. A final ordinary control
frame flushes the last packet before the original delivery deadline; no drain
wait extends the measured CPU window. The fixture admits only that listener's
exact origin to the navigation document and marked Worker entry's connect-src,
plus its isolated context's loopback-network permission; asset bytes and product
policy stay unchanged. Playwright DOM-snapshot recording is off during measurement so
test instrumentation does not repeatedly walk the page. CDP measures absolute
product script, style, layout and native work; `XMATRIX_PERF_TRANSPORT=cdp` keeps
the former per-frame injected delivery available for diagnostic comparisons.
These are controlled browser results, not a claim about every production device.
The fixture has 1,909 Agents in 1,900 distinct Channels because ten Instances
share the open conversation. Catalog paging loads only its first page initially;
the measured first window deliberately includes first-seen live hydration of
the other Channels. Receipt counters witness native delivery, while the final
trace assertion witnesses consumption of the focused Instance's state.
The handshake sends an empty Agent inventory, matching Hub; the first reports
must populate those cards too.

Root search, page-conversation and mobile Channel-layout styles use explicit
shell state classes. They do not inspect descendants with root/body `:has()`;
the retired inline-thread-draft selector is removed. The existing timeline
scroll style-scope regression counts `UpdateLayoutTree.elementCount` to guard
against whole-app restyling when virtual rows mount.

Arrival motion translates a visual layer inside Virtuoso's measured viewport,
holding the header, mounted rows and footer together. The viewport itself stays
in its layout position: with a custom scroll parent, Virtuoso reads its bounding
box on scroll and must not interpret the animation as a new layout offset.
The stable custom Scroller preserves the library's viewport component and ref;
its child composition follows the pinned Virtuoso version. The painted-frame
arrival owner checks both the row motion and the invariant viewport offset,
including the integration boundary when that dependency changes.

Channel visibility changes still publish authorized Space catalog revision
watermarks, including grants to newly visible private Channels; presence
snapshots are not the discovery announcement. Revision delivery remains best
effort. Reconnect, foreground refresh and a newer revision observed on a page
read repair a missed watermark through the existing catalog path.

The rail ECG uses its original path as a static mask while a transparent break
crosses it on a transformed layer at the original two-second cadence. Composer
summon glints also move a clipped gradient layer instead of repainting a CSS
background position. Header/search clearance watches header geometry and header
mounts; ordinary message and rotating-hint nodes do not trigger no-op padding
writes.

The empty composer retains one empty mention-span projection across presence
updates. Its textarea mirror does not recopy font metrics or recreate its resize
observer when Channel activity changes without changing the painted draft. The
rotating hint crossfades a fixed blurred texture into sharp text, keeping the
original rise and fade without animated filter bounds.

Work-intent illumination uses a feathered moving window over fixed ink. Timer
rings and the shared animated-icon helper animate their HTML container while
the enclosed SVG stays static. This preserves the original glyph, dimensions,
rotation, elapsed arc and motion preferences without animated SVG roots forcing
full paint-artifact updates on unrelated main-thread frames. Handoff comets
move a clipped HTML plane over their static track; the arrowhead animates its
HTML container at the original cadence.

Animation visibility follows clipping in production. The work dock observes
its horizontal strip once per roster; fully clipped islands pause their
animations and any positive-area intersection resumes them. Icon
animation surfaces share a viewport observer, and inert mobile panels pause
their descendants. This keeps invisible targets without compositor layers
from forcing full paint-artifact updates during unrelated visible work. No
content is hidden or paint-contained to achieve this, so hover cards and
shadows retain their existing overflow.

Avatar status dots and waking faces are static. Live presence still updates
colour, solid or hollow fill, greying and rest marks, without an opacity clock
or visibility subscription for each avatar.

Elapsed timer rings use component-owned Web Animations rather than CSS
iteration events. Their 1.6-second rotation retains the same geometry and
easing. The shared visibility observer pauses each actual target without
losing phase; the component that makes a mobile pane inert also suspends its
clocks. Changing reduced motion cancels these effects and restores the static
twelve-o'clock arc; reenabling motion starts a new effect. Unmount cancels the
effect and releases the shared observer and motion-preference subscription.
Browsers without Web Animations display the same static decoration. These
clocks schedule no JavaScript frames and do not modify native event registration.

Empty/plain drafts also skip the mention display registry until an address is
present. Textarea transitions cover field chrome explicitly: switching between
native and soft carets does not animate the unsupported caret-color property.

The client production build adds class buckets to a conservative subset of
final CSS selectors after minification. A subject consisting of a multi-class
`:is()` or `:where()` gains one alternative per class, each retaining the whole
original condition and adding a zero-specificity `:where(.class)` guard. This
helps the browser index the rule without changing matching, specificity or
cascade order. Complex arguments, escaped names, nested style rules and unknown
pseudo-elements stay unchanged; expansion is bounded per rule. The transform
runs before source-map emission and real content hashing, so deployed filenames
and manifest references cover the resulting bytes. Browser cascade checks and
a real compiler owner protect this boundary when the CSS toolchain changes.
