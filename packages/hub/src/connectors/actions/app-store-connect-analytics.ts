import { readBoundedStream } from "@xmatrix/protocol";
import { relation, type AppleResource, type AppStoreConnectApi } from "../app-store-connect-api";
import { record, text } from "../event-format";
import { isPublicHttpsUrl, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { appAction, bundleId, MAX_OUTPUT } from "./app-store-connect";
import { quoteRetrievedText } from "./common";
import { cell, keyedOptions } from "./google-report";

/*
 * App Store Connect Analytics Reports & Xcode Performance/Power Metrics:
 * - `analytics` reads Apple's Analytics Reports API (discovery/impressions/page
 *   views/conversion/sources, downloads, installs/deletions, sessions, crashes,
 *   purchases, subscriptions) using only the existing API key (no vendor number).
 * - `enable_analytics` creates an ONGOING or ONE_TIME_SNAPSHOT report request.
 * - `metrics` reads Xcode Power & Performance Metrics (`perfPowerMetrics`).
 */

const MAX_SEGMENT_BYTES = 2 * 1024 * 1024;
const MAX_INFLATED_BYTES = 16 * 1024 * 1024;
const MAX_SEGMENTS = 14;
const SEGMENT_TIMEOUT_MS = 25_000;
const PARALLEL = 4;
const TOP_ITEMS = 8;

interface ReportPreset {
  readonly category: "APP_STORE_ENGAGEMENT" | "APP_USAGE" | "COMMERCE" | "PERFORMANCE";
  readonly reportName: string;
  readonly label: string;
}

const REPORT_PRESETS: Readonly<Record<string, ReportPreset>> = {
  engagement: { category: "APP_STORE_ENGAGEMENT", reportName: "App Store Discovery and Engagement Standard", label: "Discovery & Engagement" },
  downloads: { category: "COMMERCE", reportName: "App Downloads Standard", label: "App Downloads" },
  installs: { category: "APP_USAGE", reportName: "App Store Installation and Deletion Standard", label: "Installations & Deletions" },
  sessions: { category: "APP_USAGE", reportName: "App Sessions Standard", label: "App Sessions" },
  crashes: { category: "APP_USAGE", reportName: "App Crashes", label: "App Crashes" },
  purchases: { category: "COMMERCE", reportName: "App Store Purchases Standard", label: "Purchases" },
  subscriptions: { category: "COMMERCE", reportName: "App Store Subscription Event Report Standard", label: "Subscription Events" },
  subscription_state: { category: "COMMERCE", reportName: "App Store Subscription State Report Standard", label: "Subscription State" },
};

const GRANULARITIES: Readonly<Record<string, "DAILY" | "WEEKLY" | "MONTHLY">> = {
  daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY",
};

const ANALYTICS_USAGE = "use <com.example.app> [report=engagement|downloads|installs|sessions|crashes|purchases|subscriptions|subscription_state|list] [granularity=daily|weekly|monthly] [days=1-31]";

export function parseAnalyticsOptions(input: string): { report: string; granularity: "DAILY" | "WEEKLY" | "MONTHLY"; days: number } | string {
  const options = keyedOptions(input, ["report", "granularity", "days"], ANALYTICS_USAGE);
  if (typeof options === "string") return options;
  const report = (options.get("report") ?? "engagement").toLowerCase();
  if (report !== "list" && !Object.hasOwn(REPORT_PRESETS, report)) return ANALYTICS_USAGE;
  const granKey = (options.get("granularity") ?? "daily").toLowerCase();
  const granularity = GRANULARITIES[granKey];
  if (!granularity) return "granularity must be daily, weekly or monthly";
  const maxCount = granularity === "DAILY" ? 31 : 12;
  const defaultCount = granularity === "DAILY" ? 7 : 4;
  const days = Number(options.get("days") ?? String(defaultCount));
  if (!Number.isSafeInteger(days) || days < 1 || days > maxCount) return `days must be a whole number from 1 to ${maxCount} for ${granKey}`;
  return { report, granularity, days };
}

function allowedSegmentHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower.endsWith(".amazonaws.com") || lower.endsWith(".apple.com") || lower.endsWith(".mzstatic.com");
}

