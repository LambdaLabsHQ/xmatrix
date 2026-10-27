"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
/**
 * Platform admin overview.
 *
 * Operator-facing totals for the whole deployment: who uses it, how much, and
 * what it stores. It renders only what the Hub admin route returns — counts,
 * identities, timestamps — and never Channel content. The Hub re-checks the
 * platform-admin allowlist and records the read, so this view failing closed
 * on 403 is a UI courtesy, not the security boundary.
 */

import { useMemo, type ReactNode } from "react";
import type { AdminActivityPoint, AdminPlatformOverview } from "@xmatrix/protocol";
import { Loader2, RefreshCw, Shield } from "lucide-react";

import { noticeClass } from "@/components/ui/status-tone";
import { ContentSkeleton } from "./content-skeleton";
import { EmptyToolState } from "./workspace-admin-views";
import { isForbidden, useAdminParam, usePlatformOverview } from "./platform-admin-data";
import {
  formatAdminAge,
  formatAdminBytes,
  formatAdminCount,
  platformAdminStatTiles,
} from "./platform-admin-overview";
import {
  ADMIN_RANGES,
  adminActivationFunnel,
  adminBucketPoints,
  adminChange,
  adminDayNumber,
  adminPeriod,
  adminPeriodFigures,
  adminRange,
  adminRegisteredSeries,
  adminWeeklyRetention,
  formatAdminChange,
  formatAdminDay,
  formatAdminDecimal,
  formatAdminPercent,
  type AdminFunnelStep,
  type AdminRetentionCohort,
} from "./platform-admin-analytics";
import { ADMIN_INK, AdminBarChart, AdminLineChart, AdminSparkline } from "./admin-charts";
import { AdminTable, type AdminColumn } from "./admin-table";
import { ToolDetailSection } from "./tool-split";
import { AdminPaperAction } from "./admin-paper";
import { ErrorNotice } from "@/components/ui/error-notice";

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
        {loading ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
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
  const [rangeParam, setRangeParam] = useAdminParam("range");
  const range = adminRange(rangeParam || "30d");
  const overviewQuery = usePlatformOverview(token);
  const overview = overviewQuery.data ?? null;

  return (
    <div className="space-y-7">
      <div className="app-admin-heading flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="mr-auto text-2xl font-semibold leading-tight">Overview</h2>
        <AdminRefresh loading={overviewQuery.isFetching} onRefresh={() => void overviewQuery.refetch()}
          generatedAt={overview?.generatedAt} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border/60 pb-1">
        <div role="group" aria-label="Range" className="mr-auto flex gap-4">
          {ADMIN_RANGES.map((option) => (
            <AdminPaperAction key={option.key} aria-pressed={range.key === option.key} title={option.label}
              onClick={() => setRangeParam(option.key === "30d" ? "" : option.key)}>{option.short}</AdminPaperAction>
          ))}
        </div>
        {overview && <PeriodLabel overview={overview} rangeKey={range.key} />}
      </div>
      <AdminReadState error={overviewQuery.error} loading={overviewQuery.isFetching} hasData={Boolean(overview)}
        emptyTitle="No platform data yet"
        emptyBody="Platform statistics appear once the hub has spaces and messages to report.">
        {overview && <OverviewBody overview={overview} rangeKey={range.key} />}
      </AdminReadState>
    </div>
  );
}

function PeriodLabel({ overview, rangeKey }: { overview: AdminPlatformOverview; rangeKey: string }) {
  const { current } = adminPeriod(overview.activity, rangeKey);
  if (!current.length) return null;
  return (
    <span className="text-[11px] tabular-nums text-muted-foreground">
      {formatAdminDay(current[0]!.date)} – {formatAdminDay(current.at(-1)!.date)}, UTC
    </span>
  );
}

