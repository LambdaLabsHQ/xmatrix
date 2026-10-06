"use client";

/**
 * Platform admin view.
 *
 * Operator-facing read of the whole deployment: user Spaces and the counts that
 * describe how the platform is being used. It renders only what the Hub admin
 * route returns — counts, identities, timestamps — and never Channel content.
 * The Hub re-checks the platform-admin allowlist on the request, so this view
 * failing closed on 403 is a UI courtesy, not the security boundary.
 */

import { actionClass } from "@/components/ui/action-tone";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS,
  ADMIN_OVERVIEW_WEB_ROUTE,
  type AdminPlatformOverview,
  type AdminSpaceSummary,
  type AdminUserSummary,
} from "@xmatrix/protocol";
import { Building, Loader2, RefreshCw, Search, Shield, Users } from "lucide-react";
import { ContentSkeleton } from "./content-skeleton";

import { GlassSelect } from "@/components/ui/glass-select";
import { Input } from "@/components/ui/input";
import { noticeClass } from "@/components/ui/status-tone";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest, XMatrixApiError } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { cn } from "@/lib/utils";
import { EmptyToolState } from "./workspace-admin-views";
import {
  adminActivityBars,
  adminUserLabel,
  agentMessageShare,
  filterAdminSpaces,
  filterAdminUsers,
  formatAdminAge,
  formatAdminBytes,
  formatAdminCount,
  platformAdminStatTiles,
  sortAdminSpaces,
  sortAdminUsers,
  type AdminSpaceSortKey,
  type AdminUserSortKey,
} from "./platform-admin-overview";

const ACTIVITY_RANGES = [7, 14, 30, 90] as const;

const SPACE_SORTS: Array<{ key: AdminSpaceSortKey; label: string }> = [
  { key: "recent", label: "Recently active" },
  { key: "messages", label: "Messages" },
  { key: "members", label: "Members" },
  { key: "channels", label: "Channels" },
  { key: "name", label: "Name" },
];

const USER_SORTS: Array<{ key: AdminUserSortKey; label: string }> = [
  { key: "recent", label: "Recently accessed" },
  { key: "registered", label: "Recently registered" },
  { key: "sessions", label: "Sessions" },
  { key: "messages", label: "Messages" },
  { key: "spaces", label: "Spaces" },
  { key: "name", label: "Name" },
];

/* Both sort orders are fixed lists, so the picker options are derived once
   here rather than rebuilt on every render. */
const SPACE_SORT_OPTIONS = SPACE_SORTS.map((option) => ({ value: option.key, label: option.label }));
const USER_SORT_OPTIONS = USER_SORTS.map((option) => ({ value: option.key, label: option.label }));