async function fetchSegmentTsv(rawUrl: string): Promise<string> {
  if (!URL.canParse(rawUrl)) throw new ProviderRequestError(502, "Apple returned an invalid analytics segment URL");
  const parsed = new URL(rawUrl);
  if (!isPublicHttpsUrl(parsed) || !allowedSegmentHost(parsed.hostname)) {
    throw new ProviderRequestError(502, "Apple analytics segment URL pointed outside allowed Apple/S3 storage hosts");
  }
  const signal = AbortSignal.timeout(SEGMENT_TIMEOUT_MS);
  // Pre-signed segment URL carries its own signature; never attach Apple JWT credentials.
  const response = await fetch(parsed, { redirect: "manual", signal, headers: { "user-agent": "xMatrix-Connectors" } });
  const bytes = await readBoundedStream(response.body, MAX_SEGMENT_BYTES,
    () => new ProviderRequestError(502, "App Store analytics segment is too large"), signal);
  if (!response.ok) throw new ProviderRequestError(response.status, `Apple analytics segment download failed (HTTP ${response.status})`);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const inflated = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")));
    return new TextDecoder().decode(await readBoundedStream(inflated.body, MAX_INFLATED_BYTES,
      () => new ProviderRequestError(502, "App Store analytics segment inflated beyond limit"), signal));
  }
  return new TextDecoder().decode(bytes);
}

function pickReportRequest(requests: AppleResource[]): AppleResource | undefined {
  return requests.find(r => text(r.attributes.accessType) === "ONGOING" && r.attributes.stoppedDueToInactivity !== true)
    ?? requests.find(r => text(r.attributes.accessType) === "ONGOING")
    ?? requests[0];
}

function addCount(map: Map<string, number>, key: string, delta: number): void {
  const cleaned = key.trim();
  if (!cleaned || !delta) return;
  map.set(cleaned, (map.get(cleaned) ?? 0) + delta);
}

function topEntries(map: Map<string, number>, limit = TOP_ITEMS): string {
  return [...map].filter(([, count]) => count > 0).sort((a, b) => b[1] - a[1]).slice(0, limit)
    .map(([name, count]) => `${cell(name)} ${Number.isInteger(count) ? count : count.toFixed(2)}`).join(", ");
}

function parseTsvLines(tsvChunks: string[]): { columns: string[]; rows: string[][] } {
  let columns: string[] = [];
  const rows: string[][] = [];
  for (const tsv of tsvChunks) {
    const lines = tsv.split(/\r?\n/u);
    if (!lines.length) continue;
    const header = (lines[0] ?? "").split("\t").map(name => name.trim());
    if (!columns.length && header.some(Boolean)) columns = header;
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      rows.push(line.split("\t"));
    }
  }
  return { columns, rows };
}

function colIndex(columns: string[], ...candidates: string[]): number {
  const lower = columns.map(c => c.toLowerCase());
  for (const name of candidates) {
    const idx = lower.indexOf(name.toLowerCase());
    if (idx >= 0) return idx;
  }
  return -1;
}

