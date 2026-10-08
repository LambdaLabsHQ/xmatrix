# Platform Admin

Operators can inspect and manage deployment-wide product state directly inside
the xMatrix app, without opening a database console.

## What it shows

`Platform admin` is an app view (`/app/<space>/admin`, plus a rail entry and a
"Platform" group in **More**) with four sections. Every list is the same
`AdminTable`: search, sortable headers, 50-row pages, CSV export, and its
search/sort/page state in the address (`?item=<section>&<id>q=…&<id>sort=…`).

On phones, the section list opens each section as a screen with a way back.
Table rows become labelled list rows; sorting uses an inline selector and a
direction button. Search, 50-row pagination, CSV export, and user-detail links
retain the same address state as desktop. Storage bars and user detail fit
narrow screens without horizontal scrolling.

- **Overview**: platform totals (users, Spaces, active/archived Channels,
  messages, Agents, running Runs, Machines, Automations, storage), registered
  user access (active 24h/7d/30d, verified, profiles completed), messages per
  day for a 7/14/30/90-day window, and storage by category.
- **Users**: every registered user with sign-in methods, registration, last
  access, sessions, Spaces, Agents, Machines, and messages. Opening a user
  (`&user=<id>`) reads `GET /api/admin/users/:userId`: account facts, usage
  (messages 7d/30d, Runs by status, Spaces owned, pages created), their own
  messages per day for 30 days, and tables of their Spaces (role, members,
  their messages, plan and billing status), Agent registrations, Machines
  (status and timestamps), connectors they added (provider and status), and
  sessions (signed in, last active, expires).
- **Spaces**: name, owner, members, Channels, Agents, messages, 7-day messages,
  created, last activity.
- **Audit**: `GET /api/admin/audit`, every operator read and action, newest first.

## What it deliberately does not show

Operators see metadata only: identities, roles, counts, statuses, and
timestamps. No message or page text, Channel name or topic, page title, secret
value, attachment, prompt, connector payload or error text, `metadata_json`,
Agent configuration, Machine host name, or session IP address and user agent
crosses this path. Each query names its columns, and
`packages/hub/test/postgres-admin-user-detail.test.mjs` fails if an admin query
names a content column; the Hub e2e suite asserts message text and Channel
names never appear in a response. Holding operator authority is therefore never
the same thing as holding a content-read authority over other people's work.

## Audit trail

Every admin read and action writes a row to `control.admin_audit_events`
(actor, action, target kind and id, time) on the directory shard **before** its
result is returned; a request whose row cannot be written is refused. Reading
the trail is itself recorded. Actions: `overview.read`, `user.read`,
`audit.read`, `handles.backfill`, `agent-senders.repair`.

## Authority

Two grants, OR'd. Both are anchored in deployment configuration; neither can be
created by a Space electing itself.

1. **Admin Space** — `PLATFORM_ADMIN_SPACE_ID` names one Space whose **members**
   are platform admins (any role: owner, admin, member, or viewer). The Space id
   is deployment-owned; membership is then maintained in-product, so adding an
   operator is an invite rather than a deploy.
2. **Allowlist** — `PLATFORM_ADMIN_EMAILS` (comma/space/semicolon separated
   operator emails) is the bootstrap and break-glass grant. It is needed before
   the admin Space exists and if that Space is ever deleted or emptied.

Both empty means nobody has the admin surface.

> **Consequence of the admin Space, stated so it is never a surprise:** anyone
> who can invite into it can mint platform admins, and invite links are
> self-serve. Keep that Space closed and owned by the operator who should
> control the platform-wide read. This is the deliberate trade for not needing a
> deploy per operator change.

Membership is resolved with the ordinary Space read authority — Relay authority
answers 404 for a non-member — so this adds no second authorization rule, and
any non-success (including a Core failure) fails closed.

- `GET /api/admin/overview`, `GET /api/admin/users/:userId`, and
  `GET /api/admin/audit` re-check authority on every request and answer
  `403 platform_admin_required` otherwise.