function OverviewBody({ overview, rangeKey }: { overview: AdminPlatformOverview; rangeKey: string }) {
  const range = adminRange(rangeKey);
  const period = useMemo(() => adminPeriod(overview.activity, rangeKey), [overview.activity, rangeKey]);
  const days = period.current.length;
  const figures = useMemo(() => adminPeriodFigures(period.current, overview.users, period.start, period.end),
    [period, overview.users]);
  const before = useMemo(() => period.previous
    ? adminPeriodFigures(period.previous, overview.users, period.start - days, period.start - 1)
    : null, [period, days, overview.users]);
  // An older Hub sends message volume only.
  const measured = period.current.some((point) => point.activeUsers !== undefined);
  return (
    <>
      {overview.truncated.messageMetrics && (
        <p role="status" className={noticeClass("attention", "rounded-lg px-4 py-3")}>
          Message metrics are partial because at least one Space exceeds the bounded Channel scan.
          Space, user, Channel, Agent, run, Machine, task, and storage totals remain complete.
        </p>
      )}
      {measured ? (
        <>
          <ToolDetailSection title={before ? `At a glance, change from the ${range.label} before` : "At a glance"}>
            <AdminStatGrid stats={glanceStats(period.current, figures, before)} />
          </ToolDetailSection>
          <ActivePeople points={period.current} overview={overview} />
          <NewAccounts points={period.current} overview={overview} />
          <ToolDetailSection title={range.days ? `Activation of accounts from the last ${range.label}` : "Activation of every account"}>
            <AdminFunnel steps={adminActivationFunnel(overview, period.start, period.end)} />
          </ToolDetailSection>
          <ToolDetailSection title="Weekly retention">
            <AdminRetention cohorts={adminWeeklyRetention(overview.users, period.end)} />
          </ToolDetailSection>
        </>
      ) : (
        <p role="status" className={noticeClass("attention", "rounded-lg px-4 py-3")}>
          This Hub reports message volume only. Active people, new accounts, and retention appear once it is updated.
        </p>
      )}
      <MessagesPerDay points={period.current} />
      {measured && (
        <ToolDetailSection title="Daily numbers">
          <AdminTable id="d" label="Daily numbers" rows={[...period.current].reverse()} columns={DAILY_COLUMNS}
            rowKey={(point) => point.date} defaultSort="date" empty="No days in this range." />
        </ToolDetailSection>
      )}
      <ToolDetailSection title="Platform">
        <AdminStatGrid stats={platformAdminStatTiles(overview.totals, overview.storage.length > 0).map((tile) => ({
          label: tile.label, value: tile.value, hint: tile.hint,
        }))} />
      </ToolDetailSection>
      {overview.storage.length > 0 && <Storage overview={overview} />}
    </>
  );
}

type Stat = { label: string; value: string; hint?: string; change?: string; trend?: readonly number[] };

function glanceStats(
  points: readonly AdminActivityPoint[],
  figures: ReturnType<typeof adminPeriodFigures>,
  before: ReturnType<typeof adminPeriodFigures> | null,
): Stat[] {
  const series = (read: (point: AdminActivityPoint) => number | undefined) => points.map((point) => read(point) ?? 0);
  const change = (current: number | null, previous: number | null | undefined) =>
    formatAdminChange(adminChange(current, previous));
  const today = points.at(-1);
  const agentShare = figures.humanMessages + figures.agentMessages > 0
    ? figures.agentMessages / (figures.humanMessages + figures.agentMessages) : null;
  return [
    { label: "Active people", value: formatAdminCount(figures.activePeople),
      change: change(figures.activePeople, before?.activePeople), hint: "Sent a message of their own",
      trend: series((point) => point.activeUsers7d) },
    { label: "Daily active, average", value: formatAdminDecimal(figures.averageDailyActive),
      change: change(figures.averageDailyActive, before?.averageDailyActive),
      hint: `${formatAdminCount(today?.activeUsers ?? 0)} so far today`, trend: series((point) => point.activeUsers) },
    { label: "Stickiness", value: formatAdminPercent(figures.stickiness),
      change: change(figures.stickiness, before?.stickiness), hint: "Daily active ÷ 30-day active",
      trend: points.map((point) => point.activeUsers30d ? (point.activeUsers ?? 0) / point.activeUsers30d : 0) },
    { label: "New accounts", value: figures.signups === null ? "—" : formatAdminCount(figures.signups),
      change: change(figures.signups, before?.signups), trend: series((point) => point.signups) },
    { label: "Messages people wrote", value: formatAdminCount(figures.ownMessages),
      change: change(figures.ownMessages, before?.ownMessages), trend: series((point) => point.ownMessages) },
    { label: "All messages", value: formatAdminCount(figures.messages),
      change: change(figures.messages, before?.messages),
      hint: agentShare === null ? undefined : `${formatAdminPercent(agentShare)} of people's and Agents' by Agents`,
      trend: series((point) => point.messages) },
    { label: "Active Spaces, daily average", value: formatAdminDecimal(figures.averageActiveSpaces),
      change: change(figures.averageActiveSpaces, before?.averageActiveSpaces), trend: series((point) => point.activeSpaces) },
    { label: "Runs started", value: formatAdminCount(figures.runsStarted),
      change: change(figures.runsStarted, before?.runsStarted), trend: series((point) => point.runsStarted) },
  ];
}

