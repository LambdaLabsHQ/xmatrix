# Web server state with TanStack Query

Status: implemented on the `codex/next-tanstack-query` integration branch for
the Next rollout. Public HTTP contracts and Local Replica authority do not
change.

## Boundary

TanStack Query owns HTTP server-state request lifetime, request coalescing,
retry, cancellation, polling, and mutation state. It does not own:

- Auth session or token refresh;
- Local Replica, OPFS, Product Tail Cache, or projection barriers;
- WebSocket reconnect, presence, or realtime assembly;
- attachment streaming and object URL lifetime;
- ordered write-behind, read-sync coordination, drafts, or navigation state.

The provider lives inside `AuthProvider`. Query keys begin with Hub origin and
Human user ID and then add the domain scope. JWTs never appear in keys. A token
rotation for the same Human preserves memory cache; logout or a different Human
clears it. No Query cache is persisted and there is no SSR prefetch.

The shared transport returns `XMatrixApiError`. Queries retry at most twice and
only for network failures, 408, 429, or a 5xx response explicitly marked
`retryable` (the Hub side of that contract is
[hub-error-contract.md](hub-error-contract.md)). Mutations do not retry by default. Window focus does not refetch,
reconnect does, and unused data is collected after ten minutes. Each polling
domain supplies its own visible/terminal-state interval.

## Channel and history behavior

Every Tree parent and every Flat, Archive, Direct, Search, Unread, or Mentions
scope has an independent infinite-query key. Only the selected root view is
enabled on cold start. Continuations use the existing opaque cursor. Exact
resolve is bounded and seeds authorized ancestor paths into the corresponding
Tree caches; it never treats an unloaded Channel as absent.

The Channel entity map remains a domain/realtime adapter, not a second request
cache. Page state is read from Query. Presence changes merge entities without
invalidating pages; structural and message events invalidate only affected
Channel scopes. A 404 or 426 may use the legacy complete-catalog compatibility
path, while 5xx remains an error.

Online history fetches are coalesced by Channel, Local Replica authority epoch,
known head, and requested bounds. The fetched result still passes through the
existing coverage and projection-barrier checks before Local Replica becomes
the display authority. Query cache cannot bypass those checks.

## Other UI domains

Workspace spaces/projects/events, Automations, Agent profiles, readiness,
Console status, Space invites, Human Profile writes, Billing, platform admin,
prompt revisions, Roles, Apps/connections/executions, Secrets,
join requests, connector completion, Agent launch workspaces, Focus, and Trace
HTTP reads now enter Query with their user and business scope. Mutations enter
Query's mutation cache and update or invalidate only their owning domain.

The always-visible Team badge does not fan out join-request list reads. An
admin-visible pending count is hydrated into each Space snapshot on the same
physical-shard transaction used to list Spaces. Full request rows are queried
only while Team is open, with duplicate Space identities removed and empty
queues retained in the Query fresh window.

Large existing shell event handlers use `useXMatrixQueryFetch` while their
response parsers are incrementally split into typed domain modules. GET/HEAD
requests are same-key coalesced, receive Query cancellation, and expose 408,
429, and explicitly retryable 5xx responses to the bounded Query retry policy;
command methods are no-retry mutations. After retries are exhausted the bridge
returns the final raw response, preserving existing error parsers. It clones
cached Responses so consumers never share a body stream. It is an integration
boundary, not another cache.

Resolve seeding updates the page that already owns a Channel and preserves all
loaded continuation pages and cursors. Realtime messages invalidate only
catalog queries that already contain that Channel; structural events retain
the broader Space-scoped invalidation. This prevents one busy Channel from
refetching every expanded Tree branch.

ESLint rejects the browser `fetch` global in React pages, components, and
hooks. The reviewed exceptions are transport/protocol code for login/Auth,
attachments, ordered message send, and the legacy API-fetcher module. Adding
ordinary UI server state to that list is not an
acceptable workaround.

## Rollout and rollback

Land this change through an exact-SHA Next release and compare request counts,
pool checkout latency, Catalog latency, and history latency before selecting it
for Main. The exact-SHA workflow converges the authoritative fresh pools to 20
origin connections per physical shard and keeps the stale-safe cached pool at
five. These are shared Hyperdrive soft limits, not per-Worker pools; changing
them requires the same capacity readback and live concurrency gate.

Rollback is an application exact-SHA revert. There is no schema migration and
no server-state persistence to remove. PostgreSQL remains compatible with the
older consumer, the legacy complete Catalog endpoint remains present, and Local
Replica data is unchanged. If only the broad UI conversion regresses, revert
its separate commit while retaining the request-session and Channel hot-path
commit.