- `GET /api/auth/me` reports `capabilities.platformAdmin`. Clients use it only to
  decide whether to offer the view; forcing it on client-side still yields a 403.
- Agent-run principals are never platform admins, even when their owner is. A
  delegated agent token carries Channel authority, not operator authority.
- Relay authority fails closed unless the Worker explicitly vouches
  (`platformAdmin: true` on the `admin-platform-overview` query). Core has no
  user directory and cannot derive the decision itself, so the Worker is the
  single authority and the Core check is defense in depth.

### Setting it up

1. Create the admin Space in the app (closed/private, owned by the operator who
   should control the platform read).
2. Put its id in `PLATFORM_ADMIN_SPACE_ID` under `hub.vars` in the deployment profile (`deploy/profiles/production.json`)
   `[vars]` and deploy the Hub. Bootstrapping needs one entry in
   `PLATFORM_ADMIN_EMAILS` first, since the Space cannot be created by an
   account that has no way in.
3. From then on, add or remove an operator by inviting them to — or removing
   them from — that Space. No deploy.

Keep at least one `PLATFORM_ADMIN_EMAILS` entry as break-glass: if the admin
Space is deleted, membership grants nothing and the allowlist is the only way
back in.

## Cost and bounds

The PostgreSQL overview executes one metadata-only SQL statement per physical
shard; shards are read concurrently. A materialized CTE reads the live message
metadata (`space_id`, `author_id`, `author_kind`, `created_at`) once and shares
it between totals, per-Space, per-user, and daily aggregates. It does not read
message content. This avoids four base-table scans and six serial SQL round
trips on the directory shard (five on other shards). All aggregates in a shard
also share one statement snapshot.

After operator authorization and the required audit write, the auth directory
inventory and physical-shard aggregates run concurrently. Each read still
checks current authority, records its audit row, and returns `private,
no-store`; no server response cache substitutes for either check. The Web's
existing 60-second query cache is scoped to account and Hub. Changing the
activity range retains that account's current result while the next request
loads; a forbidden response hides it.

Space rows are capped at 200 and user rows at 10,000; activity windows are at
most 90 days. The response reports `truncated` when a table is cut off. Nested
JSON inventories retain explicit overflow checks as well as SQL limits.

Activity windows are exact UTC calendar days, including the current UTC day.
Each PostgreSQL aggregate uses the same inclusive start and exclusive end as
the returned dense series, so an `N`-day request can produce at most `N` rows.
Hard inventory bounds prove overflow without rejecting an exact-bound result.
Queries below the database driver's 10,000-row ceiling use one extra sentinel
row; queries at that ceiling carry `COUNT(*) OVER ()` alongside their bounded
rows, so the total still proves whether more rows exist.

Machine totals are read only on the directory shard. Registered-user identities
and access summaries come from the current auth authority. A missing or
mid-migration auth directory degrades to product user ids and bounded email
lookups rather than failing the entire read.

## Related code

- Contract: `packages/protocol/src/admin-overview.ts`,
  `packages/protocol/src/auth-capabilities.ts`
- Authority: `packages/hub/src/admin-platform-access.ts`
- Route: `packages/hub/src/index-routes-admin.ts`
- Aggregate: `packages/hub/src/postgres-admin-overview.ts`
- User detail: `packages/hub/src/postgres-admin-user-detail.ts`,
  `authDirectoryAdminUser` in `packages/hub/src/auth-authority.ts`
- Audit: `packages/hub/src/admin-audit.ts`,
  `packages/db/migrations/0166_expand_admin_audit_events.sql`
- App views: `apps/web/src/components/dashboard/workspace-platform-admin-tabs.tsx`
  and the `platform-admin-*` and `admin-table` modules beside it
- Tests: `packages/hub/test/platform-admin-overview.e2e.mjs`,
  `packages/hub/test/postgres-admin-user-detail.test.mjs`,
  `apps/web/e2e/platform-admin.spec.ts`,
  `packages/hub/test/admin-platform-access.test.mjs`,
  `apps/web/src/components/dashboard/platform-admin-overview.test.cjs`
