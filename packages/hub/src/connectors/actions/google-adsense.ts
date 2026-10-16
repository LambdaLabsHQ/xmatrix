import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import { googleHeaders } from "./google-headers";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { cell as text, keyedOptions, mappedChoices } from "./google-report";

/*
 * Google AdSense (Management API v2), read-only. The grant is the single
 * `adsense.readonly` scope; an account is `accounts/pub-…`, and Google decides
 * which accounts the connected Google user may read. The API has no field for
 * the per-format Auto ads switches (in-article, anchor, side rail, vignette)
 * or excluded areas: those are read in the AdSense site settings only.
 */

const API = "https://adsense.googleapis.com/v2";
const SERVICE = "Google AdSense";
const ACCOUNT = /^(?:accounts\/)?(pub-\d{6,24})$/u;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
/* Report dimensions by the short names people use, in the order they are listed. */
const DIMENSIONS: Record<string, string> = {
  date: "DATE", month: "MONTH", domain: "DOMAIN_NAME", site: "OWNED_SITE_DOMAIN_NAME",
  country: "COUNTRY_NAME", platform: "PLATFORM_TYPE_NAME", page: "PAGE_URL",
  format: "AD_FORMAT_NAME", ad_unit: "AD_UNIT_NAME",
};
const METRICS = ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS",
  "AD_REQUESTS", "AD_REQUESTS_COVERAGE", "ACTIVE_VIEW_VIEWABILITY"];
const MAX_ROWS = 250;
const MAX_DAYS = 1_095;
const DAY_MS = 86_400_000;
/* Google answers the policy issue list in about 20 seconds even when it is empty. */
const POLICY_ISSUES_TIMEOUT_MS = 45_000;
const NO_AUTO_ADS_IN_UNIT_SPLIT = "Auto ads have no ad unit name, so an ad_unit split leaves them out; read them with by=format or by=none.";

/** `pub-123…` or `accounts/pub-123…`, normalised to the API resource name. */
export function adsenseAccount(target: string): string | undefined {
  const match = target.match(ACCOUNT);
  return match ? `accounts/${match[1]}` : undefined;
}

export interface AdsenseReportOptions { dimensions: string[]; days: number; limit: number; domain?: string; includeToday: boolean }

/** `by=date,format days=28 limit=50 domain=example.com include_today`; every part is optional. */
export function adsenseReportOptions(input: string): AdsenseReportOptions | string {
  const words = input.trim().split(/\s+/u).filter(Boolean);
  const includeToday = words.includes("include_today");
  const options = keyedOptions(words.filter(word => word !== "include_today").join(" "), ["by", "days", "limit", "domain"],
    "use by=<date,format,…|none> days=<1-1095> limit=<1-250> domain=<example.com> include_today");
  if (typeof options === "string") return options;
  if (words.filter(word => word === "include_today").length > 1) return "include_today is given at most once";
  const by = options.get("by") ?? "date";
  const dimensions = mappedChoices(by === "none" ? [] : by.split(","), DIMENSIONS, 2);
  if (!dimensions) {
    return `by is none or up to two of ${Object.keys(DIMENSIONS).join(", ")}`;
  }
  const days = Number(options.get("days") ?? "7");
  const limit = Number(options.get("limit") ?? "50");
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) return `days is a whole number from 1 to ${MAX_DAYS}`;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) return `limit is a whole number from 1 to ${MAX_ROWS}`;
  const domain = options.get("domain")?.toLowerCase();
  if (domain !== undefined && !DOMAIN.test(domain)) return "domain is a host name such as example.com";
  return { dimensions, days, limit, includeToday, ...(domain ? { domain } : {}) };
}

/**
 * The calendar days of the report in the account's time zone: the last `days` whole days ending
 * yesterday, or ending today with `includeToday`. AdSense reads the dates in that zone too.
 */
export function accountDays(timeZone: string, days: number, includeToday: boolean, now = Date.now()): { start: string; end: string } {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const end = Date.parse(`${today}T00:00:00Z`) - (includeToday ? 0 : DAY_MS);
  return { start: new Date(end - (days - 1) * DAY_MS).toISOString().slice(0, 10), end: new Date(end).toISOString().slice(0, 10) };
}