/**
 * Large numbers on the paper, a short line under each: what changed against
 * the range before, what the figure means, and its trend. No card around them.
 */
export function AdminStatGrid({ stats }: { stats: Array<Stat> }) {
  return (
    <dl className="app-admin-stat-grid grid grid-cols-2 gap-x-6 gap-y-4 p-3 sm:grid-cols-3 lg:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label} className="min-w-0">
          <dt className="text-xs text-muted-foreground">{stat.label}</dt>
          <dd className="my-0.5 text-2xl font-semibold leading-tight">{stat.value}</dd>
          {(stat.change || stat.hint) && (
            <dd className="text-[11px] leading-4 text-muted-foreground">
              {stat.change && <span className="font-medium text-foreground">{stat.change}</span>}
              {stat.change && stat.hint && <br />}
              {stat.hint}
            </dd>
          )}
          {stat.trend && <dd><AdminSparkline values={stat.trend} label={`${stat.label} by day`} /></dd>}
        </div>
      ))}
    </dl>
  );
}

function ActivePeople({ points, overview }: { points: readonly AdminActivityPoint[]; overview: AdminPlatformOverview }) {
  const access = overview.userAccess;
  return (
    <ToolDetailSection title="Active people">
      <AdminLineChart label="People active each day, and over the 7 and 30 days ending on it"
        dates={points.map((point) => point.date)} series={[
          { key: "daily", label: "daily", color: ADMIN_INK[0], values: points.map((point) => point.activeUsers ?? 0) },
          { key: "weekly", label: "7-day", color: ADMIN_INK[1], values: points.map((point) => point.activeUsers7d ?? 0) },
          { key: "monthly", label: "30-day", color: ADMIN_INK[2], values: points.map((point) => point.activeUsers30d ?? 0) },
        ]} />
      <p className="mt-3 text-xs text-muted-foreground">
        Active on a UTC day: sent a message of their own in a Space they belong to. Agents&apos; messages,
        scheduled posts and imports do not count.
        {access && <> Signed in (any session, the CLI and apps included): {formatAdminCount(access.activeUsersLast24h)} in
          24h · {formatAdminCount(access.activeUsersLast7d)} in 7d · {formatAdminCount(access.activeUsersLast30d)} in 30d,
          of {formatAdminCount(access.registeredUsers)} registered.</>}
      </p>
    </ToolDetailSection>
  );
}

function sumPoints(bucket: readonly AdminActivityPoint[]): Omit<AdminActivityPoint, "date"> {
  const total = (read: (point: AdminActivityPoint) => number | undefined) =>
    bucket.reduce((sum, point) => sum + (read(point) ?? 0), 0);
  return {
    messages: total((point) => point.messages),
    humanMessages: total((point) => point.humanMessages),
    agentMessages: total((point) => point.agentMessages),
    ownMessages: total((point) => point.ownMessages),
    signups: total((point) => point.signups),
    runsStarted: total((point) => point.runsStarted),
  };
}

