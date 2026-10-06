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