/** Aggregate Apple Analytics TSV rows into an operator-friendly table per report kind. */
export function summarizeAnalyticsTsv(preset: string, tsvChunks: string[]): string {
  const { columns, rows } = parseTsvLines(tsvChunks);
  if (!columns.length || !rows.length) return "(no rows in downloaded segments)";
  const dateCol = colIndex(columns, "Date");
  const territoryCol = colIndex(columns, "Territory");
  const sourceCol = colIndex(columns, "Source Type");
  const deviceCol = colIndex(columns, "Device");
  const versionCol = colIndex(columns, "App Version");

  if (preset === "engagement") {
    const eventCol = colIndex(columns, "Event");
    const countsCol = colIndex(columns, "Counts");
    const uniqueCol = colIndex(columns, "Unique Counts");
    const byDate = new Map<string, { imp: number; uImp: number; pv: number; uPv: number; other: number }>();
    const sources = new Map<string, number>(), territories = new Map<string, number>(), devices = new Map<string, number>();
    for (const r of rows) {
      const date = (r[dateCol] ?? "").trim() || "-";
      const event = (r[eventCol] ?? "").trim().toLowerCase();
      const count = Number(r[countsCol]) || 0;
      const unique = Number(r[uniqueCol]) || 0;
      const bucket = byDate.get(date) ?? { imp: 0, uImp: 0, pv: 0, uPv: 0, other: 0 };
      if (event.includes("impression")) { bucket.imp += count; bucket.uImp += unique; }
      else if (event.includes("page view")) { bucket.pv += count; bucket.uPv += unique; }
      else { bucket.other += count; }
      byDate.set(date, bucket);
      if (sourceCol >= 0) addCount(sources, r[sourceCol] ?? "", count);
      if (territoryCol >= 0) addCount(territories, r[territoryCol] ?? "", count);
      if (deviceCol >= 0) addCount(devices, r[deviceCol] ?? "", count);
    }
    const dates = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const tot = { imp: 0, uImp: 0, pv: 0, uPv: 0 };
    const lines = ["date\timpressions\tunique imp\tpage views\tunique views\tview/imp"];
    for (const [date, d] of dates) {
      tot.imp += d.imp; tot.uImp += d.uImp; tot.pv += d.pv; tot.uPv += d.uPv;
      const cvr = d.imp > 0 ? `${((d.pv / d.imp) * 100).toFixed(1)}%` : "-";
      lines.push(`${date}\t${d.imp}\t${d.uImp}\t${d.pv}\t${d.uPv}\t${cvr}`);
    }
    lines.push(`TOTAL\t${tot.imp}\t${tot.uImp}\t${tot.pv}\t${tot.uPv}\t${tot.imp > 0 ? `${((tot.pv / tot.imp) * 100).toFixed(1)}%` : "-"}`);
    if (sources.size) lines.push("", `top sources: ${topEntries(sources)}`);
    if (territories.size) lines.push(`top territories: ${topEntries(territories)}`);
    if (devices.size) lines.push(`devices: ${topEntries(devices)}`);
    return lines.join("\n");
  }

  if (preset === "downloads") {
    const typeCol = colIndex(columns, "Download Type");
    const countsCol = colIndex(columns, "Counts");
    const byDate = new Map<string, { first: number; redownload: number; update: number; total: number }>();
    const sources = new Map<string, number>(), territories = new Map<string, number>(), versions = new Map<string, number>();
    for (const r of rows) {
      const date = (r[dateCol] ?? "").trim() || "-";
      const kind = (r[typeCol] ?? "").trim().toLowerCase();
      const count = Number(r[countsCol]) || 0;
      const bucket = byDate.get(date) ?? { first: 0, redownload: 0, update: 0, total: 0 };
      if (kind.includes("first-time")) bucket.first += count;
      else if (kind.includes("redownload")) bucket.redownload += count;
      else if (kind.includes("update")) bucket.update += count;
      bucket.total += count;
      byDate.set(date, bucket);
      if (sourceCol >= 0 && kind.includes("first-time")) addCount(sources, r[sourceCol] ?? "", count);
      if (territoryCol >= 0) addCount(territories, r[territoryCol] ?? "", count);
      if (versionCol >= 0) addCount(versions, r[versionCol] ?? "", count);
    }
    const dates = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
    const tot = { first: 0, redownload: 0, update: 0, total: 0 };
    const lines = ["date\tfirst-time\tredownloads\tupdates\ttotal"];
    for (const [date, d] of dates) {
      tot.first += d.first; tot.redownload += d.redownload; tot.update += d.update; tot.total += d.total;
      lines.push(`${date}\t${d.first}\t${d.redownload}\t${d.update}\t${d.total}`);
    }
    lines.push(`TOTAL\t${tot.first}\t${tot.redownload}\t${tot.update}\t${tot.total}`);
    if (sources.size) lines.push("", `first-time by source: ${topEntries(sources)}`);
    if (territories.size) lines.push(`top territories: ${topEntries(territories)}`);
    if (versions.size) lines.push(`top versions: ${topEntries(versions)}`);
    return lines.join("\n");
  }

  // Generic resilient aggregation for installs, sessions, crashes, purchases, subscriptions, subscription_state.
  const countCol = colIndex(columns, "Counts", "Sessions", "Total Session Duration", "Purchases", "Active Standard Price Subscriptions", "Quantity");
  const secondaryCol = colIndex(columns, "Unique Devices", "Unique Counts", "Active Devices", "Proceeds in USD");
  const eventCol = colIndex(columns, "Event", "State", "Purchase Type", "Download Type");
  const byDate = new Map<string, { primary: number; secondary: number; rows: number }>();
  const events = new Map<string, number>(), territories = new Map<string, number>(), versions = new Map<string, number>();
  for (const r of rows) {
    const date = (dateCol >= 0 ? (r[dateCol] ?? "").trim() : "") || "-";
    const p = countCol >= 0 ? (Number(r[countCol]) || 0) : 1;
    const s = secondaryCol >= 0 ? (Number(r[secondaryCol]) || 0) : 0;
    const bucket = byDate.get(date) ?? { primary: 0, secondary: 0, rows: 0 };
    bucket.primary += p; bucket.secondary += s; bucket.rows += 1;
    byDate.set(date, bucket);
    if (eventCol >= 0) addCount(events, r[eventCol] ?? "", p);
    if (territoryCol >= 0) addCount(territories, r[territoryCol] ?? "", p);
    if (versionCol >= 0) addCount(versions, r[versionCol] ?? "", p);
  }
  const pLabel = countCol >= 0 ? columns[countCol]! : "rows";
  const sLabel = secondaryCol >= 0 ? columns[secondaryCol]! : "";
  const dates = [...byDate.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  let totalP = 0, totalS = 0;
  const lines = [sLabel ? `date\t${pLabel}\t${sLabel}` : `date\t${pLabel}`];
  for (const [date, d] of dates) {
    totalP += d.primary; totalS += d.secondary;
    const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);
    lines.push(sLabel ? `${date}\t${fmt(d.primary)}\t${fmt(d.secondary)}` : `${date}\t${fmt(d.primary)}`);
  }
  const fmt = (n: number) => Number.isInteger(n) ? String(n) : n.toFixed(2);
  lines.push(sLabel ? `TOTAL\t${fmt(totalP)}\t${fmt(totalS)}` : `TOTAL\t${fmt(totalP)}`);
  if (events.size) lines.push("", `by ${columns[eventCol]}: ${topEntries(events)}`);
  if (territories.size) lines.push(`top territories: ${topEntries(territories)}`);
  if (versions.size) lines.push(`top versions: ${topEntries(versions)}`);
  return lines.join("\n");
}