function NewAccounts({ points, overview }: { points: readonly AdminActivityPoint[]; overview: AdminPlatformOverview }) {
  const registered = adminRegisteredSeries(points, overview.userAccess?.registeredUsers ?? overview.totals.users);
  if (!registered) {
    return (
      <ToolDetailSection title="New accounts">
        <p className="text-sm text-muted-foreground">New accounts appear when the full registered-user list could be read.</p>
      </ToolDetailSection>
    );
  }
  const bars = adminBucketPoints(points, sumPoints);
  return (
    <ToolDetailSection title="New accounts">
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <AdminBarChart label={bars.length < points.length ? "New accounts per week" : "New accounts per day"}
          dates={bars.map((bar) => bar.date)} days={bars.map((bar) => bar.days)}
          series={[{ key: "signups", label: "new", color: ADMIN_INK[0], values: bars.map((bar) => bar.signups ?? 0) }]} />
        <AdminLineChart label="Registered accounts" height={148} dates={points.map((point) => point.date)}
          series={[{ key: "registered", label: "registered", color: ADMIN_INK[0], values: registered }]} />
      </div>
    </ToolDetailSection>
  );
}

function MessagesPerDay({ points }: { points: readonly AdminActivityPoint[] }) {
  const bars = adminBucketPoints(points, sumPoints);
  const weekly = bars.length < points.length;
  return (
    <ToolDetailSection title={weekly ? "Messages per week" : "Messages per day"}>
      <AdminBarChart label={`Messages per ${weekly ? "week" : "day"} by who sent them`}
        dates={bars.map((bar) => bar.date)} days={bars.map((bar) => bar.days)} series={[
          { key: "people", label: "people", color: ADMIN_INK[0], values: bars.map((bar) => bar.humanMessages) },
          { key: "agents", label: "Agents", color: ADMIN_INK[1], values: bars.map((bar) => bar.agentMessages) },
          { key: "other", label: "apps and xMatrix", color: ADMIN_INK[2],
            values: bars.map((bar) => Math.max(0, bar.messages - bar.humanMessages - bar.agentMessages)) },
        ]} />
    </ToolDetailSection>
  );
}

function AdminFunnel({ steps }: { steps: readonly AdminFunnelStep[] }) {
  const registered = steps[0]?.people ?? 0;
  if (registered === 0) return <p className="text-sm text-muted-foreground">No account registered in this range.</p>;
  return (
    <ol className="space-y-2.5">
      {steps.map((step) => {
        const share = step.people / registered;
        return (
          <li key={step.key} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-1 sm:flex">
            <span className="min-w-0 truncate text-xs text-muted-foreground sm:w-48 sm:shrink-0">{step.label}</span>
            <span className="col-span-3 row-start-2 h-1.5 overflow-hidden rounded-full bg-muted sm:flex-1">
              <span className="block h-full rounded-full bg-chart-1" style={{ width: `${share > 0 ? Math.max(share * 100, 1) : 0}%` }} />
            </span>
            <span className="shrink-0 text-right text-xs font-semibold tabular-nums sm:w-12">{formatAdminCount(step.people)}</span>
            <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground sm:w-10">{formatAdminPercent(share)}</span>
          </li>
        );
      })}
    </ol>
  );
}

