# Platform Admin

Operators can inspect and manage deployment-wide product state directly inside
the xMatrix app, without opening a database console.

## What it shows

`Platform admin` is an app view (`/app/<space>/admin`, plus a rail entry and a
"Platform" group in **More**) with these sections. Every list is the same
`AdminTable`: search, sortable headers, 50-row pages, CSV export, and its
search/sort/page state in the address (`?item=<section>&<id>q=…&<id>sort=…`).

On phones, the section list opens each section as a screen with a way back.
Table rows become labelled list rows; sorting uses an inline selector and a
direction button. Search, 50-row pagination, CSV export, and user-detail links
retain the same address state as desktop. Storage bars and user detail fit
narrow screens without horizontal scrolling.

- **Overview**: one read of a year of UTC days, sliced locally into 7, 30 and
  90 days or all time (`&range=`), so changing the range asks the Hub nothing.
  It shows, for the range and against the range before it: people active,
  average daily active, stickiness (average daily ÷ 30-day active), new
  accounts, messages people wrote, all messages, active Spaces and Runs
  started; daily, 7-day and 30-day active people; new and total registered
  accounts; the activation of accounts registered in the range (Space,
  Machine, Agent, a message of their own, active in the last 7 days); weekly
  retention by registration week; messages per day by people, Agents and apps;
  a sortable daily table with CSV; and the platform totals. Storage appears
  only where the deployment measures it.

  A person is **active** on a UTC day they send a message of their own: text a
  member of the Space typed (`xmatrix.message.text`, not a `system:` or
  `scheduled-message:` id), the same definition as the new-user funnel.
  Agents' messages, onboarding notices, scheduled posts and imports do not
  count. Session refreshes (the CLI and apps included) are shown beside it as
  "signed in", never as activity.
- **Users**: every registered user with sign-in methods, registration, last
  access, sessions, active days in the last 30, Spaces, Agents, Machines, and
  messages. Opening a user
  (`&user=<id>`) reads `GET /api/admin/users/:userId`: account facts, usage
  (messages 7d/30d, Runs by status, Spaces owned, pages created), their own
  messages per day for 30 days, and tables of their Spaces (role, members,
  their messages, plan and billing status), Agent registrations, Machines
  (status and timestamps), connectors they added (provider, status and activity), and
  sessions (signed in, last active, expires).
- **Spaces**: name, owner, members, Channels, Agents, messages, 7-day messages,
  created, last activity.
- **Operations**: Machines and their runtimes, Runs, and Automations. It
  reports no event-delivery backlog: `data.outbox` keeps publication envelopes
  that no consumer delivers (see `postgres-lifecycle-retention.md`), so its
  pending rows are not a queue, and counting them meant scanning the table.
- **Audit**: `GET /api/admin/audit`, every operator read and action, newest first.

### Connector activity in user details

The connector table attributes a connection to its stored `created_by` user.
Connections are Space resources: the activity includes every caller in that
Space, including Agents and other members, rather than claiming the adding user
made every request. Disconnected connections remain visible with their status.

Each connection shows retained execution totals and the last rolling 30 days,
total counts for queued/completed/failed/blocked/planned, and the latest request
time. These are connector execution records, not provider HTTP requests: blocked
and planned work may never call the provider, and a single execution may make
several HTTP calls. Counts require the exact connection, Space and provider.

Event counts are retained, non-deleted standard event posts in `data.messages`
(`author_kind = app`, exact provider and Space, canonical `app:<provider>:`
message ID prefix). This covers GitHub and the shared connector event dispatcher,
including webhook events. Action receipts use a separate ID prefix and are
excluded. Each destination Channel counts once; retries under the same message
ID do not add a row. Events with no Channel post, native paths with other ID
formats, removed history and raw incoming HTTP attempts cannot be inferred from
these counts. They must not be presented as the number of webhook requests
received. Both retained total and rolling 30-day deliveries and the latest event
time are shown, alongside canonical subscription and distinct subscribed-Channel
counts. These are current stored subscriptions, not inferred active routes.

Queries aggregate only metadata for the bounded connection list on each physical
shard, under the existing user-read authorization, audit and database deadlines.
No new writer, counter authority, backfill or migration is introduced. `usage`
is an additive optional field: a newer Web with an older Hub shows unavailable
counts as a dash, while the newer Hub returns real zeroes for an idle connection.
CSV exports include exact numeric totals, 30-day counts and each execution status.

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
result is returned; a request whose row cannot be written is refused. Once
authority is proven, a read writes its row while it reads, and answers only
after the row is written; an action writes its row before it acts. Reading the
trail is itself recorded, before the trail is listed. Actions: `overview.read`, `user.read`,
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

Message activity is read from settled days. `data.admin_activity_days` holds,
per Space, UTC send day, author kind and the person a message counts for (the
author for people, the send-time owner for Agents, nobody for apps), the number
of retained messages, how many were the person's own, and the latest send
time. The scheduled tick settles each shard once a day, at minute 41 of the
hour: a day settles two days after it began (`settled_through` is the day
before yesterday), from the messages present then, in one transaction that
replaces that day's rows. A shard's first roll-up reads its whole history once;
until then the overview reads every message, as before.

The overview reads each shard's `settled_through` first, then one statement:
settled rows plus the retained messages sent after them, through the
`sent_at` index. The statement re-reads the boundary in its own snapshot and
uses the later of the two, so a roll-up that commits in between never counts a
day twice. The cost follows days and people, not messages: on production the
whole history settles into about 1,100 rows. What a settled day does not
change: a message that reaches xMatrix more than a day after it was sent, or
is deleted after its day settled. Deleting a Space purges its days; a Space
move carries them with its messages.

Shards are read concurrently. Daily, 7-day and 30-day active people are counted
across shards from each person's active days, so a person in Spaces on two
shards counts once; new accounts per day come from the registered-user
inventory and are left out when that inventory was cut off. A user's detail
reads its message counts and 30-day series the same way.

After operator authorization the audit write, the auth directory inventory
and the physical-shard aggregates run concurrently. Each read still checks
current authority, records its audit row, and returns `private, no-store`; no
server response cache substitutes for either check. The Web's 60-second query
cache is scoped to account and Hub, and Overview, Users and Spaces share one
read.

Space rows are capped at 200 and user rows at 10,000; activity windows are at
most 365 days. The response reports `truncated` when a table is cut off. Nested
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
- Aggregate: `packages/hub/src/postgres-admin-overview.ts`; settled days:
  `packages/hub/src/postgres-admin-activity-rollup.ts`,
  `packages/db/migrations/0223_expand_admin_activity_rollup.sql`
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
  `apps/web/src/components/dashboard/platform-admin-overview.test.cjs`,
  `apps/web/src/components/dashboard/platform-admin-analytics.test.cjs`
