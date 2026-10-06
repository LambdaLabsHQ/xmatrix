# PostgreSQL Channel catalog pagination

Status: implemented for the Next integration environment. Main, Test, and Prod
retain the complete catalog API and their current authority selectors until a
separate exact-SHA rollout selects this implementation.

## Contract

The Web catalog reads `GET /api/channels/page` through
`GET /api/xmatrix/channels/page`. Every response contains at most 50 rows and
binds its opaque continuation cursor to the authenticated query tuple:

```text
(spaceId, view, filter, scopeChannelId, normalized query, sort position)
```

The cursor is a continuation hint only. Hub authenticates the Human again and
PostgreSQL re-evaluates current Space membership and Channel ACLs on every page.
Changing any query component invalidates the cursor. The supported views are:

- `tree`: direct children of `scopeChannelId`, or Space roots when omitted;
- `flat`: every descendant below the scope, or the whole Space when omitted;
- `archive`: archived Channels;
- `search`: authorized Channel names, with message-body search remaining in the
  Local Replica.

`all` and `unread` filters execute in PostgreSQL. Unread includes channels with
unread messages or outstanding attention. A filtered Tree
retains an authorized ancestor when an authorized descendant matches, allowing
the client to reveal the path without loading the whole catalog. Each row has
`ownActivityAt` and `hasChildren`. Tree rows additionally expose
`subtreeActivityAt`, the maximum own activity through active,
authorized descendants. Tree branches rank by that value even before the
client expands them. Traversal stops at inaccessible or archived nodes;
hidden activity cannot affect a visible ancestor's rank. `ownActivityAt`
retains its Channel-only meaning for Flat and other views.

`POST /api/channels/resolve` and its Web proxy accept at most 200 unique Channel
IDs. They omit unauthorized or nonexistent IDs and may return authorized
root-to-target paths. This is the only hydration path used for direct links,
Focus rows, server Channel-search results, and realtime events for an unloaded
Channel.

## PostgreSQL query boundary

`PostgresChannelCatalogRepository` resolves the Space placement through the
directory database, rejects `moving`, `blocked`, or target-bearing placements,
and then executes authorization and catalog aggregation on the selected
physical shard. A request-local database session owns one `max=1` Pool per
physical Hyperdrive binding. Directory/default-shard work shares one checkout;
another physical shard gets a separate checkout. Sessions are never retained
between Worker requests and are closed in `finally` paths. Concurrent work that
targets the same physical shard is queued on that one session instead of being
converted into a deterministic `503`.

The page path is deliberately split. It first materializes only the authorized
Channel facts needed for filtering and keyset order, selects at most 51 IDs,
and only then enriches those IDs with latest-message, attention-detail, visible
Human, and child-presence facts. The first-page HTTP request omits counts; after
that page paints, a separate query runs the independent low-cost aggregate with
indexed existence checks. Counts therefore neither delay the first page nor
force its enrichment CTE to materialize every visible Channel. The query
boundary covers:

- Space membership and Channel ACL visibility;
- recursive hierarchy selection;
- archive classification;
- minimal per-Human read/attention predicates during selection;
- latest committed non-deleted message and attention detail only after selection;
- personal Pin order; and
- bounded exact ancestor resolution.

Pins precede unpinned rows in their saved order. Other rows use keyset ordering
by `subtreeActivityAt DESC, channel_id` for Tree and
`ownActivityAt DESC, channel_id` for other views. Tree aggregation occurs before
the 51-ID selection, not after paging. The scoped recursive walk visits only
eligible branches and deduplicates cycles. Search adds exact/prefix/substring
groups before its own-activity order. No cursor field participates in authorization.

The subtree row field is additive under catalog protocol version 1. New Tree
cursors carry a separate `subtreeActivityAt` position; pre-fix Tree cursors are
rejected rather than silently interpreted using a different order. Refreshing
the first page obtains a current cursor. Non-Tree cursors are unchanged. New
clients tolerate older rows without the field and use loaded descendant
activity until the coordinated Hub rollout supplies authoritative subtree times.

Migration `0033_expand_channel_catalog_paging` adds nullable
`data.channels.activity_at` and Space/parent/archive/DM activity indexes. New
Channel creation, configuration, movement, archive/resume, and message append
write the field. Message edits and reactions deliberately do not. Contract
migration `0162_contract_backfill_channel_activity` gave every Channel written
before the column existed the later of its update time and latest non-deleted
message time. Reads therefore take `activity_at` as stored (falling back only to
`updated_at`) and never scan a Channel's messages to rank it.
Migration `0034_expand_direct_channel_identity` added active-thread root
uniqueness (its direct-conversation index was dropped by
`0138_contract_purge_direct_conversations`, when direct messages were retired);
create uses `ON CONFLICT DO NOTHING` and resolves the winning Channel. PostgreSQL
Thread creation writes the deterministic root copy and attachment references in
the same transaction as the new Channel.

