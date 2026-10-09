import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { googleHeaders } from "./google-headers";

/*
 * Google Search Console (Search Console API v1 / webmasters v3). The grant is
 * the single `webmasters` scope; a site is an address, and Google decides
 * whether the connected account may read or submit for it.
 */

const API = "https://www.googleapis.com/webmasters/v3";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/u;
const DIMENSIONS = new Set(["query", "page", "country", "device", "date", "searchAppearance"]);
const SEARCH_TYPES = new Set(["web", "image", "video", "news", "discover", "googleNews"]);
const MAX_URL = 2_048;
const MAX_LINES = 250;
const DAY_MS = 86_400_000;


/** A public http(s) page or sitemap address without credentials or fragments. */
function pageUrl(value: string): URL | undefined {
  if (!value || value.length > MAX_URL || /\s/u.test(value)) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash || !DOMAIN.test(url.hostname)) return undefined;
  return url;
}

/** `sc-domain:example.com` or a URL-prefix property such as `https://www.example.com/`. */
export function searchConsoleSite(target: string): string | undefined {
  if (target.startsWith("sc-domain:")) {
    const domain = target.slice("sc-domain:".length);
    return DOMAIN.test(domain) ? target : undefined;
  }
  const url = pageUrl(target);
  return url && !url.search && url.pathname.endsWith("/") && url.href === target ? target : undefined;
}

/** Whether a page belongs to the property, so Google is never asked about another site. */
function searchConsoleSiteContains(site: string, page: URL): boolean {
  if (site.startsWith("sc-domain:")) {
    const domain = site.slice("sc-domain:".length);
    return page.hostname === domain || page.hostname.endsWith(`.${domain}`);
  }
  return page.href.startsWith(site);
}

function siteUrl(site: string, path = ""): string {
  return `${API}/sites/${encodeURIComponent(site)}${path}`;
}

function cell(value: unknown): string {
  return String(value ?? "").slice(0, 300).replace(/[\r\n\t]/gu, " ");
}

function isoDate(ms: number): string { return new Date(ms).toISOString().slice(0, 10); }

/** `by=query,page days=28 limit=25 type=web`; every key is optional. */
export function searchAnalyticsOptions(text: string, now = Date.now()):
  { dimensions: string[]; startDate: string; endDate: string; rowLimit: number; type: string } | string {
  const options: Record<string, string> = {};
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    const match = word.match(/^(by|days|limit|type)=(\S{1,100})$/u);
    if (!match || options[match[1]!] !== undefined) return "use by=<dimensions|none> days=<1-480> limit=<1-250> type=<search type>";
    options[match[1]!] = match[2]!;
  }
  const dimensions = options.by === "none" ? [] : (options.by ?? "query").split(",");
  if (dimensions.length > 3 || new Set(dimensions).size !== dimensions.length || dimensions.some(value => !DIMENSIONS.has(value))) {
    return `by is none or up to three of ${[...DIMENSIONS].join(", ")}`;
  }
  const days = Number(options.days ?? "28");
  const rowLimit = Number(options.limit ?? "25");
  if (!Number.isSafeInteger(days) || days < 1 || days > 480) return "days is a whole number from 1 to 480";
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > MAX_LINES) return `limit is a whole number from 1 to ${MAX_LINES}`;
  const type = options.type ?? "web";
  if (!SEARCH_TYPES.has(type)) return `type is one of ${[...SEARCH_TYPES].join(", ")}`;
  const end = Math.floor(now / DAY_MS) * DAY_MS;
  return { dimensions, startDate: isoDate(end - (days - 1) * DAY_MS), endDate: isoDate(end), rowLimit, type };
}

function siteOnly(statement: { target: string; text: string }, usage: string): Record<string, string> | string {
  const site = searchConsoleSite(statement.target);
  return site && !statement.text.trim() ? { site } : usage;
}

function siteAndPage(statement: { target: string; text: string }, usage: string): Record<string, string> | string {
  const site = searchConsoleSite(statement.target);
  const page = pageUrl(statement.text.trim());
  return site && page && searchConsoleSiteContains(site, page) ? { site, page: page.href } : usage;
}

