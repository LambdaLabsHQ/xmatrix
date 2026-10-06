# PostgreSQL Channel Capability Policy

Status: authoritative for PostgreSQL authorities that admit user or Agent work
against a Channel.

## North star

Channel existence, principal access, lifecycle, and the requested operation are
separate facts. Every PostgreSQL authority asks the shared policy for a named
business capability. Authorities must not maintain private copies of Channel
ACL or archive semantics.

The registry and its SQL builders live in
`packages/db/src/channel-capability-policy.ts`. They are internal to
`@xmatrix/db`; API responses receive business data, not `archived_at` or a
storage-shaped authorization row.

Archiving has one product meaning:

- existing content, status, and history remain readable by a principal who
  still has access;
- new work is frozen;
- terminalization, cancellation, cleanup, and bounded repair of existing work
  remain possible;
- deletion remains absence and does not create a readable tombstone.

## Shared access contract

The policy evaluates current PostgreSQL membership and Channel ACL facts.

- A Human must be a current Space member and satisfy the capability's role
  floor.
- An Agent must be a registered Instance of a current registration in the Space.
- A non-direct open Channel inherits Space membership.
- A closed Channel requires an explicit Channel grant. A Space owner/admin may
  access a non-direct closed Channel.
- A direct Channel always requires an explicit Channel grant, regardless of
  its stored mode. Space administration never grants implicit direct access.

Missing and unauthorized Channels return `404 channel_not_found`, masking
existence. Once access is established, an active-only capability against an
archived Channel returns `409 channel_archived`. Callers must not re-query or
reinterpret lifecycle to change those results.

The grant contains an internal `active` or `archived` state so fused SQL can
distinguish those errors. That state is not part of a product or package API.

## Capability matrix

`none`, `share`, and `update` below are PostgreSQL locks on the Channel row.

| Authority | Named capabilities | Archived behavior | Lock |
| --- | --- | --- | --- |
| Message | `message_content_read`, `message_viewer_state_update` | allow | none |
| Message | `message_active_command_preflight` | reject | none |
| Message | `message_active_command` | reject | share |
| Message | `message_maintenance_repair` | allow | share |
| Runtime | `runtime_history_read` | allow | none |
| Runtime | `runtime_new_work` | reject | update |
| Runtime | `runtime_terminalize` | allow | share |
| Runtime | `runtime_check` | allow | none |
| Secret Broker | `secret_pending_read` | allow | none |
| Secret Broker | `secret_run_read` | allow | none |
| Secret Broker | `secret_new_work` | reject | share |
| Secret Broker | `secret_terminalize` | allow | share |
| App | `app_history_read` | allow | none |
| App | `app_new_work` | reject | share |
| App | `app_terminalize` | allow | share |
| Scheduler | `scheduler_history_read`, `automation_history_read` | allow | none |
| Scheduler | `scheduler_new_work`, `automation_new_work` | reject | share |
| Scheduler | `scheduler_terminalize`, `automation_terminalize` | allow | share |
| Trace | `trace_history_read` | allow | none |
| Trace | `trace_new_grant` | reject | share |
| Content | `content_history_read` | allow | none |
| Content | `content_new_work` | reject | share |
| Content | `content_terminalize` | allow | share |
| Machine Control | `machine_new_work` | reject | share |
| Catalog | `catalog_read` | allow | none |
| Space transfer | `space_transfer_propose` | reject | share |
| Focus | `focus_history_read` | allow | none |
| Focus | `focus_publish` | reject | share |
| Preferences | `preference_update` | reject | share |

The Human role floor is part of each registry entry. Read/history capabilities
generally allow every member. Commands that create runtime or scheduled work
require a non-viewer. Content references preserve the Content authority's
existing all-member contract; changing that product permission is separate
from lifecycle unification.

## Operation rules

Exact idempotency replay is evaluated before current lifecycle admission when
the authority already has an authoritative receipt. Archiving must not turn a
committed retry into a failure. A new request that happens to reference an old
receipt or resource is not an exact replay and receives the current policy.

History capabilities include archived rows in batch predicates. Active-only
batch predicates include lifecycle in the shared SQL. Single-Channel gates and
fused CTEs first authorize without filtering lifecycle so they can return the
correct 404 or 409.

Writes take the registry's lifecycle lock before their first domain fact
write. A shared lock lets concurrent writers proceed while making Channel
archive/delete wait for admitted transactions. Runtime creation uses an update
lock where its command closure already requires serialization. Authorities
must not add a later `archived_at IS NULL` check as a second admission system.

Every changed SQL text receives a new versioned prepared-query name. This is
required for rolling deployments because an older pooled PostgreSQL connection
may retain a statement with the previous text.

## Deliberate non-gates

Some SQL still mentions `archived_at IS NULL`, but it does not decide whether a
caller may access one Channel:

- dispatch and alarm queries select active candidates for new work;
- Channel creation/configuration selects active parents and prevents duplicate
  active Threads;
- active work pickers and feedback routing intentionally omit archived
  candidates;
- Channel transfer and Space Control own the Channel lifecycle transaction and
  validate the active tree they mutate.

Those selectors must have a named query and a comment describing the business
set. Adding principal ACL SQL to one of them requires moving that decision into
the shared policy instead.

Authenticated Machine lifecycle reports are another explicit boundary. They
terminalize or reconcile an existing Run using the original Machine, host,
Run, execution-key, epoch, and lease evidence. They do not re-evaluate mutable
Human/Agent Channel ACL, and archive must not strand final process evidence.
The same principle applies to exact, fixed recovery routines and helpers whose
caller has already authorized the Channel in the same transaction.

## Adding or changing an authority

1. Name the business capability in `CHANNEL_CAPABILITY_POLICIES`; do not add a
   generic read/write flag.
2. Choose principals, Human role floor, archived behavior, and lifecycle lock.
3. Use `requireChannelCapability`, `channelCapabilityPredicate`, or
   `channelCapabilityCte`. Do not copy their SQL.
4. Put exact replay before lifecycle rejection when a committed receipt makes
   replay safe.
5. Return domain data only. Do not expose lifecycle columns merely to let an
   HTTP handler decide authorization.
6. Bump every prepared-query name whose SQL text changes.
7. Cover active, archived, missing, unauthorized, direct, closed, replay, and
   lock behavior appropriate to that authority.
8. Add any unavoidable raw active selector to the adoption test with its
   business-set rationale.

## Verification and maintenance

`packages/db/test/channel-capability-adoption.test.mjs` prevents restored
private helpers, legacy query names, and active gates in authenticated terminal
authorities. `packages/db/test/channel-capability-policy.test.mjs` covers the
registry, ACL, lifecycle, error, and lock contract. Authority suites cover the
operation-specific mappings and replay order.

The PostgreSQL integration tests in
`packages/db/test/message-channel-capability-postgres.test.mjs` validate the
archive/write lock race when `XMATRIX_TEST_POSTGRES_URL` is available. The
production acceptance shape is an authorized archived Channel whose history,
existing App/Scheduler state, and terminal operations still work while append,
new launches, new schedules, new App dispatch, and other new work return
`channel_archived`.