## Web state model

The Web keeps a Channel entity table plus page indexes keyed by
`(Space, view, filter, scope, query)`. Tree expansion fetches only one child
level; every level owns a continuation sentinel. Flat, Archive, Direct,
Unread, Mentions, and Channel search use the same continuation model. Desktop
and mobile render from the same store and deduplicate by Channel ID.

A failed first page remains an error with Retry. Only a successful empty first
page renders an empty state. A failed child page retains its disclosure control
and renders Retry beside the parent on desktop and mobile; it is not marked as
a successful empty page and automatic effects do not retry it in a loop. Exact
resolution is a partial overlay: it may prove that a path node has children but
cannot downgrade an existing `hasChildren` fact or replace authoritative
activity metadata. A page response also preserves exact-resolution rows that
arrived after that page request began, preventing direct-link hydration from
being lost to an in-flight first page.

Every successful page carries the current per-Space `catalogRevision`. Web
maintains a monotonic watermark per Space across all loaded page indexes. A
newer page or `space_channel_catalog_changed` Human WebSocket frame invalidates
only older indexes in that Space, including imperative Flat and collapsed-child
queries that have no active observer. Revision `0` is reserved for the legacy
complete-catalog fallback and never advances or clears a watermark. Duplicate
and out-of-order frames are inert; a page response older than the known
watermark is refetched once. Socket authentication/reconnect invalidates loaded
catalog indexes so a missed best-effort frame cannot leave the browser stale.

The PostgreSQL Channel authority emits the metadata-only frame only after a
catalog-affecting commit. It contains `{spaceId, revision}` and is fanned out
to the exact current Space members; it contains no Channel facts and grants no
visibility. Every recipient re-reads the catalog, where membership and
per-Channel ACL are evaluated again. Cross-Space moves emit distinct source and
target frames with distinct member sets. The revision is the existing shared
Space control head, so an HTTP observation may conservatively cause an extra
read after an unrelated control-plane commit, but unrelated commits do not
produce realtime catalog frames.

Presence-only events update entities and leave page indexes intact. Message
events refresh affected indexes, and an unknown Channel is first resolved
through the exact endpoint. Direct navigation resolves the target and ancestors
before selecting it. Legacy structural socket events remain a compatibility
acceleration for older Hubs; correctness and future catalog mutations depend on
the revision contract rather than enumerating UI actions.

The old `GET /api/channels` contract remains available to CLI, Agent, and older
clients. The new Web calls it only when the page or resolve endpoint explicitly
returns `404` or `426`. A `5xx` remains visible and never triggers a complete
catalog scan.

## Fleet routing and readiness

User preference reads and writes use the same placement-aware PostgreSQL fleet
router as the catalog. Placement is resolved on the directory connection; the
preference transaction then runs on its physical shard and rechecks the local
placement fence. Unknown shards, moving placements, and stale local placement
remain fail closed.

Each isolate keeps the writable placements it has read as routing hints
(`SpacePlacementHints`, shared by every fleet built on the same directory
binding), so a request rarely spends a separate directory round trip on
placement. A hint is never authority: the shard's own fence admits or refuses
it before any of the transaction's work runs. A refused placement forgets its
hint, and the fleet router routes that transaction once more by the
directory's current placement; a Space that is moving, blocked, or gone still
fails closed.

Catalog/Resolve, message history, and preference requests explicitly keep
placement resolution and the placed transaction in one request session. Focus
operations already execute as one placed transaction. Readiness creates one
short session per physical shard. A transaction opens in one round trip: BEGIN,
its transaction-local settings, and the placement fence travel as one
simple-protocol message, with the settings quoted as literals. Observability
emits bounded phase names for pool checkout, that opening (`begin`), commit, and
rollback plus the business query name and the code-defined operation; SQL
values, credentials, and connection identifiers are never recorded.

PostgreSQL readiness probes every configured physical correctness connection in
parallel. A single failed shard still makes readiness return `503`, while
observations retain each shard's latency and error independently.

## Main rollout and rollback

Before selecting this path in Main, run the migration and bounded backfill on
every physical shard, then verify page and exact-resolution reads against a
production clone. The application change is expand-compatible: older code
ignores `activity_at`, and the complete catalog endpoint remains intact.

Rollback is therefore an exact-SHA application revert. Do not drop the column
or indexes and do not reverse the backfill. Re-enable the former Web catalog
consumer and authority selectors only if the older revision requires them.
Because a `5xx` never falls back automatically, an operational rollback cannot
silently turn a PostgreSQL incident into a 1,000-plus-row scan.
