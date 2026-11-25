import { readBoundedStream } from "@xmatrix/protocol";
import { importPKCS8, SignJWT } from "jose";
import { PACKAGE_NAME, play, playReporting } from "../google-play-api";
import { oneLine, record, text } from "../event-format";
import { ConnectorRemedy, providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { cell, keyedOptions } from "./google-report";

/*
 * Google Play operational analytics (docs/connectors/google-play.md):
 * - Android Vitals, error clusters and anomalies via the Play Developer
 *   Reporting API v1beta1 (already covered by the existing playdeveloperreporting
 *   OAuth scope — no OAuth consent changes).
 * - Reviews and voided/refunded purchases via androidpublisher v3.
 * - Play Console bulk CSV reports (installs, store performance, ratings,
 *   crashes, sales, earnings, subscriptions) from the Play Cloud Storage export
 *   bucket (pubsite_prod_rev_*) using an optional read-only Service Account key,
 *   without expanding the company OAuth app's consent scopes.
 */

const MAX_OUTPUT = 12_000;
const MAX_GCS_BYTES = 4 * 1024 * 1024;
const GCS_ORIGIN = "https://storage.googleapis.com";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const PLAY_BUCKET = /^pubsite_prod(?:_rev)?_[0-9]{6,30}$/u;
const MONTH_YYYYMM = /^20\d{2}(?:0[1-9]|1[0-2])$/u;
const DAY_MS = 86_400_000;

/** Extracts a canonical Play Console export bucket ID from a bare ID or gs:// / GCS browser URI. */
export function normalizePlayReportsBucket(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = trimmed
    .replace(/^gs:\/\//iu, "")
    .replace(/^https?:\/\/console\.cloud\.google\.com\/storage\/browser\//iu, "")
    .replace(/^https?:\/\/storage\.googleapis\.com\//iu, "")
    .split(/[/?#]/u)[0] ?? "";
  return PLAY_BUCKET.test(candidate) ? candidate : undefined;
}

interface VitalSpec {
  readonly resource: string;
  readonly label: string;
  readonly metrics: readonly string[];
  readonly rateMetrics: ReadonlySet<string>;
  readonly supportsCountry: boolean;
  readonly requiredDimensions?: readonly string[];
  readonly overviewFilter?: string;
  readonly gamesOnly?: boolean;
}

const VITALS: Readonly<Record<string, VitalSpec>> = {
  crash: {
    resource: "crashRateMetricSet", label: "Crash rate",
    metrics: ["crashRate", "userPerceivedCrashRate", "crashRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["crashRate", "userPerceivedCrashRate", "crashRate7dUserWeighted"]),
    supportsCountry: true,
  },
  anr: {
    resource: "anrRateMetricSet", label: "ANR rate",
    metrics: ["anrRate", "userPerceivedAnrRate", "anrRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["anrRate", "userPerceivedAnrRate", "anrRate7dUserWeighted"]),
    supportsCountry: true,
  },
  slow_start: {
    resource: "slowStartRateMetricSet", label: "Slow start",
    metrics: ["slowStartRate", "slowStartRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["slowStartRate", "slowStartRate7dUserWeighted"]),
    supportsCountry: true,
    requiredDimensions: ["startType"],
    overviewFilter: "startType = COLD",
  },
  slow_rendering: {
    resource: "slowRenderingRateMetricSet", label: "Slow rendering",
    metrics: ["slowRenderingRate20Fps", "slowRenderingRate30Fps", "slowRenderingRate20Fps7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["slowRenderingRate20Fps", "slowRenderingRate30Fps", "slowRenderingRate20Fps7dUserWeighted"]),
    supportsCountry: true,
    gamesOnly: true,
  },
  lmk: {
    resource: "lmkRateMetricSet", label: "LMK (low memory killer)",
    metrics: ["userPerceivedLmkRate", "userPerceivedLmkRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["userPerceivedLmkRate", "userPerceivedLmkRate7dUserWeighted"]),
    supportsCountry: true,
  },
  wakeups: {
    resource: "excessiveWakeupRateMetricSet", label: "Excessive wakeups",
    metrics: ["excessiveWakeupRate", "excessiveWakeupRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["excessiveWakeupRate", "excessiveWakeupRate7dUserWeighted"]),
    supportsCountry: true,
  },
  wakelocks: {
    resource: "stuckBackgroundWakelockRateMetricSet", label: "Stuck background wakelocks",
    metrics: ["stuckBgWakelockRate", "stuckBgWakelockRate7dUserWeighted", "distinctUsers"],
    rateMetrics: new Set(["stuckBgWakelockRate", "stuckBgWakelockRate7dUserWeighted"]),
    supportsCountry: true,
  },
  errors: {
    resource: "errorCountMetricSet", label: "Error counts",
    metrics: ["errorReportCount", "distinctUsers"],
    rateMetrics: new Set(),
    supportsCountry: false,
    requiredDimensions: ["reportType"],
  },
};

const OVERVIEW_KEYS = ["crash", "anr", "slow_start", "slow_rendering", "lmk"] as const;
const DIMENSIONS: Readonly<Record<string, string>> = {
  version: "versionCode", api: "apiLevel", device: "deviceModel", country: "countryCode",
};

interface GoogleDateTime {
  year: number;
  month: number;
  day: number;
  timeZone?: { id: string };
}

function parseDateTime(value: unknown): GoogleDateTime | undefined {
  const row = record(value);
  const year = Number(row.year), month = Number(row.month), day = Number(row.day);
  if (!Number.isSafeInteger(year) || !Number.isSafeInteger(month) || !Number.isSafeInteger(day)) return undefined;
  const tzId = text(record(row.timeZone).id);
  return { year, month, day, ...(tzId ? { timeZone: { id: tzId } } : {}) };
}

function formatDateTime(dt: GoogleDateTime): string {
  return `${String(dt.year).padStart(4, "0")}-${String(dt.month).padStart(2, "0")}-${String(dt.day).padStart(2, "0")}`;
}

function shiftDate(dt: GoogleDateTime, deltaDays: number): GoogleDateTime {
  const shifted = new Date(Date.UTC(dt.year, dt.month - 1, dt.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    ...(dt.timeZone ? { timeZone: dt.timeZone } : {}),
  };
}

function defaultFreshEnd(now: number): GoogleDateTime {
  // Play Developer Reporting daily freshness is typically 1-2 days behind UTC in America/Los_Angeles.
  const d = new Date(Math.floor(now / DAY_MS) * DAY_MS - DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), timeZone: { id: "America/Los_Angeles" } };
}

function dailyLatestEnd(metadata: Record<string, unknown>, now: number): GoogleDateTime {
  const freshnesses = (Array.isArray(record(metadata.freshnessInfo).freshnesses)
    ? record(metadata.freshnessInfo).freshnesses as unknown[] : []).map(record);
  const daily = freshnesses.find(item => text(item.aggregationPeriod) === "DAILY") ?? freshnesses[0];
  return parseDateTime(daily?.latestEndTime) ?? defaultFreshEnd(now);
}

function formatMetricValue(name: string, raw: unknown, rateMetrics: ReadonlySet<string>): string {
  const decimal = text(record(raw).value);
  if (!decimal) return "-";
  const num = Number(decimal);
  if (!Number.isFinite(num)) return cell(decimal);
  if (rateMetrics.has(name)) return `${(num * 100).toFixed(2)}%`;
  return Number.isInteger(num) ? String(num) : num.toFixed(2);
}

function dimensionText(row: Record<string, unknown>): string {
  const dims = (Array.isArray(row.dimensions) ? row.dimensions : []).map(record);
  if (!dims.length) return "";
  return dims.map(item => cell(item.valueLabel || item.stringValue || item.int64Value || "-")).join("/");
}

async function queryVitalMetric(credentials: Readonly<Record<string, string>>, packageName: string, spec: VitalSpec,
  days: number, dimension: string | undefined, options: { overview?: boolean; now?: number } = {}): Promise<{ end: GoogleDateTime; rows: Record<string, unknown>[] }> {
  const basePath = `/v1beta1/apps/${encodeURIComponent(packageName)}/${spec.resource}`;
  const metadata = await playReporting(credentials, basePath);
  const end = dailyLatestEnd(metadata, options.now ?? Date.now());
  const start = shiftDate(end, -days);
  const dims = [...new Set([...(spec.requiredDimensions ?? []), ...(dimension ? [dimension] : [])])];
  const body = {
    timelineSpec: { aggregationPeriod: "DAILY", startTime: start, endTime: end },
    metrics: [...spec.metrics],
    ...(dims.length ? { dimensions: dims } : {}),
    ...(options.overview && spec.overviewFilter ? { filter: spec.overviewFilter } : {}),
    pageSize: 100,
  };
  const response = await playReporting(credentials, `${basePath}:query`, { method: "POST", body });
  const rows = (Array.isArray(response.rows) ? response.rows : []).map(record);
  return { end, rows };
}

function rowMetricsMap(row: Record<string, unknown>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of (Array.isArray(row.metrics) ? row.metrics : []).map(record)) {
    const key = text(item.metric);
    if (key) map.set(key, item.decimalValue);
  }
  return map;
}

const VITALS_USAGE = "use <com.example.app> [metric=overview|crash|anr|slow_start|slow_rendering|lmk|wakeups|wakelocks|errors] [days=1-30] [by=version|api|device|country|none]";

export function parseVitalsOptions(input: string): { metric: string; days: number; by?: string } | string {
  const options = keyedOptions(input, ["metric", "days", "by"], VITALS_USAGE);
  if (typeof options === "string") return options;
  const metric = (options.get("metric") ?? "overview").toLowerCase();
  if (metric !== "overview" && !Object.hasOwn(VITALS, metric)) return VITALS_USAGE;
  const days = Number(options.get("days") ?? "7");
  if (!Number.isSafeInteger(days) || days < 1 || days > 30) return "days must be a whole number from 1 to 30";
  const byRaw = (options.get("by") ?? "none").toLowerCase();
  if (byRaw !== "none" && !Object.hasOwn(DIMENSIONS, byRaw)) return "by must be version, api, device, country or none";
  if (metric === "overview" && byRaw !== "none") return "by= cannot be combined with metric=overview; choose one metric";
  if (metric === "errors" && byRaw === "country") return "error counts cannot be sliced by country; use version, api, device or none";
  return { metric, days, ...(byRaw === "none" ? {} : { by: DIMENSIONS[byRaw] }) };
}

function positiveIntOption(options: Map<string, string>, key: string, fallback: number, max: number): number | string {
  const value = Number(options.get(key) ?? String(fallback));
  return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : `${key} must be a whole number from 1 to ${max}`;
}

const VOIDED_SOURCES: Readonly<Record<number, string>> = { 0: "user", 1: "developer", 2: "google" };
const VOIDED_REASONS: Readonly<Record<number, string>> = {
  0: "other", 1: "remorse", 2: "not_received", 3: "defective", 4: "accidental",
  5: "fraud", 6: "friendly_fraud", 7: "chargeback", 8: "unacknowledged",
};

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function parseServiceAccount(raw: string): ServiceAccountKey {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch {
    throw new ConnectorRemedy(400, "reportsServiceAccount must be the Google Cloud Service Account JSON key",
      { kind: "credential", field: "reportsServiceAccount" });
  }
  const obj = record(parsed);
  const client_email = text(obj.client_email).trim();
  const private_key = text(obj.private_key).trim();
  if (!client_email || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/u.test(client_email) || !private_key.includes("PRIVATE KEY")) {
    throw new ConnectorRemedy(400, "reportsServiceAccount must contain a valid Google service account client_email and private_key",
      { kind: "credential", field: "reportsServiceAccount" });
  }
  return { client_email, private_key };
}

async function serviceAccountStorageToken(sa: ServiceAccountKey): Promise<string> {
  let assertion: string;
  try {
    const key = await importPKCS8(sa.private_key, "RS256");
    assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/devstorage.read_only" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(sa.client_email)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(key);
  } catch {
    throw new ConnectorRemedy(401, "Could not sign with reportsServiceAccount private_key; check the JSON key",
      { kind: "credential", field: "reportsServiceAccount" });
  }
  const signal = AbortSignal.timeout(15_000);
  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST", redirect: "manual", signal,
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "xMatrix-Connectors" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const bytes = await readBoundedStream(response.body, 64 * 1024, () => new ProviderRequestError(502, "Google token response too large"), signal);
  let payload: Record<string, unknown> = {};
  try { payload = record(JSON.parse(new TextDecoder().decode(bytes))); } catch { /* not JSON */ }
  const token = text(payload.access_token);
  if (!response.ok || !token) {
    throw new ProviderRequestError(response.ok ? 502 : response.status,
      `Google refused the Play reports service account: ${oneLine(text(payload.error_description) || text(payload.error), 300) || `HTTP ${response.status}`}`);
  }
  return token;
}

/** Decode Play Console's UTF-16LE (BOM 0xFF 0xFE), UTF-16BE, or UTF-8 CSV bytes cleanly. */
export function decodePlayCsv(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  return new TextDecoder("utf-8").decode(bytes);
}

/** Parse RFC-4180 CSV into rows of string cells (bounded for safety). */
export function parseCsvRows(csv: string, maxRows = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i]!;
    if (inQuotes) {
      if (ch === '"' && csv[i + 1] === '"') { field += '"'; i += 1; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && csv[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.some(cellValue => cellValue.trim() !== "")) rows.push(row);
      row = [];
      if (rows.length >= maxRows) break;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (row.some(cellValue => cellValue.trim() !== "")) rows.push(row);
  }
  return rows;
}

const REPORT_PREFIXES: Readonly<Record<string, (pkg: string, month: string) => readonly string[]>> = {
  installs: (pkg, month) => [`stats/installs/installs_${pkg}_${month}_overview.csv`],
  store_performance: (pkg, month) => [
    `stats/store_performance/store_performance_${pkg}_${month}_traffic_source.csv`,
    `stats/store_performance/store_performance_${pkg}_${month}_overview.csv`,
  ],
  ratings: (pkg, month) => [`stats/ratings/ratings_${pkg}_${month}_overview.csv`],
  crashes: (pkg, month) => [`stats/crashes/crashes_${pkg}_${month}_overview.csv`],
  sales: (_pkg, month) => [`sales/salesreport_${month}.zip`, `sales/salesreport_${month}.csv`],
  earnings: (_pkg, month) => [`earnings/earnings_${month}.zip`, `earnings/earnings_${month}.csv`],
  subscriptions: (pkg, month) => [`financial-stats/subscriptions/subscriptions_${pkg}_${month}_overview.csv`],
};

const STORE_REPORTS_USAGE = "use <com.example.app> [kind=installs|store_performance|ratings|crashes|sales|earnings|subscriptions|list] [month=YYYYMM] [bucket=pubsite_prod_rev_…]";

function currentMonthYyyymm(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function fetchGcsObject(bucket: string, objectName: string, token: string, authMode: "oauth" | "service_account"): Promise<Uint8Array | undefined> {
  const url = new URL(`/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(objectName)}`, GCS_ORIGIN);
  url.searchParams.set("alt", "media");
  const signal = AbortSignal.timeout(25_000);
  const response = await fetch(url, { redirect: "manual", signal,
    headers: { authorization: `Bearer ${token}`, "user-agent": "xMatrix-Connectors" } });
  if (response.status === 404) { void response.body?.cancel().catch(() => undefined); return undefined; }
  const bytes = await readBoundedStream(response.body, MAX_GCS_BYTES, () => new ProviderRequestError(502, "Play Console report file is too large"), signal);
  if (!response.ok) {
    if (response.status === 403 && authMode === "oauth") {
      throw new ConnectorRemedy(403,
        "Google Cloud Storage refused the current Google Play OAuth token (the connected grant does not include devstorage.read_only yet, or lacks View app information & download bulk reports in Play Console). Save optional reportsServiceAccount as a fallback until storage scope is enabled",
        { kind: "credential", field: "reportsServiceAccount" });
    }
    const hint = response.status === 403 ? " (grant the service account View app information & download bulk reports / View financial data in Play Console)" : "";
    throw new ProviderRequestError(response.status, `Google Cloud Storage returned ${response.status} for ${objectName}${hint}`);
  }
  return bytes;
}

function summarizePlayCsv(csvText: string, maxRows = 31): string {
  const rows = parseCsvRows(csvText);
  if (!rows.length) return "(empty report)";
  const [head = [], ...data] = rows;
  const keepCols = head.map((h, i) => ({ h: h.trim(), i })).filter(({ h }) => h !== "Package Name");
  const headerLine = keepCols.map(({ h }) => cell(h)).join("\t");
  const recent = data.slice(-maxRows).reverse();
  const bodyLines = recent.map(row => keepCols.map(({ i }) => cell(row[i] ?? "")).join("\t"));
  const totals: string[] = [];
  for (const { h, i } of keepCols) {
    if (/date|month|package|country|source|state|currency|version|title|product|sku|type/iu.test(h)) continue;
    let sum = 0; let numeric = 0;
    for (const row of data) {
      const cleaned = (row[i] ?? "").trim().replace(/,/gu, "");
      if (!cleaned) continue;
      const val = Number(cleaned);
      if (Number.isFinite(val)) { sum += val; numeric += 1; }
    }
    if (numeric > 0 && !/average|rate|ratio|percent/iu.test(h)) {
      totals.push(`${h}: ${Number.isInteger(sum) ? sum : sum.toFixed(2)}`);
    }
  }
  const summaryLines = [headerLine, ...bodyLines];
  if (totals.length) summaryLines.push("", `Totals across ${data.length} row(s): ${totals.slice(0, 12).join(", ")}`);
  return summaryLines.join("\n");
}

export const GOOGLE_PLAY_ANALYTICS_ACTIONS: Record<string, ConnectorAction> = {
  vitals: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      if (!PACKAGE_NAME.test(statement.target)) return VITALS_USAGE;
      const parsed = parseVitalsOptions(statement.text);
      return typeof parsed === "string" ? parsed : { packageName: statement.target, options: JSON.stringify(parsed) };
    },
    async execute({ credentials }, input) {
      const packageName = input.packageName!;
      const options = JSON.parse(input.options!) as { metric: string; days: number; by?: string };
      if (options.metric === "overview") {
        const [results, anomaliesResp] = await Promise.all([
          Promise.all(OVERVIEW_KEYS.map(async key => {
            const spec = VITALS[key]!;
            try {
              const { end, rows } = await queryVitalMetric(credentials, packageName, spec, options.days, undefined, { overview: true });
              const newest = rows.at(-1);
              const metrics = newest ? rowMetricsMap(newest) : new Map<string, unknown>();
              const primary = spec.metrics[0]!;
              const secondary = spec.metrics.find(m => m.includes("userPerceived")) ?? spec.metrics[1]!;
              return [
                spec.label,
                formatDateTime(end),
                newest ? formatMetricValue(primary, metrics.get(primary), spec.rateMetrics) : "(no data)",
                newest && secondary !== primary ? formatMetricValue(secondary, metrics.get(secondary), spec.rateMetrics) : "-",
                newest ? formatMetricValue("distinctUsers", metrics.get("distinctUsers"), spec.rateMetrics) : "-",
                String(rows.length),
              ].join("\t");
            } catch (error) {
              if (spec.gamesOnly && error instanceof ProviderRequestError && error.status === 403 && /only accessible to games/iu.test(error.message)) {
                return `${spec.label}\t-\t(games only)\t-\t-\t0`;
              }
              throw error;
            }
          })),
          playReporting(credentials, `/v1beta1/apps/${encodeURIComponent(packageName)}/anomalies`, { query: { pageSize: "20" } }),
        ]);
        const anomalies = (Array.isArray(anomaliesResp.anomalies) ? anomaliesResp.anomalies : []).map(record);
        const lines = [
          "metric\tlatest date\tprimary\tuser-perceived/7d\tdistinct users\tdays with data",
          ...results,
          "",
          `Active anomalies: ${anomalies.length}${anomalies.length ? ` (${anomalies.slice(0, 5).map(a => cell(a.metricSet).split("/").pop()).join(", ")})` : ""}`,
        ];
        return { summary: `Android Vitals overview for ${packageName} (last ${options.days} day(s), Play Developer Reporting):\n` +
          quoteRetrievedText(lines.join("\n"), MAX_OUTPUT) };
      }
      const spec = VITALS[options.metric]!;
      const { end, rows } = await queryVitalMetric(credentials, packageName, spec, options.days, options.by);
      const activeDims = [...new Set([...(spec.requiredDimensions ?? []), ...(options.by ? [options.by] : [])])];
      const header = ["date", ...(activeDims.length ? [activeDims.join("/")] : []), ...spec.metrics].join("\t");
      const sorted = [...rows].reverse();
      const lines = sorted.map(row => {
        const dt = parseDateTime(row.startTime);
        const metrics = rowMetricsMap(row);
        return [
          dt ? formatDateTime(dt) : "-",
          ...(activeDims.length ? [dimensionText(row) || "-"] : []),
          ...spec.metrics.map(m => formatMetricValue(m, metrics.get(m), spec.rateMetrics)),
        ].join("\t");
      });
      return { summary: `Android Vitals (${spec.label}) for ${packageName}, ending ${formatDateTime(end)} (last ${options.days} day(s)):\n` +
        quoteRetrievedText(lines.length ? [header, ...lines].join("\n") : "(no vitals data for this window)", MAX_OUTPUT) };
    },
  },
  error_issues: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const usage = "use <com.example.app> [days=1-30] [limit=1-25] [type=all|crash|anr]";
      if (!PACKAGE_NAME.test(statement.target)) return usage;
      const options = keyedOptions(statement.text, ["days", "limit", "type"], usage);
      if (typeof options === "string") return options;
      const days = positiveIntOption(options, "days", 7, 30);
      if (typeof days === "string") return days;
      const limit = positiveIntOption(options, "limit", 15, 25);
      if (typeof limit === "string") return limit;
      const type = (options.get("type") ?? "all").toLowerCase();
      if (!["all", "crash", "anr"].includes(type)) return "type must be all, crash or anr";
      return { packageName: statement.target, days: String(days), limit: String(limit), type };
    },
    async execute({ credentials }, input) {
      const packageName = input.packageName!, days = Number(input.days), limit = Number(input.limit);
      const now = new Date();
      const start = new Date(now.getTime() - days * DAY_MS);
      const query: Record<string, string> = {
        pageSize: String(limit),
        orderBy: "errorReportCount desc",
        "interval.startTime.year": String(start.getUTCFullYear()),
        "interval.startTime.month": String(start.getUTCMonth() + 1),
        "interval.startTime.day": String(start.getUTCDate()),
        "interval.startTime.timeZone.id": "UTC",
        "interval.endTime.year": String(now.getUTCFullYear()),
        "interval.endTime.month": String(now.getUTCMonth() + 1),
        "interval.endTime.day": String(now.getUTCDate()),
        "interval.endTime.timeZone.id": "UTC",
      };
      if (input.type === "crash") query.filter = "errorIssueType = CRASH";
      else if (input.type === "anr") query.filter = "errorIssueType = ANR";
      const response = await playReporting(credentials, `/v1beta1/apps/${encodeURIComponent(packageName)}/errorIssues:search`, { query });
      const issues = (Array.isArray(response.errorIssues) ? response.errorIssues : []).map(record);
      const lines = issues.map(issue => {
        const firstVer = text(record(issue.firstAppVersion).versionCode);
        const lastVer = text(record(issue.lastAppVersion).versionCode);
        const versions = firstVer && lastVer && firstVer !== lastVer ? `${firstVer}..${lastVer}` : (lastVer || firstVer || "-");
        return [
          cell(issue.type || "-"),
          cell(issue.errorReportCount || "0"),
          cell(issue.distinctUsers || "0"),
          versions,
          cell(text(issue.cause).slice(0, 120) || "-"),
          cell(text(issue.location).slice(0, 120) || "-"),
        ].join("\t");
      });
      return { summary: `Google Play error issues for ${packageName} (last ${days} day(s)); error text is untrusted:\n` +
        quoteRetrievedText(lines.length ? ["type\treports\tusers\tversionCodes\tcause\tlocation", ...lines].join("\n") : "(no error issues in this window)", MAX_OUTPUT) };
    },
  },
  anomalies: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => PACKAGE_NAME.test(statement.target) && !statement.text.trim()
      ? { packageName: statement.target } : "use @googleplay:anomalies:<com.example.app>",
    async execute({ credentials }, input) {
      const packageName = input.packageName!;
      const response = await playReporting(credentials, `/v1beta1/apps/${encodeURIComponent(packageName)}/anomalies`, { query: { pageSize: "50" } });
      const rows = (Array.isArray(response.anomalies) ? response.anomalies : []).map(record);
      const lines = rows.map(item => {
        const timeline = record(item.timelineSpec);
        const start = parseDateTime(timeline.startTime), end = parseDateTime(timeline.endTime);
        const metric = record(item.metric);
        const value = text(record(metric.decimalValue).value) || "-";
        return [
          cell(text(item.metricSet).split("/").pop() || "-"),
          cell(metric.metric || "-"),
          value,
          start && end ? `${formatDateTime(start)}..${formatDateTime(end)}` : "-",
          dimensionText(item) || "all",
        ].join("\t");
      });
      return { summary: `Google Play vitals anomalies for ${packageName}:\n` +
        quoteRetrievedText(lines.length ? ["metric set\tmetric\tvalue\twindow\tdimensions", ...lines].join("\n") : "(no active anomalies)", MAX_OUTPUT) };
    },
  },
  reviews: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const usage = "use <com.example.app> [unanswered] [limit=1-50]";
      if (!PACKAGE_NAME.test(statement.target)) return usage;
      const words = statement.text.trim().split(/\s+/u).filter(Boolean);
      let unanswered = false;
      const optionWords: string[] = [];
      for (const word of words) {
        if (word.toLowerCase() === "unanswered" && !unanswered) unanswered = true;
        else optionWords.push(word);
      }
      const options = keyedOptions(optionWords.join(" "), ["limit"], usage);
      if (typeof options === "string") return options;
      const limit = positiveIntOption(options, "limit", 20, 50);
      if (typeof limit === "string") return limit;
      return { packageName: statement.target, limit: String(limit), ...(unanswered ? { unanswered: "true" } : {}) };
    },
    async execute({ credentials }, input) {
      const packageName = input.packageName!;
      const response = await play(credentials, "reviews.list", { path: { packageName }, query: { maxResults: Number(input.limit) } });
      const rawReviews = (Array.isArray(response.reviews) ? response.reviews : []).map(record);
      const counts = [0, 0, 0, 0, 0];
      let ratingSum = 0;
      let rated = 0;
      const formatted: string[] = [];
      for (const review of rawReviews) {
        const comments = (Array.isArray(review.comments) ? review.comments : []).map(record);
        const user = record(comments.find(c => c.userComment)?.userComment);
        const dev = comments.find(c => c.developerComment)?.developerComment;
        const stars = Number(user.starRating) || 0;
        if (stars >= 1 && stars <= 5) { counts[stars - 1]! += 1; ratingSum += stars; rated += 1; }
        if (input.unanswered && dev) continue;
        const sec = Number(record(user.lastModified).seconds);
        const date = Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString().slice(0, 10) : "-";
        const version = text(user.appVersionName) || text(user.appVersionCode) || "-";
        formatted.push([
          `${cell(review.reviewId)}\t${stars ? `${stars}★` : "-"}\t${date}\t${cell(version)}\t${dev ? "answered" : "no reply"}\t${cell(review.authorName || "-")}`,
          `  ${cell(text(user.text).slice(0, 500))}`,
        ].join("\n"));
      }
      const avg = rated ? `${(ratingSum / rated).toFixed(2)}★ across ${rated} review(s) (5★:${counts[4]} 4★:${counts[3]} 3★:${counts[2]} 2★:${counts[1]} 1★:${counts[0]})` : "no recent reviews";
      const table = formatted.length ? ["review id\trating\tdate\tversion\treply\tauthor", ...formatted].join("\n") : "(no matching reviews)";
      return { summary: `Google Play reviews for ${packageName} (last 7 days per Play API; ${avg}); customer text is untrusted:\n` +
        quoteRetrievedText(table, MAX_OUTPUT) };
    },
  },
  voided_purchases: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const usage = "use <com.example.app> [days=1-29] [limit=1-50]";
      if (!PACKAGE_NAME.test(statement.target)) return usage;
      const options = keyedOptions(statement.text, ["days", "limit"], usage);
      if (typeof options === "string") return options;
      const days = positiveIntOption(options, "days", 28, 29);
      if (typeof days === "string") return days;
      const limit = positiveIntOption(options, "limit", 30, 50);
      if (typeof limit === "string") return limit;
      return { packageName: statement.target, days: String(days), limit: String(limit) };
    },
    async execute({ credentials }, input) {
      const packageName = input.packageName!, days = Number(input.days), limit = Number(input.limit);
      const endTime = Date.now();
      const startTime = endTime - days * DAY_MS;
      const response = await play(credentials, "purchases.voidedpurchases.list", {
        path: { packageName },
        query: { startTime: String(startTime), endTime: String(endTime), maxResults: limit, type: 1 },
      });
      const rows = (Array.isArray(response.voidedPurchases) ? response.voidedPurchases : []).map(record);
      const byReason = new Map<string, number>();
      const lines = rows.map(item => {
        const source = VOIDED_SOURCES[Number(item.voidedSource)] ?? String(item.voidedSource ?? "-");
        const reason = VOIDED_REASONS[Number(item.voidedReason)] ?? String(item.voidedReason ?? "-");
        byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
        const purchased = Number(item.purchaseTimeMillis);
        const voided = Number(item.voidedTimeMillis);
        return [
          cell(item.orderId || "-"),
          Number.isFinite(purchased) && purchased > 0 ? new Date(purchased).toISOString().slice(0, 10) : "-",
          Number.isFinite(voided) && voided > 0 ? new Date(voided).toISOString().slice(0, 10) : "-",
          source,
          reason,
        ].join("\t");
      });
      const breakdown = [...byReason].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
      const header = ["order id\tpurchased\tvoided\tsource\treason", ...lines];
      if (breakdown) header.push("", `reasons: ${breakdown}`);
      return { summary: `Google Play voided/refunded purchases for ${packageName} (last ${days} day(s); ${rows.length} found):\n` +
        quoteRetrievedText(lines.length ? header.join("\n") : "(no voided purchases in this window)", MAX_OUTPUT) };
    },
  },
  store_reports: {
    effect: "read", requires: [],
    parse(statement) {
      if (!PACKAGE_NAME.test(statement.target)) return STORE_REPORTS_USAGE;
      const options = keyedOptions(statement.text, ["kind", "month", "bucket"], STORE_REPORTS_USAGE);
      if (typeof options === "string") return options;
      const kind = (options.get("kind") ?? "installs").toLowerCase();
      if (kind !== "list" && !Object.hasOwn(REPORT_PREFIXES, kind)) return STORE_REPORTS_USAGE;
      const month = options.get("month") ?? currentMonthYyyymm();
      if (!MONTH_YYYYMM.test(month)) return "month must be YYYYMM (for example 202611)";
      const rawBucket = options.get("bucket");
      const bucket = rawBucket === undefined ? undefined : normalizePlayReportsBucket(rawBucket);
      if (rawBucket !== undefined && !bucket) return "bucket must be your Play Console Cloud Storage bucket id (pubsite_prod_rev_… or gs://pubsite_prod_rev_…)";
      return { packageName: statement.target, kind, month, ...(bucket ? { bucket } : {}) };
    },
    async execute({ credentials, saveCredentials }, input) {
      const packageName = input.packageName!, kind = input.kind!, month = input.month!;
      const savedBucket = normalizePlayReportsBucket(credentials.reportsBucket ?? "") ?? "";
      const bucket = input.bucket ?? savedBucket;
      if (!bucket) {
        throw new ConnectorRemedy(400,
          "Set reportsBucket in Apps → Google Play Console (sync in one click from Play Console → Download reports via the xMatrix Chrome extension, or paste from Copy Cloud Storage URI, e.g. pubsite_prod_rev_…), or pass bucket=pubsite_prod_rev_… once",
          { kind: "credential", field: "reportsBucket" });
      }
      let token: string;
      let authMode: "oauth" | "service_account";
      if (credentials.reportsServiceAccount?.trim()) {
        const sa = parseServiceAccount(credentials.reportsServiceAccount);
        token = await serviceAccountStorageToken(sa);
        authMode = "service_account";
      } else if (credentials.oauthToken?.trim()) {
        token = credentials.oauthToken.trim();
        authMode = "oauth";
      } else {
        throw new ConnectorRemedy(400,
          "Connect Google Play Console or save reportsServiceAccount (Google Cloud Service Account JSON granted View app information & download bulk reports / View financial data in Play Console) to read Play Console Cloud Storage exports",
          { kind: "credential", field: "reportsServiceAccount" });
      }
      if (input.bucket && bucket !== savedBucket && saveCredentials) {
        await saveCredentials({ reportsBucket: bucket }).catch(() => undefined);
      }
      if (kind === "list") {
        let listed: Record<string, unknown>;
        try {
          listed = await providerJson(new URL(`/storage/v1/b/${encodeURIComponent(bucket)}/o?maxResults=100&prefix=stats/`, GCS_ORIGIN), {
            headers: { authorization: `Bearer ${token}` },
          });
        } catch (error) {
          if (authMode === "oauth" && error instanceof ProviderRequestError && error.status === 403) {
            throw new ConnectorRemedy(403,
              "Google Cloud Storage refused the current Google Play OAuth token (the connected grant does not include devstorage.read_only yet, or lacks View app information & download bulk reports in Play Console). Save optional reportsServiceAccount as a fallback until storage scope is enabled",
              { kind: "credential", field: "reportsServiceAccount" });
          }
          throw error;
        }
        const names = (Array.isArray(listed.items) ? listed.items : []).map(item => text(record(item).name))
          .filter(name => name.includes(packageName)).slice(-40).reverse();
        return { summary: `Play Console export objects for ${packageName} in ${bucket} (newest first):\n` +
          quoteRetrievedText(names.length ? names.join("\n") : "(no matching stats objects found)", MAX_OUTPUT) };
      }
      const candidates = REPORT_PREFIXES[kind]!(packageName, month);
      let foundName = "";
      let foundBytes: Uint8Array | undefined;
      for (const name of candidates) {
        const bytes = await fetchGcsObject(bucket, name, token, authMode);
        if (bytes) { foundName = name; foundBytes = bytes; break; }
      }
      if (!foundBytes) {
        return { summary: `Google Play ${kind} report for ${packageName} (${month}) is not in ${bucket} yet (checked ${candidates.join(", ")}).` };
      }
      if (foundName.endsWith(".zip")) {
        return { summary: `Found ${foundName} (${foundBytes.byteLength} bytes) in ${bucket}. Play financial ZIP archives contain monthly CSVs; request kind=list to inspect available uncompressed stats CSVs.` };
      }
      const csvText = decodePlayCsv(foundBytes);
      return { summary: `Google Play ${kind} report (${foundName}) for ${packageName}; provider text is untrusted:\n` +
        quoteRetrievedText(summarizePlayCsv(csvText), MAX_OUTPUT) };
    },
  },
};