export function PlatformAdminView({ token }: { token?: string }) {
  const { user } = useAuth();
  const [activityDays, setActivityDays] = useState<number>(ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS);
  const [spaceQuery, setSpaceQuery] = useState("");
  const [spaceSort, setSpaceSort] = useState<AdminSpaceSortKey>("recent");
  const [userQuery, setUserQuery] = useState("");
  const [userSort, setUserSort] = useState<AdminUserSortKey>("recent");
  const overviewQuery = useQuery({
    queryKey: xmatrixQueryKeys.domain(
      { userId: user?.id ?? "anonymous" }, "platform-overview", [activityDays],
    ),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({
        activityDays: String(activityDays), spaceLimit: "200", userLimit: "10000",
      });
      return xmatrixApiRequest<{ overview?: AdminPlatformOverview }>({
        url: `${ADMIN_OVERVIEW_WEB_ROUTE}?${params}`,
        token,
        signal,
      }).then((payload) => payload.overview ?? null);
    },
    enabled: Boolean(token && user?.id),
  });
  const overview = overviewQuery.data ?? null;
  const loading = overviewQuery.isFetching;
  const error = overviewQuery.error?.message ?? null;
  const forbidden = overviewQuery.error instanceof XMatrixApiError &&
    overviewQuery.error.status === 403;
  const refresh = () => void overviewQuery.refetch();

  const nowMs = useMemo(
    () => (overview ? Date.parse(overview.generatedAt) || Date.now() : Date.now()),
    [overview]
  );
  const spaces = useMemo(
    () => (overview ? sortAdminSpaces(filterAdminSpaces(overview.spaces, spaceQuery), spaceSort) : []),
    [overview, spaceQuery, spaceSort]
  );
  const users = useMemo(
    () => (overview
      ? sortAdminUsers(filterAdminUsers(overview.users, userQuery), userSort)
      : []),
    [overview, userQuery, userSort]
  );

  if (forbidden) {
    return (
      <div className="space-y-5">
        <EmptyToolState
          icon={Shield}
          title="Platform admin only"
          body="This account is not on the platform admin allowlist. Ask an operator to add it on the Hub."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1">
          {ACTIVITY_RANGES.map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setActivityDays(days)}
              aria-pressed={activityDays === days}
              className={cn(
                "rounded px-2.5 py-1 text-xs font-bold transition-colors",
                activityDays === days
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/60"
              )}
            >
              {days}d
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !token}
          className={actionClass({ variant: "secondary", size: "sm" })}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </button>
        {overview && (
          <span className="text-xs text-muted-foreground">
            Updated {formatAdminAge(overview.generatedAt, Date.now()) || "just now"}
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {!overview ? (
        loading ? (
          <ContentSkeleton label="Loading platform statistics" lines={6} className="min-h-[240px] justify-center" />
        ) : (
          <EmptyToolState
            icon={Shield}
            title="No platform data yet"
            body="Platform statistics appear once the hub has spaces and messages to report."
          />
        )
      ) : (
        <>
          {overview.truncated.messageMetrics && (
            <p
              role="status"
              className={noticeClass("attention", "rounded-lg px-4 py-3")}
            >
              Message metrics are partial because at least one Space exceeds the bounded Channel scan.
              Space, user, Channel, Agent, run, Machine, task, and storage totals remain complete.
            </p>
          )}
          <section aria-label="Platform totals" className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {platformAdminStatTiles(overview.totals).map((tile) => (
              <div key={tile.key} className="rounded-lg border border-border bg-card px-4 py-3">
                <p className="text-[11px] font-black uppercase tracking-wide text-muted-foreground">
                  {tile.label}
                </p>
                <p className="mt-1 text-2xl font-black tabular-nums">{tile.value}</p>
                {tile.hint && <p className="text-xs text-muted-foreground">{tile.hint}</p>}
              </div>
            ))}
          </section>

          {overview.userAccess && <UserAccessCard overview={overview} />}

          <ActivityCard overview={overview} />

          <SpacesTable
            spaces={spaces}
            total={overview.spaces.length}
            truncated={overview.truncated.spaces}
            query={spaceQuery}
            sort={spaceSort}
            nowMs={nowMs}
            onQueryChange={setSpaceQuery}
            onSortChange={setSpaceSort}
          />

          <UsersTable
            users={users}
            total={overview.userAccess?.registeredUsers ?? overview.users.length}
            truncated={overview.truncated.users}
            query={userQuery}
            sort={userSort}
            nowMs={nowMs}
            onQueryChange={setUserQuery}
            onSortChange={setUserSort}
          />

          {overview.storage.length > 0 && <StorageCard overview={overview} />}
        </>
      )}
    </div>
  );
}

function UserAccessCard({ overview }: { overview: AdminPlatformOverview }) {
  const access = overview.userAccess!;
  const percentage = (value: number) =>
    access.registeredUsers > 0 ? Math.round((value / access.registeredUsers) * 100) : 0;
  const metrics = [
    ["Registered", access.registeredUsers, "Authentication directory"],
    ["Active 24h", access.activeUsersLast24h, `${percentage(access.activeUsersLast24h)}% of users`],
    ["Active 7d", access.activeUsersLast7d, `${percentage(access.activeUsersLast7d)}% of users`],
    ["Active 30d", access.activeUsersLast30d, `${percentage(access.activeUsersLast30d)}% of users`],
    ["Email verified", access.emailVerifiedUsers, `${percentage(access.emailVerifiedUsers)}% of users`],
    ["Profiles completed", access.completedProfiles, `${percentage(access.completedProfiles)}% of users`],
  ] as const;
  return (
    <section aria-label="Registered user access" className="rounded-lg border border-border bg-card px-5 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-black">Registered user access</h2>
        <p className="text-xs text-muted-foreground">
          Activity is based on authentication session updates, not page views.
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {metrics.map(([label, value, hint]) => (
          <div key={label} className="rounded-md bg-muted/50 px-3 py-2">
            <p className="text-[11px] font-black uppercase tracking-wide text-muted-foreground">{label}</p>
            <p className="text-xl font-black tabular-nums">{formatAdminCount(value)}</p>
            <p className="text-[11px] text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ActivityCard({ overview }: { overview: AdminPlatformOverview }) {
  const bars = adminActivityBars(overview.activity);
  const peak = bars.reduce((max, bar) => Math.max(max, bar.messages), 0);
  const share = Math.round(agentMessageShare(overview.totals) * 100);

  return (
    <section className="rounded-lg border border-border bg-card px-5 py-4" aria-label="Message volume">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-black">Messages per day</h2>
        <p className="text-xs text-muted-foreground">
          {formatAdminCount(overview.totals.messagesLast7d)} in the last 7 days ·{" "}
          {share}% authored by agents
        </p>
      </div>
      {peak === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">No messages in this window.</p>
      ) : (
        <>
          <div className="mt-4 flex h-32 items-end gap-[2px]" role="img"
            aria-label={`Daily message volume for the last ${overview.activityDays} days, peaking at ${peak}`}>
            {bars.map((bar) => (
              <div
                key={bar.date}
                title={`${bar.date}: ${bar.messages} messages (${bar.humanMessages} human, ${bar.agentMessages} agent)`}
                className="group flex h-full flex-1 items-end"
              >
                <div
                  className="w-full rounded-t bg-chart-1 transition-opacity group-hover:opacity-80"
                  style={{ height: `${Math.max(bar.ratio * 100, bar.messages > 0 ? 3 : 0)}%` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
            <span>{bars[0]?.label}</span>
            <span>peak {formatAdminCount(peak)}</span>
            <span>{bars.at(-1)?.label}</span>
          </div>
        </>
      )}
    </section>
  );
}

function SpacesTable({
  spaces,
  total,
  truncated,
  query,
  sort,
  nowMs,
  onQueryChange,
  onSortChange,
}: {
  spaces: AdminSpaceSummary[];
  total: number;
  truncated: boolean;
  query: string;
  sort: AdminSpaceSortKey;
  nowMs: number;
  onQueryChange: (value: string) => void;
  onSortChange: (value: AdminSpaceSortKey) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card" aria-label="Spaces">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Building className="size-4 text-muted-foreground" />
        <h2 className="mr-auto text-sm font-black">
          Spaces <span className="text-muted-foreground">({spaces.length}/{total})</span>
        </h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search space or owner"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
        <GlassSelect
          value={sort}
          onChange={(value) => onSortChange(value as AdminSpaceSortKey)}
          options={SPACE_SORT_OPTIONS}
          aria-label="Sort spaces"
          className="h-8 rounded-md px-2 text-xs"
        />
      </div>
      {spaces.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No space matches this search.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-black uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2">Space</th>
                <th scope="col" className="px-4 py-2">Owner</th>
                <th scope="col" className="px-4 py-2 text-right">Members</th>
                <th scope="col" className="px-4 py-2 text-right">Channels</th>
                <th scope="col" className="px-4 py-2 text-right">Agents</th>
                <th scope="col" className="px-4 py-2 text-right">Messages</th>
                <th scope="col" className="px-4 py-2 text-right">7d</th>
                <th scope="col" className="px-4 py-2 text-right">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {spaces.map((space) => (
                <tr key={space.id} className="border-t border-border/70 hover:bg-muted/40">
                  <td className="max-w-[220px] px-4 py-2">
                    <span className="block truncate font-bold">{space.name}</span>
                  </td>
                  <td className="max-w-[220px] px-4 py-2">
                    <span className="block truncate text-xs text-muted-foreground">
                      {space.ownerEmail || space.ownerUserId}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(space.members)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(space.activeChannels)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(space.agentRegistrations)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(space.messages)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(space.messagesLast7d)}</td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {formatAdminAge(space.lastMessageAt || space.createdAt, nowMs) || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Showing the most recent spaces only; raise the limit on the Hub request to see more.
        </p>
      )}
    </section>
  );
}

function UsersTable({
  users,
  total,
  truncated,
  query,
  sort,
  nowMs,
  onQueryChange,
  onSortChange,
}: {
  users: AdminUserSummary[];
  total: number;
  truncated: boolean;
  query: string;
  sort: AdminUserSortKey;
  nowMs: number;
  onQueryChange: (value: string) => void;
  onSortChange: (value: AdminUserSortKey) => void;
}) {
  return (
    <section className="rounded-lg border border-border bg-card" aria-label="Users">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <Users className="size-4 text-muted-foreground" />
        <h2 className="mr-auto text-sm font-black">
          Registered users <span className="text-muted-foreground">({users.length}/{total})</span>
        </h2>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search user"
            className="h-8 w-56 pl-7 text-xs"
          />
        </div>
        <GlassSelect
          value={sort}
          onChange={(value) => onSortChange(value as AdminUserSortKey)}
          options={USER_SORT_OPTIONS}
          aria-label="Sort users"
          className="h-8 rounded-md px-2 text-xs"
        />
      </div>
      {users.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">No user matches this search.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1100px] text-sm">
            <thead>
              <tr className="text-left text-[11px] font-black uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2">User</th>
                <th scope="col" className="px-4 py-2 text-right">Registered</th>
                <th scope="col" className="px-4 py-2 text-right">Last access</th>
                <th scope="col" className="px-4 py-2 text-right">Sessions</th>
                <th scope="col" className="px-4 py-2 text-right">Verified</th>
                <th scope="col" className="px-4 py-2 text-right">Spaces</th>
                <th scope="col" className="px-4 py-2 text-right">Agents</th>
                <th scope="col" className="px-4 py-2 text-right">Machines</th>
                <th scope="col" className="px-4 py-2 text-right">Messages</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.userId} className="border-t border-border/70 hover:bg-muted/40">
                  <td className="max-w-[280px] px-4 py-2">
                    <span className="block truncate font-bold">{adminUserLabel(user)}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[user.name ? user.email : undefined, user.handle ? `@${user.handle}` : undefined]
                        .filter(Boolean).join(" · ")
                        || user.userId}
                    </span>
                    {(user.providers?.length ?? 0) > 0 && (
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {user.providers!.join(", ")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {formatAdminAge(user.registeredAt, nowMs) || "—"}
                  </td>
                  <td className="px-4 py-2 text-right text-xs tabular-nums text-muted-foreground">
                    {formatAdminAge(user.lastSessionAt, nowMs) || "Never"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatAdminCount(user.sessionCount ?? 0)}
                    {(user.activeSessions ?? 0) > 0 && (
                      <span className="ml-1 text-xs">({user.activeSessions} active)</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right text-xs">
                    {user.emailVerified === undefined ? "—" : user.emailVerified ? "Yes" : "No"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(user.spaces)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(user.agentRegistrations)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(user.machines)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{formatAdminCount(user.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          Showing the most connected users only; raise the limit on the Hub request to see more.
        </p>
      )}
    </section>
  );
}

function StorageCard({ overview }: { overview: AdminPlatformOverview }) {
  const peak = overview.storage.reduce((max, entry) => Math.max(max, entry.logicalBytes), 0);
  return (
    <section className="rounded-lg border border-border bg-card px-5 py-4" aria-label="Storage">
      <h2 className="text-sm font-black">Storage by category</h2>
      <ul className="mt-3 space-y-2">
        {overview.storage.slice(0, 12).map((entry) => (
          <li key={entry.category} className="flex items-center gap-3">
            <span className="w-40 shrink-0 truncate text-xs text-muted-foreground">{entry.category}</span>
            <span className="h-2 flex-1 overflow-hidden rounded bg-muted">
              <span
                className="block h-full rounded bg-chart-1"
                style={{ width: `${peak > 0 ? Math.max((entry.logicalBytes / peak) * 100, 1) : 0}%` }}
              />
            </span>
            <span className="w-24 shrink-0 text-right text-xs tabular-nums">
              {formatAdminBytes(entry.logicalBytes)}
            </span>
            <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {formatAdminCount(entry.rows)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
