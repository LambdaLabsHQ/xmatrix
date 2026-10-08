"use client";

/**
 * Platform admin overview.
 *
 * Operator-facing totals for the whole deployment: who uses it, how much, and
 * what it stores. It renders only what the Hub admin route returns — counts,
 * identities, timestamps — and never Channel content. The Hub re-checks the
 * platform-admin allowlist and records the read, so this view failing closed
 * on 403 is a UI courtesy, not the security boundary.
 */

import { useState, type ReactNode } from "react";
import {
  ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS,
  type AdminPlatformOverview,
} from "@xmatrix/protocol";
import { Loader2, RefreshCw, Shield } from "lucide-react";

import { noticeClass } from "@/components/ui/status-tone";
import { ContentSkeleton } from "./content-skeleton";
import { EmptyToolState } from "./workspace-admin-views";
import { isForbidden, usePlatformOverview } from "./platform-admin-data";
import {
  adminActivityBars,
  agentMessageShare,
  formatAdminAge,
  formatAdminBytes,
  formatAdminCount,
  platformAdminStatTiles,
} from "./platform-admin-overview";
import { ToolDetailSection } from "./tool-split";
import { AdminPaperAction } from "./admin-paper";
import { ErrorNotice } from "@/components/ui/error-notice";

const ACTIVITY_RANGES = [7, 14, 30, 90] as const;

/** The states every admin read shares: forbidden, failed, loading, empty. */
export function AdminReadState({ error, loading, hasData, emptyTitle, emptyBody, children }: {
  error: unknown;
  loading: boolean;
  hasData: boolean;
  emptyTitle: string;
  emptyBody: string;
  children: ReactNode;
}) {
  if (isForbidden(error)) {
    return (
      <EmptyToolState
        icon={Shield}
        title="Platform admin only"
        body="This account is not on the platform admin allowlist. Ask an operator to add it on the Hub."
      />
    );
  }
  return (
    <>
      <ErrorNotice error={error} action="Couldn't load platform data" className={noticeClass("alert", "mb-4 rounded-lg px-4 py-3")} />
      {hasData ? children : loading ? (
        <ContentSkeleton label="Loading platform data" lines={6} className="min-h-[240px] justify-center" />
      ) : (
        <EmptyToolState icon={Shield} title={emptyTitle} body={emptyBody} />
      )}
    </>
  );
}

export function AdminRefresh({ loading, onRefresh, generatedAt }: {
  loading: boolean;
  onRefresh: () => void;
  generatedAt?: string;
}) {
  return (
    <>
      <AdminPaperAction onClick={onRefresh} disabled={loading} title={generatedAt ? `Updated ${generatedAt}` : undefined}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        Refresh
      </AdminPaperAction>
      {generatedAt && (
        <span className="hidden text-[11px] text-muted-foreground md:inline">
          Updated {formatAdminAge(generatedAt, Date.now()) || "just now"}
        </span>
      )}
    </>
  );
}

/**
 * One admin read laid out the same way everywhere: refresh and its age on
 * top, then the shared read states, then the data.
 */
export function AdminQueryView<Data>({ query, generatedAt, title, lead, emptyTitle, emptyBody, children }: {
  query: { data: Data | null | undefined; error: unknown; isFetching: boolean; refetch: () => unknown };
  generatedAt?: (data: Data) => string;
  title?: string;
  /** Sits before the refresh button, such as a way back. */
  lead?: ReactNode;
  emptyTitle: string;
  emptyBody: string;
  children: (data: Data) => ReactNode;
}) {
  const data = query.data ?? null;
  return (
    <div className="space-y-4">
      <div className="app-admin-heading flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {title && <h2 className="mr-auto text-2xl font-semibold leading-tight">{title}</h2>}
        {lead}
        <AdminRefresh loading={query.isFetching} onRefresh={() => void query.refetch()}
          generatedAt={data && generatedAt ? generatedAt(data) : undefined} />
      </div>
      <AdminReadState error={query.error} loading={query.isFetching} hasData={data !== null}
        emptyTitle={emptyTitle} emptyBody={emptyBody}>
        {data !== null && children(data)}
      </AdminReadState>
    </div>
  );
}

export function PlatformAdminView({ token }: { token?: string }) {
  const [activityDays, setActivityDays] = useState<number>(ADMIN_OVERVIEW_DEFAULT_ACTIVITY_DAYS);
  const overviewQuery = usePlatformOverview(token, activityDays);
  const overview = overviewQuery.data ?? null;

  return (
    <div className="space-y-7">
      <div className="app-admin-heading flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="mr-auto text-2xl font-semibold leading-tight">Overview</h2>
        <AdminRefresh loading={overviewQuery.isFetching} onRefresh={() => void overviewQuery.refetch()}
          generatedAt={overview?.generatedAt} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 pb-1">
        <div role="group" aria-label="Activity range" className="mr-auto flex gap-4">
          {ACTIVITY_RANGES.map((days) => (
            <AdminPaperAction key={days} aria-pressed={activityDays === days}
              onClick={() => setActivityDays(days)}>{days}d</AdminPaperAction>
          ))}
        </div>
      </div>
      <AdminReadState error={overviewQuery.error} loading={overviewQuery.isFetching} hasData={Boolean(overview)}
        emptyTitle="No platform data yet"
        emptyBody="Platform statistics appear once the hub has spaces and messages to report.">
        {overview && <OverviewBody overview={overview} />}
      </AdminReadState>
    </div>
  );
}

