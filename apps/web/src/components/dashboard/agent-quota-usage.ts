/**
 * Agent usage presentation: the provider quota windows the router reads for a
 * registration, one reading per window. Numbers come as the Hub stored them;
 * a window without a name is shown without inventing one.
 */

import { currentRoutingQuotaWindows, type AgentRegistrationLiveState } from "@xmatrix/protocol";

import type { MeterReading } from "./machine-load-panel";

/** How often the Agents page reads the catalog while it is open. */
export const AGENT_USAGE_REFRESH_MS = 15_000;

const HIGH_USE_PERCENT = 90;

/** Provider window labels as runtimes spell them, keyed without case or separators. */
const WINDOW_NAME: Record<string, string> = {
  "2h": "2-hour window", "2hour": "2-hour window", "2hours": "2-hour window",
  "5h": "5-hour window", "5hour": "5-hour window", "5hours": "5-hour window", fivehour: "5-hour window",
  "1d": "Daily", daily: "Daily",
  "1w": "Weekly", "7d": "Weekly", week: "Weekly", weekly: "Weekly", sevenday: "Weekly",
  "1mo": "Monthly", month: "Monthly", monthly: "Monthly",
};

function windowName(label: string | undefined): string {
  if (!label) return "Quota";
  return WINDOW_NAME[label.trim().toLowerCase().replace(/[_\s-]+/g, "")] ?? label;
}

/** Time until `resetAt`, coarse enough to hold still between refreshes. */
export function formatResetIn(resetAt: string | undefined, now: number): string | undefined {
  const reset = Date.parse(resetAt ?? "");
  if (!Number.isFinite(reset)) return undefined;
  const minutes = Math.max(0, Math.ceil((reset - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `resets in ${hours}h ${minutes % 60}m`;
  return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function agentUsageReadings(quota: AgentRegistrationLiveState["quota"], now: number): MeterReading[] {
  if (!quota) return [];
  return [...windowReadings(quota, now), ...accountReadings(quota.account)];
}

/** The provider's verdict on the account: it may serve past a used-up window
 * on credits, or refuse whatever the windows say. */
function accountReadings(account: NonNullable<AgentRegistrationLiveState["quota"]>["account"]): MeterReading[] {
  const credits = account?.credits;
  const readings: MeterReading[] = [];
  if (account?.allowed === false) readings.push({ key: "account", label: "Provider", value: "Refusing requests", high: true });
  if (credits?.unlimited) readings.push({ key: "credits", label: "Credits", value: "Unlimited", high: false });
  else if (credits?.balance !== undefined) {
    readings.push({ key: "credits", label: "Credits", value: `${credits.balance.toLocaleString("en-US")} left`, high: false });
  }
  return readings;
}

function windowReadings(quota: NonNullable<AgentRegistrationLiveState["quota"]>, now: number): MeterReading[] {
  const windows = currentRoutingQuotaWindows(quota.windows, now);
  if (!windows.length) {
    // A reading from before windows were stored: only its tightest share is known.
    const used = 100 - quota.remainingPercent;
    return [{ key: "quota", label: "Quota", value: `${Math.round(used)}% used`, fraction: used / 100,
      high: used >= HIGH_USE_PERCENT }];
  }
  // The window that resets soonest first, as a provider's own page lists them.
  const ordered = [...windows].sort((left, right) =>
    (Date.parse(left.resetAt ?? "") || Infinity) - (Date.parse(right.resetAt ?? "") || Infinity));
  return ordered.map((window, index) => ({
    key: `${window.label || "window"}:${index}`,
    label: windowName(window.label),
    value: `${Math.round(window.usedPercent)}% used`,
    detail: formatResetIn(window.resetAt, now),
    fraction: Math.max(0, Math.min(1, window.usedPercent / 100)),
    high: window.usedPercent >= HIGH_USE_PERCENT,
  }));
}

/** Compact provider windows for the same glance bars used by Machine rows. */
export function agentUsageGlance(quota: AgentRegistrationLiveState["quota"], now: number) {
  const shortLabels: Record<string, string> = {
    "2-hour window": "2h", "5-hour window": "5h", Daily: "1d", Weekly: "1w", Monthly: "1mo",
  };
  return agentUsageReadings(quota, now)
    .filter((reading) => reading.fraction !== undefined)
    .map((reading) => ({
      key: reading.key,
      label: shortLabels[reading.label] ?? reading.label,
      percent: Math.round(reading.fraction! * 100),
      detail: `${reading.label}: ${reading.value}${reading.detail ? ` · ${reading.detail}` : ""}`,
    }));
}