const METRIC_TYPES = new Set(["all", "launch", "hang", "memory", "battery", "disk", "animation", "termination", "storage"]);

async function listAnalyticsReports(api: AppStoreConnectApi, requestId: string) {
  const categories = ["APP_STORE_ENGAGEMENT", "APP_USAGE", "COMMERCE", "PERFORMANCE"] as const;
  const pages = await Promise.all(categories.map(category =>
    api.listPreview(`/v1/analyticsReportRequests/${encodeURIComponent(requestId)}/reports`,
      { "filter[category]": category, "fields[analyticsReports]": "name,category", limit: "50" }, 1)));
  return pages.flatMap(page => page.rows);
}

export const APP_STORE_CONNECT_ANALYTICS_ACTIONS: Record<string, ConnectorAction> = {
  analytics: appAction("read", statement => {
    const app = bundleId(statement.target);
    if (!app) return ANALYTICS_USAGE;
    const options = parseAnalyticsOptions(statement.text);
    return typeof options === "string" ? options : { app, options: JSON.stringify(options) };
  }, async ({ api, app, input }) => {
    const options = JSON.parse(input.options!) as { report: string; granularity: "DAILY" | "WEEKLY" | "MONTHLY"; days: number };
    const requests = (await api.listPreview(`/v1/apps/${encodeURIComponent(app.id)}/analyticsReportRequests`,
      { "fields[analyticsReportRequests]": "accessType,stoppedDueToInactivity", limit: "50" }, 1)).rows;
    const active = pickReportRequest(requests);
    if (!active) {
      return `App Store Analytics Reports are not enabled yet for ${input.app}. Run @appstoreconnect:enable_analytics:${input.app} ongoing to start daily report generation (Apple typically delivers the first instances within 24 hours).`;
    }
    if (options.report === "list") {
      const reports = await listAnalyticsReports(api, active.id);
      const reqLines = requests.map(r => `${r.id}\t${cell(r.attributes.accessType)}\t${r.attributes.stoppedDueToInactivity === true ? "stopped" : "active"}`);
      const repLines = reports.map(r => `${cell(r.attributes.category)}\t${cell(r.attributes.name)}\t${r.id}`);
      return `App Store Analytics report requests & available reports for ${input.app}:\n` + quoteRetrievedText([
        "request id\taccess\tstate", ...reqLines, "", "category\treport name\treport id", ...repLines,
      ].join("\n"), MAX_OUTPUT);
    }
    const preset = REPORT_PRESETS[options.report]!;
    const reportRows = (await api.listPreview(`/v1/analyticsReportRequests/${encodeURIComponent(active.id)}/reports`,
      { "filter[category]": preset.category, "fields[analyticsReports]": "name,category", limit: "50" }, 1)).rows;
    const targetReport = reportRows.find(r => text(r.attributes.name) === preset.reportName);
    if (!targetReport) {
      return `Report "${preset.reportName}" is not listed yet under request ${active.id} (${cell(active.attributes.accessType)}) for ${input.app}. Run report=list to inspect available reports.`;
    }
    const instances = (await api.listPreview(`/v1/analyticsReports/${encodeURIComponent(targetReport.id)}/instances`,
      { "filter[granularity]": options.granularity, limit: "200" }, 2)).rows;
    if (!instances.length) {
      return `No ${options.granularity.toLowerCase()} instances are published yet for ${preset.label} on ${input.app} (request ${active.id}, ${cell(active.attributes.accessType)}). Apple publishes analytics instances 24–48h after traffic or enabling ongoing reports.`;
    }
    const selected = [...instances]
      .sort((a, b) => text(b.attributes.processingDate).localeCompare(text(a.attributes.processingDate)))
      .slice(0, options.days);
    const segmentUrls: string[] = [];
    for (let start = 0; start < selected.length && segmentUrls.length < MAX_SEGMENTS; start += PARALLEL) {
      const batch = await Promise.all(selected.slice(start, start + PARALLEL).map(inst =>
        api.listPreview(`/v1/analyticsReportInstances/${encodeURIComponent(inst.id)}/segments`,
          { "fields[analyticsReportSegments]": "url,sizeInBytes,checksum", limit: "5" }, 1)));
      for (const page of batch) {
        for (const seg of page.rows) {
          const url = text(seg.attributes.url);
          if (url && segmentUrls.length < MAX_SEGMENTS) segmentUrls.push(url);
        }
      }
    }
    if (!segmentUrls.length) {
      return `Found ${selected.length} ${options.granularity.toLowerCase()} instance(s) for ${preset.label} on ${input.app}, but none had downloadable segments yet.`;
    }
    const tsvChunks: string[] = [];
    for (let start = 0; start < segmentUrls.length; start += PARALLEL) {
      tsvChunks.push(...await Promise.all(segmentUrls.slice(start, start + PARALLEL).map(fetchSegmentTsv)));
    }
    const newestDate = text(selected[0]?.attributes.processingDate) || "-";
    const oldestDate = text(selected.at(-1)?.attributes.processingDate) || "-";
    return `App Store Analytics — ${preset.label} (${options.granularity.toLowerCase()}, ${selected.length} instance(s) ${oldestDate}..${newestDate}, ${tsvChunks.length} segment(s)) for ${input.app}; provider text is untrusted:\n` +
      quoteRetrievedText(summarizeAnalyticsTsv(options.report, tsvChunks), MAX_OUTPUT);
  }),
  enable_analytics: appAction("write", statement => {
    const app = bundleId(statement.target);
    const mode = (statement.text.trim() || "ongoing").toLowerCase();
    if (!app || (mode !== "ongoing" && mode !== "snapshot")) return "use <com.example.app> [ongoing|snapshot]";
    return { app, accessType: mode === "snapshot" ? "ONE_TIME_SNAPSHOT" : "ONGOING" };
  }, async ({ api, app, input }) => {
    const existing = (await api.listPreview(`/v1/apps/${encodeURIComponent(app.id)}/analyticsReportRequests`,
      { "fields[analyticsReportRequests]": "accessType,stoppedDueToInactivity", limit: "50" }, 1)).rows;
    if (input.accessType === "ONGOING") {
      const running = existing.find(r => text(r.attributes.accessType) === "ONGOING" && r.attributes.stoppedDueToInactivity !== true);
      if (running) return `App Store Analytics ONGOING request ${running.id} is already active for ${input.app}.`;
    }
    const created = record((await api.request("/v1/analyticsReportRequests", {
      method: "POST",
      data: { type: "analyticsReportRequests", attributes: { accessType: input.accessType }, relationships: { app: relation("apps", app.id) } },
    })).data);
    return `Enabled App Store Analytics (${input.accessType}) for ${input.app}: request ${text(created.id) || "created"}. Apple typically publishes the first report instances within 24–48 hours.`;
  }),
  metrics: appAction("read", statement => {
    const usage = "use <com.example.app> [type=all|launch|hang|memory|battery|disk|animation|termination|storage]";
    const app = bundleId(statement.target);
    if (!app) return usage;
    const options = keyedOptions(statement.text, ["type"], usage);
    if (typeof options === "string") return options;
    const type = (options.get("type") ?? "all").toLowerCase();
    if (!METRIC_TYPES.has(type)) return usage;
    return { app, type };
  }, async ({ api, app, input }) => {
    const query: Record<string, string> = { "filter[platform]": "IOS" };
    if (input.type !== "all") query["filter[metricType]"] = input.type!.toUpperCase();
    const payload = await api.request(`/v1/apps/${encodeURIComponent(app.id)}/perfPowerMetrics`, {
      query, accept: "application/vnd.apple.xcode-metrics+json",
    });
    const productData = (Array.isArray(payload.productData) ? payload.productData : []).map(record);
    const lines: string[] = [];
    for (const product of productData) {
      const categories = (Array.isArray(product.metricCategories) ? product.metricCategories : []).map(record);
      for (const cat of categories) {
        const catId = cell(cat.identifier || "-");
        const metrics = (Array.isArray(cat.metrics) ? cat.metrics : []).map(record);
        for (const metric of metrics) {
          const unit = text(record(metric.unit).displayName || record(metric.unit).identifier);
          const datasets = (Array.isArray(metric.datasets) ? metric.datasets : []).map(record);
          const latest = datasets.flatMap(ds => (Array.isArray(ds.points) ? ds.points : []).map(record)).at(-1);
          const val = latest?.value !== undefined ? `${latest.value}${unit ? ` ${unit}` : ""}` : "-";
          const ver = cell(latest?.version || "-");
          lines.push(`${catId}\t${cell(metric.identifier || "-")}\t${ver}\t${val}`);
        }
      }
    }
    const insights = record(payload.insights);
    const regressions = (Array.isArray(insights.regressions) ? insights.regressions : []).length;
    const trending = (Array.isArray(insights.trendingUp) ? insights.trendingUp : []).length;
    const body = lines.length
      ? ["category\tmetric\tversion\tvalue", ...lines.slice(0, 60), "", `insights: ${regressions} regression(s), ${trending} trending up`].join("\n")
      : `(no Xcode performance/power metrics available yet; insights: ${regressions} regression(s), ${trending} trending up)`;
    return `App Store Xcode performance & power metrics for ${input.app} (${input.type}):\n` + quoteRetrievedText(body, MAX_OUTPUT);
  }),
};