function OverviewBody({ overview }: { overview: AdminPlatformOverview }) {
  return (
    <>
      {overview.truncated.messageMetrics && (
        <p role="status" className={noticeClass("attention", "rounded-lg px-4 py-3")}>
          Message metrics are partial because at least one Space exceeds the bounded Channel scan.
          Space, user, Channel, Agent, run, Machine, task, and storage totals remain complete.
        </p>
      )}
      <ToolDetailSection title="Platform">
        <AdminStatGrid stats={platformAdminStatTiles(overview.totals).map((tile) => ({
          label: tile.label, value: tile.value, hint: tile.hint,
        }))} />
      </ToolDetailSection>
      {overview.userAccess && <UserAccess overview={overview} />}
      <ToolDetailSection title="Messages per day">
        <ActivityChart overview={overview} />
      </ToolDetailSection>
      {overview.storage.length > 0 && <Storage overview={overview} />}
    </>
  );
}

/** Large numbers on the paper, a short line under each. No card around them. */
export function AdminStatGrid({ stats }: { stats: Array<{ label: string; value: string; hint?: string }> }) {
  return (
    <dl className="app-admin-stat-grid grid grid-cols-2 gap-x-6 gap-y-4 p-3 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="my-0.5 text-2xl font-semibold leading-tight tabular-nums">{stat.value}</dd>
          {stat.hint && <dd className="text-[11px] leading-4 text-muted-foreground">{stat.hint}</dd>}
        </div>
      ))}
    </dl>
  );
}

function UserAccess({ overview }: { overview: AdminPlatformOverview }) {
  const access = overview.userAccess!;
  const percentage = (value: number) =>
    access.registeredUsers > 0 ? Math.round((value / access.registeredUsers) * 100) : 0;
  const share = (value: number) => `${percentage(value)}% of users`;
  return (
    <ToolDetailSection title="Registered users">
      <AdminStatGrid stats={[
        { label: "Registered", value: formatAdminCount(access.registeredUsers), hint: "Authentication directory" },
        { label: "Active 24h", value: formatAdminCount(access.activeUsersLast24h), hint: share(access.activeUsersLast24h) },
        { label: "Active 7d", value: formatAdminCount(access.activeUsersLast7d), hint: share(access.activeUsersLast7d) },
        { label: "Active 30d", value: formatAdminCount(access.activeUsersLast30d), hint: share(access.activeUsersLast30d) },
        { label: "Email verified", value: formatAdminCount(access.emailVerifiedUsers), hint: share(access.emailVerifiedUsers) },
        { label: "Profiles completed", value: formatAdminCount(access.completedProfiles), hint: share(access.completedProfiles) },
      ]} />
      <p className="mt-3 text-xs text-muted-foreground">
        Activity is based on authentication session updates, not page views.
      </p>
    </ToolDetailSection>
  );
}

/** Daily bars with a per-day tooltip; shared by the overview and a user's detail. */
export function AdminDailyBars({ points, label }: {
  points: Array<{ date: string; messages: number; title?: string }>;
  label: string;
}) {
  const bars = adminActivityBars(points.map((point) => ({
    date: point.date, messages: point.messages, humanMessages: 0, agentMessages: 0,
  })));
  const peak = bars.reduce((max, bar) => Math.max(max, bar.messages), 0);
  if (peak === 0) return <p className="text-sm text-muted-foreground">No messages in this window.</p>;
  return (
    <>
      <div className="flex h-32 items-end gap-[2px]" role="img" aria-label={`${label}, peaking at ${peak}`}>
        {bars.map((bar, index) => (
          <div key={bar.date} title={points[index].title ?? `${bar.date}: ${bar.messages} messages`}
            className="group flex h-full flex-1 items-end">
            <div className="w-full rounded-t bg-chart-1 transition-opacity group-hover:opacity-80"
              style={{ height: `${Math.max(bar.ratio * 100, bar.messages > 0 ? 3 : 0)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-muted-foreground">
        <span>{bars[0]?.label}</span>
        <span>peak {formatAdminCount(peak)}</span>
        <span>{bars.at(-1)?.label}</span>
      </div>
    </>
  );
}

function ActivityChart({ overview }: { overview: AdminPlatformOverview }) {
  const share = Math.round(agentMessageShare(overview.totals) * 100);
  return (
    <>
      <p className="mb-3 text-xs text-muted-foreground">
        {formatAdminCount(overview.totals.messagesLast7d)} in the last 7 days · {share}% authored by agents
      </p>
      <AdminDailyBars
        label={`Daily message volume for the last ${overview.activityDays} days`}
        points={overview.activity.map((point) => ({
          date: point.date,
          messages: point.messages,
          title: `${point.date}: ${point.messages} messages (${point.humanMessages} human, ${point.agentMessages} agent)`,
        }))}
      />
    </>
  );
}

function Storage({ overview }: { overview: AdminPlatformOverview }) {
  const peak = overview.storage.reduce((max, entry) => Math.max(max, entry.logicalBytes), 0);
  return (
    <ToolDetailSection title="Storage by category">
      <ul className="space-y-2">
        {overview.storage.slice(0, 12).map((entry) => (
          <li key={entry.category} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 sm:flex">
            <span className="min-w-0 truncate text-xs text-muted-foreground sm:w-40 sm:shrink-0">{entry.category}</span>
            <span className="col-span-3 row-start-2 h-1 overflow-hidden bg-muted sm:flex-1">
              <span className="block h-full bg-chart-1"
                style={{ width: `${peak > 0 ? Math.max((entry.logicalBytes / peak) * 100, 1) : 0}%` }} />
            </span>
            <span className="shrink-0 text-right text-xs tabular-nums sm:w-24">{formatAdminBytes(entry.logicalBytes)}</span>
            <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:w-16">
              {formatAdminCount(entry.rows)}
            </span>
          </li>
        ))}
      </ul>
    </ToolDetailSection>
  );
}
