import type { ConnectorAction } from "../provider";
import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import { quoteRetrievedText } from "./common";
import { googleHeaders } from "./google-headers";
import { cell, isoDate, keyedOptions, mappedChoices, trailingDays } from "./google-report";

/*
 * Google Analytics 4 (Admin API v1beta for the property list, Data API v1beta
 * for reports), read-only. The grant is the single `analytics.readonly` scope;
 * a property is its numeric id, and Google decides which properties the
 * connected Google user may read.
 */

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const PROPERTY = /^(?:properties\/)?(\d{1,20})$/u;
/* Report dimensions by the short names people use, in the order they are listed. */
const DIMENSIONS: Record<string, string> = {
  date: "date", month: "yearMonth", page: "landingPagePlusQueryString", channel: "sessionDefaultChannelGroup",
  source: "sessionSource", medium: "sessionMedium", country: "country", device: "deviceCategory",
};
const METRICS = ["sessions", "totalUsers", "engagedSessions", "engagementRate", "keyEvents"];
/* `channel=organic` keeps sessions Google files under one default channel group. */
const CHANNELS: Record<string, string> = {
  organic: "Organic Search", direct: "Direct", referral: "Referral", social: "Organic Social",
  paid: "Paid Search", email: "Email",
};
const MAX_ROWS = 250;
const MAX_DAYS = 1_095;
const SERVICE = "Google Analytics";

/** `123456789` or `properties/123456789`, normalised to the API resource name. */
export function analyticsProperty(target: string): string | undefined {
  const match = target.match(PROPERTY);
  return match ? `properties/${match[1]}` : undefined;
}

export interface AnalyticsReportOptions { dimensions: string[]; startDate: string; endDate: string; limit: number; channel?: string }

/** `by=date,page days=28 limit=50 channel=organic`; every key is optional. Dates are whole UTC days ending today. */
export function analyticsReportOptions(input: string, now = Date.now()): AnalyticsReportOptions | string {
  const options = keyedOptions(input, ["by", "days", "limit", "channel"],
    "use by=<date,page,…|none> days=<1-1095> limit=<1-250> channel=<organic,…>");
  if (typeof options === "string") return options;
  const by = options.get("by") ?? "date";
  const dimensions = mappedChoices(by === "none" ? [] : by.split(","), DIMENSIONS, 3);
  if (!dimensions) {
    return `by is none or up to three of ${Object.keys(DIMENSIONS).join(", ")}`;
  }
  const days = Number(options.get("days") ?? "28");
  const limit = Number(options.get("limit") ?? "50");
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) return `days is a whole number from 1 to ${MAX_DAYS}`;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) return `limit is a whole number from 1 to ${MAX_ROWS}`;
  const channels = mappedChoices(options.has("channel") ? [options.get("channel")!] : [], CHANNELS);
  if (!channels) return `channel is one of ${Object.keys(CHANNELS).join(", ")}`;
  const { start, end } = trailingDays(days, now);
  return { dimensions, startDate: isoDate(start), endDate: isoDate(end),
    limit, ...(channels.length ? { channel: channels[0]! } : {}) };
}

/** The runReport body: one date range, the fixed traffic metrics, newest dates first or most sessions first. */
export function analyticsReportBody(options: AnalyticsReportOptions): Record<string, unknown> {
  return {
    dateRanges: [{ startDate: options.startDate, endDate: options.endDate }],
    dimensions: options.dimensions.map(name => ({ name })),
    metrics: METRICS.map(name => ({ name })),
    orderBys: [options.dimensions[0] === "date" ? { dimension: { dimensionName: "date" }, desc: true } : { metric: { metricName: "sessions" }, desc: true }],
    limit: options.limit,
    metricAggregations: ["TOTAL"],
    ...(options.channel ? { dimensionFilter: { filter: { fieldName: "sessionDefaultChannelGroup",
      stringFilter: { matchType: "EXACT", value: options.channel } } } } : {}),
  };
}

function values(row: unknown, field: "dimensionValues" | "metricValues"): string[] {
  const cells = record(row)[field];
  return Array.isArray(cells) ? cells.map(value => cell(record(value).value)) : [];
}

export const GOOGLE_ANALYTICS_ACTIONS: Record<string, ConnectorAction> = {
  list_properties: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return statement.target === "*" && !statement.text.trim() ? {} : "use @googleanalytics:list_properties:*";
    },
    async execute({ credentials }) {
      const result = await providerJson(`${ADMIN}/accountSummaries?pageSize=200`, { headers: googleHeaders(credentials, SERVICE) });
      if (result.accountSummaries !== undefined && !Array.isArray(result.accountSummaries)) {
        throw new ProviderRequestError(502, "Google did not return a Google Analytics account list");
      }
      const lines: string[] = [];
      for (const value of (result.accountSummaries as unknown[] | undefined) ?? []) {
        const account = record(value);
        const properties = Array.isArray(account.propertySummaries) ? account.propertySummaries : [];
        for (const property of properties) {
          const summary = record(property);
          lines.push([cell(summary.property), cell(summary.displayName), cell(summary.propertyType), cell(account.displayName)].join("\t"));
        }
      }
      const shown = lines.slice(0, MAX_ROWS);
      return { summary: `Google Analytics properties (${lines.length}${lines.length > MAX_ROWS ? `; first ${MAX_ROWS} shown` : ""}; ` +
        "property, name, type, account):\n" + quoteRetrievedText(shown.join("\n") || "(no Google Analytics properties for the connected Google account)") };
    },
  },
  report: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const property = analyticsProperty(statement.target);
      if (!property) return "name a property: 123456789";
      const options = analyticsReportOptions(statement.text);
      return typeof options === "string" ? options : { property, options: JSON.stringify(options) };
    },
    async execute({ credentials }, input) {
      const options = JSON.parse(input.options!) as AnalyticsReportOptions;
      const result = await providerJson(`${DATA}/${input.property}:runReport`, { method: "POST",
        headers: googleHeaders(credentials, SERVICE), json: analyticsReportBody(options) });
      if (!Array.isArray(result.metricHeaders) || (result.rows !== undefined && !Array.isArray(result.rows))) {
        throw new ProviderRequestError(502, "Google did not return a Google Analytics report");
      }
      const header = [...options.dimensions, ...(result.metricHeaders as unknown[]).map(value => cell(record(value).name))];
      const rows = ((result.rows as unknown[] | undefined) ?? []).map(row => [...values(row, "dimensionValues"), ...values(row, "metricValues")].join("\t"));
      const totals = Array.isArray(result.totals) ? values(result.totals[0], "metricValues") : [];
      const lines = [header.join("\t"), ...rows, ...(totals.length ? [`TOTAL\t${totals.join("\t")}`] : [])];
      return { summary: `Google Analytics traffic for ${input.property}${options.channel ? ` (${options.channel} sessions)` : ""}, ` +
        `${options.startDate} to ${options.endDate} in the property time zone (recent days are still being processed):\n` +
        quoteRetrievedText(rows.length ? lines.join("\n") : "(no data for this range)") };
    },
  },
};

/** Confirm the grant with a real read; the property list is not stored. */
export async function verifyGoogleAnalytics(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson(`${ADMIN}/accountSummaries?pageSize=1`, { headers: googleHeaders(credentials, SERVICE) });
  if (result.accountSummaries !== undefined && !Array.isArray(result.accountSummaries)) {
    throw new ProviderRequestError(502, "Google did not confirm Google Analytics access");
  }
}