/** The generate URL: one custom date range, the fixed metrics, newest dates first or most earnings first. */
export function adsenseReportUrl(account: string, options: AdsenseReportOptions, range: { start: string; end: string }): URL {
  const url = new URL(`${API}/${account}/reports:generate`);
  url.searchParams.set("dateRange", "CUSTOM");
  for (const [prefix, day] of [["startDate", range.start], ["endDate", range.end]] as const) {
    const [year, month, date] = day.split("-").map(Number);
    url.searchParams.set(`${prefix}.year`, String(year));
    url.searchParams.set(`${prefix}.month`, String(month));
    url.searchParams.set(`${prefix}.day`, String(date));
  }
  for (const dimension of options.dimensions) url.searchParams.append("dimensions", dimension);
  for (const metric of METRICS) url.searchParams.append("metrics", metric);
  if (options.domain) url.searchParams.append("filters", `DOMAIN_NAME==${options.domain}`);
  url.searchParams.append("orderBy", options.dimensions[0] === "DATE" ? "-DATE" : "-ESTIMATED_EARNINGS");
  url.searchParams.set("limit", String(options.limit));
  return url;
}

function cells(row: unknown): string[] {
  const values = record(row).cells;
  return Array.isArray(values) ? values.map(cell => text(record(cell).value)) : [];
}

/** One list field of a Google response; absent means empty, any other shape fails closed. */
function listed(result: Record<string, unknown>, field: string, what: string): unknown[] {
  if (result[field] !== undefined && !Array.isArray(result[field])) {
    throw new ProviderRequestError(502, `Google did not return ${what}`);
  }
  return ((result[field] as unknown[] | undefined) ?? []).slice(0, MAX_ROWS);
}

function get(url: string, credentials: Readonly<Record<string, string>>, timeoutMs?: number): Promise<Record<string, unknown>> {
  return providerJson(url, { headers: googleHeaders(credentials, SERVICE), ...(timeoutMs ? { timeoutMs } : {}) });
}

function accountAction(usage: string, run: (credentials: Readonly<Record<string, string>>, account: string) => Promise<string>): ConnectorAction {
  return {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const account = adsenseAccount(statement.target);
      return account && !statement.text.trim() ? { account } : `name an account: ${usage}`;
    },
    async execute({ credentials }, input) {
      return { summary: await run(credentials, input.account!) };
    },
  };
}

