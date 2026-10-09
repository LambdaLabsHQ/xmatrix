import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import { googleHeaders } from "./google-headers";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";

/*
 * Google AdSense (Management API v2), read-only. The grant is the single
 * `adsense.readonly` scope; an account is `accounts/pub-…`, and Google decides
 * which accounts the connected Google user may read.
 */

const API = "https://adsense.googleapis.com/v2";
const ACCOUNT = /^(?:accounts\/)?(pub-\d{6,24})$/u;
/* Report dimensions by the short names people use, in the order they are listed. */
const DIMENSIONS: Record<string, string> = {
  date: "DATE", month: "MONTH", domain: "DOMAIN_NAME", site: "OWNED_SITE_DOMAIN_NAME",
  country: "COUNTRY_NAME", platform: "PLATFORM_TYPE_NAME", page: "PAGE_URL",
};
const METRICS = ["ESTIMATED_EARNINGS", "PAGE_VIEWS", "PAGE_VIEWS_RPM", "IMPRESSIONS", "CLICKS"];
const MAX_ROWS = 250;
const MAX_DAYS = 1_095;
const DAY_MS = 86_400_000;


/** `pub-123…` or `accounts/pub-123…`, normalised to the API resource name. */
export function adsenseAccount(target: string): string | undefined {
  const match = target.match(ACCOUNT);
  return match ? `accounts/${match[1]}` : undefined;
}

function text(value: unknown): string {
  return String(value ?? "").slice(0, 300).replace(/[\r\n\t]/gu, " ");
}

/** `by=date,domain days=28 limit=50`; every key is optional. Dates are whole UTC days ending today. */
export function adsenseReportOptions(input: string, now = Date.now()):
  { dimensions: string[]; start: Date; end: Date; limit: number } | string {
  const options = new Map<string, string>();
  for (const word of input.trim().split(/\s+/u).filter(Boolean)) {
    const [key, value, ...rest] = word.split("=");
    if (!key || !value || rest.length || !["by", "days", "limit"].includes(key) || options.has(key)) {
      return "use by=<date,domain,…|none> days=<1-1095> limit=<1-250>";
    }
    options.set(key, value);
  }
  const by = options.get("by") ?? "date";
  const names = by === "none" ? [] : by.split(",");
  if (names.length > 2 || new Set(names).size !== names.length || names.some(name => !(name in DIMENSIONS))) {
    return `by is none or up to two of ${Object.keys(DIMENSIONS).join(", ")}`;
  }
  const days = Number(options.get("days") ?? "7");
  const limit = Number(options.get("limit") ?? "50");
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) return `days is a whole number from 1 to ${MAX_DAYS}`;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_ROWS) return `limit is a whole number from 1 to ${MAX_ROWS}`;
  const end = new Date(Math.floor(now / DAY_MS) * DAY_MS);
  return { dimensions: names.map(name => DIMENSIONS[name]!), start: new Date(end.getTime() - (days - 1) * DAY_MS), end, limit };
}

/** The generate URL: one custom date range, the fixed earnings metrics, newest dates first. */
export function adsenseReportUrl(account: string, options: Exclude<ReturnType<typeof adsenseReportOptions>, string>): URL {
  const url = new URL(`${API}/${account}/reports:generate`);
  url.searchParams.set("dateRange", "CUSTOM");
  for (const [prefix, day] of [["startDate", options.start], ["endDate", options.end]] as const) {
    url.searchParams.set(`${prefix}.year`, String(day.getUTCFullYear()));
    url.searchParams.set(`${prefix}.month`, String(day.getUTCMonth() + 1));
    url.searchParams.set(`${prefix}.day`, String(day.getUTCDate()));
  }
  for (const dimension of options.dimensions) url.searchParams.append("dimensions", dimension);
  for (const metric of METRICS) url.searchParams.append("metrics", metric);
  url.searchParams.append("orderBy", options.dimensions[0] === "DATE" ? "-DATE" : "-ESTIMATED_EARNINGS");
  url.searchParams.set("limit", String(options.limit));
  return url;
}

function cells(row: unknown): string[] {
  const values = record(row).cells;
  return Array.isArray(values) ? values.map(cell => text(record(cell).value)) : [];
}

export const GOOGLE_ADSENSE_ACTIONS: Record<string, ConnectorAction> = {
  list_accounts: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return statement.target === "*" && !statement.text.trim() ? {} : "use @googleadsense:list_accounts:*";
    },
    async execute({ credentials }) {
      const result = await providerJson(`${API}/accounts`, { headers: googleHeaders(credentials, "Google AdSense") });
      if (result.accounts !== undefined && !Array.isArray(result.accounts)) {
        throw new ProviderRequestError(502, "Google did not return an AdSense account list");
      }
      const accounts = (result.accounts as unknown[] | undefined) ?? [];
      const lines = accounts.slice(0, MAX_ROWS).map(value => {
        const account = record(value);
        return [text(account.name), text(account.displayName), text(account.state), text(record(account.timeZone).id)].join("\t");
      });
      return { summary: "AdSense accounts (name, display name, state, time zone):\n" +
        quoteRetrievedText(lines.join("\n") || "(no AdSense accounts for the connected Google account)") };
    },
  },
  list_sites: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const account = adsenseAccount(statement.target);
      return account && !statement.text.trim() ? { account } : "name an account: pub-1234567890123456";
    },
    async execute({ credentials }, input) {
      const result = await providerJson(`${API}/${input.account}/sites?pageSize=${MAX_ROWS}`, { headers: googleHeaders(credentials, "Google AdSense") });
      if (result.sites !== undefined && !Array.isArray(result.sites)) {
        throw new ProviderRequestError(502, "Google did not return an AdSense site list");
      }
      const sites = (result.sites as unknown[] | undefined) ?? [];
      const lines = sites.map(value => {
        const site = record(value);
        return [text(site.domain), text(site.state), site.autoAdsEnabled === true ? "auto ads" : ""].join("\t");
      });
      return { summary: `Sites in ${input.account} (domain, approval state, auto ads):\n` +
        quoteRetrievedText(lines.join("\n") || "(no sites)") };
    },
  },
  report: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const account = adsenseAccount(statement.target);
      if (!account) return "name an account: pub-1234567890123456";
      const options = adsenseReportOptions(statement.text);
      return typeof options === "string" ? options : { account, url: adsenseReportUrl(account, options).href };
    },
    async execute({ credentials }, input) {
      const result = await providerJson(input.url!, { headers: googleHeaders(credentials, "Google AdSense") });
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
      const url = new URL(input.url!);
      const day = (prefix: string) => ["year", "month", "day"].map(part => url.searchParams.get(`${prefix}.${part}`)).join("-");
      return { summary: `AdSense earnings for ${input.account}, ${day("startDate")} to ${day("endDate")} in the account time zone ` +
        "(today's figures are estimates and keep changing):\n" + quoteRetrievedText(rows.length ? lines.join("\n") : "(no data for this range)") };
    },
  },
};

/** Confirm the grant with a real read; the account list is not stored. */
export async function verifyGoogleAdsense(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson(`${API}/accounts`, { headers: googleHeaders(credentials, "Google AdSense") });
  if (result.accounts !== undefined && !Array.isArray(result.accounts)) {
    throw new ProviderRequestError(502, "Google did not confirm AdSense access");
  }
}