function AdminRetention({ cohorts }: { cohorts: readonly AdminRetentionCohort[] }) {
  if (!cohorts.some((cohort) => cohort.people > 0)) {
    return <p className="text-sm text-muted-foreground">No account registered in the last eight weeks.</p>;
  }
  const weeks = cohorts[0]?.weeks.length ?? 0;
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] border-separate border-spacing-[2px] text-xs tabular-nums">
          <thead>
            <tr className="text-[11px] text-muted-foreground">
              <th scope="col" className="pb-1 pr-3 text-left font-normal">Registered in the week of</th>
              <th scope="col" className="pb-1 pr-3 text-right font-normal">People</th>
              {Array.from({ length: weeks }, (_, week) => (
                <th key={week} scope="col" className="pb-1 text-center font-normal">{week === 0 ? "Week 0" : `+${week}`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((cohort) => (
              <tr key={cohort.week}>
                <th scope="row" className="whitespace-nowrap pr-3 text-left font-normal">{formatAdminDay(cohort.week)}</th>
                <td className="pr-3 text-right">{formatAdminCount(cohort.people)}</td>
                {cohort.weeks.map((cell, week) => (
                  <td key={week} className="h-7 min-w-10 rounded-[4px] text-center"
                    title={cell ? `${cell.active} of ${cohort.people} active` : undefined}
                    style={cell && cohort.people > 0 ? {
                      background: `color-mix(in oklab, var(--chart-1) ${Math.round(8 + cell.share * 80)}%, transparent)`,
                      color: cell.share > 0.55 ? "var(--app-panel-paper, var(--background))" : undefined,
                    } : undefined}>
                    {cell && cohort.people > 0 ? formatAdminPercent(cell.share) : ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Share of each week&apos;s new accounts who sent a message of their own in each week after registering.
      </p>
    </>
  );
}

const DAILY_COLUMNS: AdminColumn<AdminActivityPoint>[] = [
  { key: "date", label: "Day (UTC)", value: (point) => adminDayNumber(point.date),
    render: (point) => <span className="whitespace-nowrap font-bold tabular-nums">{point.date}</span> },
  { key: "active", mobile: "metric", label: "Active", numeric: true, value: (point) => point.activeUsers,
    render: (point) => formatAdminCount(point.activeUsers ?? 0) },
  { key: "active7", mobile: "metric", label: "7-day", numeric: true, value: (point) => point.activeUsers7d,
    render: (point) => formatAdminCount(point.activeUsers7d ?? 0) },
  { key: "active30", mobile: "metric", label: "30-day", numeric: true, value: (point) => point.activeUsers30d,
    render: (point) => formatAdminCount(point.activeUsers30d ?? 0) },
  { key: "signups", mobile: "metric", label: "New", numeric: true, value: (point) => point.signups,
    render: (point) => point.signups === undefined ? "—" : formatAdminCount(point.signups) },
  { key: "own", label: "People wrote", numeric: true, value: (point) => point.ownMessages,
    render: (point) => formatAdminCount(point.ownMessages ?? 0) },
  { key: "messages", label: "Messages", numeric: true, value: (point) => point.messages,
    render: (point) => formatAdminCount(point.messages) },
  { key: "agents", mobile: false, label: "By Agents", numeric: true, value: (point) => point.agentMessages,
    render: (point) => formatAdminCount(point.agentMessages) },
  { key: "spaces", label: "Active Spaces", numeric: true, value: (point) => point.activeSpaces,
    render: (point) => formatAdminCount(point.activeSpaces ?? 0) },
  { key: "runs", label: "Runs", numeric: true, value: (point) => point.runsStarted,
    render: (point) => formatAdminCount(point.runsStarted ?? 0) },
];

/** Daily bars with a readout of the hovered day; shared by a user's and a Space's detail and Operations. */
export function AdminDailyBars({ points, label, unit = "messages" }: {
  points: Array<{ date: string; messages: number }>;
  label: string;
  unit?: string;
}) {
  if (!points.some((point) => point.messages > 0)) {
    return <p className="text-sm text-muted-foreground">No {unit} in this window.</p>;
  }
  return (
    <AdminBarChart label={label} dates={points.map((point) => point.date)}
      series={[{ key: "count", label: unit, color: ADMIN_INK[0], values: points.map((point) => point.messages) }]} />
  );
}

/** Daily messages split into people's and Agents' messages. */
export function AdminMessageBars({ activity, label }: {
  activity: Array<{ date: string; messages: number; humanMessages: number; agentMessages: number }>;
  label: string;
}) {
  if (!activity.some((point) => point.messages > 0)) {
    return <p className="text-sm text-muted-foreground">No messages in this window.</p>;
  }
  return (
    <AdminBarChart label={label} dates={activity.map((point) => point.date)} series={[
      { key: "people", label: "people", color: ADMIN_INK[0], values: activity.map((point) => point.humanMessages) },
      { key: "agents", label: "Agents", color: ADMIN_INK[1], values: activity.map((point) => point.agentMessages) },
      { key: "other", label: "apps and xMatrix", color: ADMIN_INK[2],
        values: activity.map((point) => Math.max(0, point.messages - point.humanMessages - point.agentMessages)) },
    ]} />
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