export const GOOGLE_ADSENSE_ACTIONS: Record<string, ConnectorAction> = {
  list_accounts: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return statement.target === "*" && !statement.text.trim() ? {} : "use @googleadsense:list_accounts:*";
    },
    async execute({ credentials }) {
      const accounts = listed(await get(`${API}/accounts`, credentials), "accounts", "an AdSense account list");
      const lines = accounts.map(value => {
        const account = record(value);
        return [text(account.name), text(account.displayName), text(account.state), text(record(account.timeZone).id)].join("\t");
      });
      return { summary: "AdSense accounts (name, display name, state, time zone):\n" +
        quoteRetrievedText(lines.join("\n") || "(no AdSense accounts for the connected Google account)") };
    },
  },
  list_sites: accountAction("@googleadsense:list_sites:pub-1234567890123456", async (credentials, account) => {
    const sites = listed(await get(`${API}/${account}/sites?pageSize=${MAX_ROWS}`, credentials), "sites", "an AdSense site list");
    const lines = sites.map(value => {
      const site = record(value);
      return [text(site.domain), text(site.state), site.autoAdsEnabled === true ? "auto ads on" : "auto ads off"].join("\t");
    });
    return `Sites in ${account} (domain, approval state, auto ads). The per-format Auto ads switches and excluded areas ` +
      "are not in the AdSense API; read them in AdSense under Ads → By site:\n" + quoteRetrievedText(lines.join("\n") || "(no sites)");
  }),
  list_adunits: accountAction("@googleadsense:list_adunits:pub-1234567890123456", async (credentials, account) => {
    const clients = listed(await get(`${API}/${account}/adclients?pageSize=${MAX_ROWS}`, credentials), "adClients", "an AdSense ad client list")
      .map(record).filter(client => client.productCode === "AFC" && typeof client.name === "string");
    const lines: string[] = [];
    for (const client of clients) {
      const units = listed(await get(`${API}/${client.name as string}/adunits?pageSize=${MAX_ROWS}`, credentials), "adUnits", "an AdSense ad unit list");
      for (const value of units) {
        const unit = record(value);
        const settings = record(unit.contentAdsSettings);
        lines.push([text(unit.displayName), text(unit.state), text(settings.type), text(settings.size), text(unit.reportingDimensionId)].join("\t"));
      }
    }
    return `Ad units in ${account} (name, state, type, size, reporting id). Auto ads are not ad units:\n` +
      quoteRetrievedText(lines.slice(0, MAX_ROWS).join("\n") || "(no ad units)");
  }),
  list_payments: accountAction("@googleadsense:list_payments:pub-1234567890123456", async (credentials, account) => {
    const payments = listed(await get(`${API}/${account}/payments`, credentials), "payments", "an AdSense payment list");
    const lines = payments.map(value => {
      const payment = record(value);
      const date = record(payment.date);
      const day = date.year ? [date.year, date.month, date.day].map(part => String(part).padStart(2, "0")).join("-") : "unpaid balance";
      return [day, text(payment.amount)].join("\t");
    });
    return `Payments of ${account} (date, amount; the unpaid balance is earnings not yet paid):\n` +
      quoteRetrievedText(lines.join("\n") || "(no payments)");
  }),
  list_alerts: accountAction("@googleadsense:list_alerts:pub-1234567890123456", async (credentials, account) => {
    const alerts = listed(await get(`${API}/${account}/alerts`, credentials), "alerts", "an AdSense alert list");
    const lines = alerts.map(value => {
      const alert = record(value);
      return [text(alert.severity), text(alert.type), text(alert.message)].join("\t");
    });
    return `Alerts of ${account} (severity, type, message):\n` + quoteRetrievedText(lines.join("\n") || "(no alerts)");
  }),
  list_policy_issues: accountAction("@googleadsense:list_policy_issues:pub-1234567890123456", async (credentials, account) => {
    const issues = listed(await get(`${API}/${account}/policyIssues?pageSize=${MAX_ROWS}`, credentials, POLICY_ISSUES_TIMEOUT_MS), "policyIssues", "an AdSense policy issue list");
    const lines = issues.map(value => {
      const issue = record(value);
      const topics = Array.isArray(issue.policyTopics) ? issue.policyTopics.map(topic => text(record(topic).topic)).join(", ") : "";
      const last = record(issue.lastDetectedDate);
      return [text(issue.entityType), text(issue.uri || issue.siteSection || issue.site), text(issue.action), topics,
        last.year ? [last.year, last.month, last.day].map(part => String(part).padStart(2, "0")).join("-") : ""].join("\t");
    });
    return `Policy issues of ${account} (entity, where, action, topics, last detected):\n` +
      quoteRetrievedText(lines.join("\n") || "(no policy issues)");
  }),
  report: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const account = adsenseAccount(statement.target);
      if (!account) return "name an account: pub-1234567890123456";
      const options = adsenseReportOptions(statement.text);
      return typeof options === "string" ? options : { account, options: JSON.stringify(options) };
    },
    async execute({ credentials }, input) {
      const options = JSON.parse(input.options!) as AdsenseReportOptions;
      const timeZone = record((await get(`${API}/${input.account}`, credentials)).timeZone).id;
      let range: { start: string; end: string };
      try {
        range = accountDays(String(timeZone), options.days, options.includeToday);
      } catch {
        throw new ProviderRequestError(502, "Google did not return the AdSense account time zone");
      }
      const result = await get(adsenseReportUrl(input.account!, options, range).href, credentials);
      if (!Array.isArray(result.headers) || (result.rows !== undefined && !Array.isArray(result.rows))) {
        throw new ProviderRequestError(502, "Google did not return an AdSense report");
      }
      const headers = (result.headers as unknown[]).map(value => {
        const header = record(value);
        return header.currencyCode ? `${text(header.name)} (${text(header.currencyCode)})` : text(header.name);
      });
      const rows = ((result.rows as unknown[] | undefined) ?? []).map(row => cells(row).join("\t"));
      const totals = cells(result.totals);
      const lines = [headers.join("\t"), ...rows, ...(totals.length ? [`TOTAL\t${totals.filter(Boolean).join("\t")}`] : [])];
      return { summary: `AdSense ${options.domain ?? "earnings"} for ${input.account}, ${range.start} to ${range.end} in the account time zone ` +
        `(${text(timeZone)}${options.includeToday ? "; today's figures are estimates and keep changing" : ""}).` +
        (options.dimensions.includes("AD_UNIT_NAME") ? ` ${NO_AUTO_ADS_IN_UNIT_SPLIT}` : "") + "\n" +
        quoteRetrievedText(rows.length ? lines.join("\n") : "(no data for this range)") };
    },
  },
};

/** Confirm the grant with a real read; the account list is not stored. */
export async function verifyGoogleAdsense(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await get(`${API}/accounts`, credentials);
  if (result.accounts !== undefined && !Array.isArray(result.accounts)) {
    throw new ProviderRequestError(502, "Google did not confirm AdSense access");
  }
}
