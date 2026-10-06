# Platform Admin

Operators can inspect and manage deployment-wide product state directly inside
the xMatrix app, without opening a database console.

## What it shows

`Platform admin` is an app view (`/app/<space>/admin`, plus a rail entry and a
"Platform" group in **More**). Its **Overview** tab renders one Hub read:

- **Totals**: users, Spaces by kind, active/archived Channels, messages (total,
  24h, 7d, human vs agent), Agent registrations, runs, live instances, enrolled and
  online Machines, Automations, stored logical bytes, archived bytes.
- **Messages per day** for a selectable 7/14/30/90 day window.
- **Spaces table**: name, kind, owner, members, active Channels, Agent registrations,
  total and 7-day messages, last activity. Searchable and sortable.
- **Users table**: identity, Space count, owned Spaces, Agent registrations, Machines,
  authored messages, last message.
- **Storage by category** aggregated from each scoped authority's `storage_usage` accounting.

## What it deliberately does not show

The aggregate carries counts, identities, and timestamps only. No message body,
payload ref, attachment, annotation, Channel name, or Channel topic crosses this
path, so holding operator authority is never the same thing as holding a
content-read authority over other people's Channels. The Hub e2e suite asserts
this.

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

- `GET /api/admin/overview` re-checks authority on every request and answers
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

`message_heads` has no `created_at` index, so the message aggregates are table
scans: one pass each for totals, per-day, per-Space, and per-user. This is an
on-demand operator read and never sits on a product request path. Space and user
tables are bounded by `spaceLimit`/`userLimit` (default 50, max 200) and the
activity window by `activityDays` (default 14, max 90); the response reports
`truncated` when a table was cut off.

Activity windows are exact UTC calendar days, including the current UTC day.
Each PostgreSQL aggregate uses the same inclusive start and exclusive end as
the returned dense series, so an `N`-day request can produce at most `N` rows.
Hard inventory bounds prove overflow without rejecting an exact-bound result.
Queries below the database driver's 10,000-row ceiling use one extra sentinel
row; queries at that ceiling carry `COUNT(*) OVER ()` alongside their bounded
rows, so the total still proves whether more rows exist.

Post-retirement message metrics fan out from each Space authority to its
authoritative Channel families. That scan is bounded to 1,000 Channels per
Space so the operator read cannot exhaust the Cloudflare-service subrequest
budget. A larger Space still returns the overview, with
`truncated.messageMetrics=true`; message totals, activity, and per-Space/user
message counts are then partial, while all non-message totals remain complete.
The Web view displays that distinction instead of presenting partial message
counts as exact or failing the entire admin surface.

Owner and member emails come from the Machine Daemon enrollment record when one
exists, otherwise from the auth database (`AUTH_DB`), capped at 200 lookups per
read. A missing or mid-migration directory degrades to bare user ids instead of
failing the read.

## Related code

- Contract: `packages/protocol/src/admin-overview.ts`,
  `packages/protocol/src/auth-capabilities.ts`
- Authority: `packages/hub/src/admin-platform-access.ts`
- Route: `packages/hub/src/index-routes-admin.ts`
- Aggregate: `packages/hub/src/postgres-admin-overview.ts`
- App view: `apps/web/src/components/dashboard/workspace-platform-admin-view.tsx`
- Tests: `packages/hub/test/platform-admin-overview.e2e.mjs`,
  `packages/hub/test/admin-platform-access.test.mjs`,
  `apps/web/src/components/dashboard/platform-admin-overview.test.cjs`