export const GOOGLE_SEARCH_CONSOLE_ACTIONS: Record<string, ConnectorAction> = {
  list_sites: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      return statement.target === "*" && !statement.text.trim() ? {} : "use @googlesearchconsole:list_sites:*";
    },
    async execute({ credentials }) {
      const result = await providerJson(`${API}/sites`, { headers: googleHeaders(credentials, "Google Search Console") });
      // Google omits siteEntry entirely when the account has no properties.
      if (result.siteEntry !== undefined && !Array.isArray(result.siteEntry)) {
        throw new ProviderRequestError(502, "Google did not return a Search Console site list");
      }
      const entries = (result.siteEntry as unknown[] | undefined) ?? [];
      const lines = entries.slice(0, MAX_LINES).map(value => {
        const entry = record(value);
        return `${cell(entry.siteUrl)}\t${cell(entry.permissionLevel)}`;
      });
      return { summary: `Search Console properties (${entries.length}${entries.length > MAX_LINES ? `; first ${MAX_LINES} shown` : ""}):\n` +
        quoteRetrievedText(lines.join("\n") || "(no properties for the connected Google account)") };
    },
  },
  query: {
    effect: "read", requires: ["oauthToken"],
    parse(statement) {
      const site = searchConsoleSite(statement.target);
      if (!site) return "name a property: sc-domain:example.com or https://www.example.com/";
      const options = searchAnalyticsOptions(statement.text);
      return typeof options === "string" ? options : { site, options: JSON.stringify(options) };
    },
    async execute({ credentials }, input) {
      const options = JSON.parse(input.options!) as Exclude<ReturnType<typeof searchAnalyticsOptions>, string>;
      const result = await providerJson(siteUrl(input.site!, "/searchAnalytics/query"), { method: "POST",
        headers: googleHeaders(credentials, "Google Search Console"), json: { startDate: options.startDate, endDate: options.endDate,
          dimensions: options.dimensions, rowLimit: options.rowLimit, type: options.type } });
      if (result.rows !== undefined && !Array.isArray(result.rows)) {
        throw new ProviderRequestError(502, "Google did not return Search Analytics rows");
      }
      const rows = (result.rows as unknown[] | undefined) ?? [];
      const lines = [[...options.dimensions, "clicks", "impressions", "ctr", "position"].join("\t"),
        ...rows.slice(0, options.rowLimit).map(value => {
          const row = record(value);
          const keys = Array.isArray(row.keys) ? row.keys.map(cell) : [];
          return [...keys, Number(row.clicks ?? 0), Number(row.impressions ?? 0),
            `${(Number(row.ctr ?? 0) * 100).toFixed(2)}%`, Number(row.position ?? 0).toFixed(1)].join("\t");
        })];
      return { summary: `Search performance for ${input.site} (${options.type}, ${options.startDate} to ${options.endDate} UTC; ` +
        `by ${options.dimensions.join(", ") || "total"}; Google's data lags about two to three days):\n` +
        quoteRetrievedText(rows.length ? lines.join("\n") : "(no data for this range)") };
    },
  },
  list_sitemaps: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => siteOnly(statement, "name a property: sc-domain:example.com or https://www.example.com/"),
    async execute({ credentials }, input) {
      const result = await providerJson(siteUrl(input.site!, "/sitemaps"), { headers: googleHeaders(credentials, "Google Search Console") });
      if (result.sitemap !== undefined && !Array.isArray(result.sitemap)) {
        throw new ProviderRequestError(502, "Google did not return a sitemap list");
      }
      const sitemaps = (result.sitemap as unknown[] | undefined) ?? [];
      const lines = ["path\tlast submitted\tlast downloaded\tpending\terrors\twarnings\tsubmitted/indexed",
        ...sitemaps.slice(0, MAX_LINES).map(value => {
          const sitemap = record(value);
          const contents = Array.isArray(sitemap.contents) ? sitemap.contents.map(item => {
            const content = record(item);
            return `${cell(content.type)} ${cell(content.submitted)}/${cell(content.indexed ?? "-")}`;
          }).join(", ") : "";
          return [cell(sitemap.path), cell(sitemap.lastSubmitted), cell(sitemap.lastDownloaded), cell(sitemap.isPending),
            cell(sitemap.errors), cell(sitemap.warnings), contents].join("\t");
        })];
      return { summary: `Sitemaps for ${input.site}:\n` + quoteRetrievedText(sitemaps.length ? lines.join("\n") : "(no sitemaps submitted)") };
    },
  },
  inspect_url: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => siteAndPage(statement, "name a property and a page inside it: <property> <page url>"),
    async execute({ credentials }, input) {
      const result = await providerJson(INSPECT, { method: "POST", headers: googleHeaders(credentials, "Google Search Console"),
        json: { inspectionUrl: input.page, siteUrl: input.site } });
      const status = record(record(result.inspectionResult).indexStatusResult);
      if (typeof status.verdict !== "string") throw new ProviderRequestError(502, "Google did not return an index status");
      const fields = ["verdict", "coverageState", "indexingState", "robotsTxtState", "pageFetchState", "lastCrawlTime",
        "crawledAs", "googleCanonical", "userCanonical"];
      const lines = fields.filter(field => status[field] !== undefined).map(field => `${field}: ${cell(status[field])}`);
      return { summary: `URL inspection for ${input.page} in ${input.site}:\n` + quoteRetrievedText(lines.join("\n")) };
    },
  },
  submit_sitemap: {
    effect: "write", requires: ["oauthToken"],
    parse: statement => siteAndPage(statement, "name a property and a sitemap URL inside it: <property> <sitemap url>"),
    async execute({ credentials }, input) {
      await providerJson(siteUrl(input.site!, `/sitemaps/${encodeURIComponent(input.page!)}`), { method: "PUT",
        headers: googleHeaders(credentials, "Google Search Console") });
      return { summary: `Submitted sitemap ${input.page} to ${input.site}; Google fetches it asynchronously.` };
    },
  },
};

/** Confirm the grant with a real read; the property list is not stored. */
export async function verifyGoogleSearchConsole(credentials: Readonly<Record<string, string>>): Promise<void> {
  const result = await providerJson(`${API}/sites`, { headers: googleHeaders(credentials, "Google Search Console") });
  if (result.siteEntry !== undefined && !Array.isArray(result.siteEntry)) {
    throw new ProviderRequestError(502, "Google did not confirm Search Console access");
  }
}
