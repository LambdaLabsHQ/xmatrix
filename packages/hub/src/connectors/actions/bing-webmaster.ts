import { providerJson, ProviderRequestError } from "../http";
import { record } from "../command-support";
import type { ConnectorAction } from "../provider";
import type { ProviderEgress } from "../provider-egress";
import { cell } from "./google-report";
import { pageUrl } from "./google-search-console-site";
import { quoteRetrievedText } from "./common";

/*
 * Bing Webmaster Tools (JSON API) and IndexNow. The Bing credential is the
 * sign-in's OAuth access token, sent as a bearer token, or else the account's
 * API key from Settings → API access, which Bing accepts only as the `apikey`
 * query parameter, so request URLs are never echoed into a summary or an error. A site is the exact URL Bing lists for it (`https://example.com/`).
 * When the deployment configures a relay (`deploy/bing-relay`), Bing calls go
 * through it, because Bing throttles Cloudflare's egress addresses; the key
 * then travels as a header and the relay adds it for Bing.
 * IndexNow needs the site's own key, which the site must publish at
 * `https://<host>/<key>.txt`; it tells Bing, Yandex, Naver, Seznam and others.
 */

const BING = "https://ssl.bing.com";
const API_PATH = "/webmaster/api.svc/json";
const INDEXNOW = "https://api.indexnow.org/indexnow";
const MAX_ROWS = 50;
const MAX_URLS = 100;

type BingAuth = { token: string } | { key: string };

/** The sign-in's access token when there is one, else the saved API key. */
function bingAuth(credentials: Readonly<Record<string, string>>): BingAuth {
  const token = credentials.oauthToken?.trim();
  if (token) {
    if (token.length > 4096 || /[\s"\\]/u.test(token)) throw new ProviderRequestError(401, "Sign in to Bing Webmaster Tools again");
    return { token };
  }
  const key = credentials.apiKey?.trim();
  if (!key || key.length > 200 || !/^[A-Za-z0-9]+$/u.test(key)) throw new ProviderRequestError(401, "Sign in to Bing Webmaster Tools or save an API key first");
  return { key };
}

const describeError = (payload: Record<string, unknown>) => typeof payload.Message === "string" ? payload.Message.replace(/^ERROR!+\s*/u, "") : undefined;

/** One Bing method; the reply's `d` member is the answer. */
async function bing(credentials: Readonly<Record<string, string>>, egress: ProviderEgress | undefined, method: string,
  query: Record<string, string> = {}, json?: unknown): Promise<unknown> {
  const auth = bingAuth(credentials);
  const url = new URL(`${API_PATH}/${method}`, egress?.origin ?? BING);
  if (!egress && "key" in auth) url.searchParams.set("apikey", auth.key);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  // Through the relay, its own token takes `authorization`; Bing's credential rides in its own header.
  const headers: Record<string, string> = {};
  if ("token" in auth) headers[egress ? "x-bing-authorization" : "authorization"] = `Bearer ${auth.token}`;
  else if (egress) headers["x-bing-apikey"] = auth.key;
  if (egress) headers.authorization = `Bearer ${egress.token}`;
  const result = await providerJson(url, { ...(json === undefined ? {} : { method: "POST", json }), headers, describeError });
  return result.d;
}

/** A site exactly as Bing lists it: an http(s) address ending in `/`, without query. */
export function bingSite(target: string): string | undefined {
  const url = pageUrl(target);
  return url && !url.search && url.pathname.endsWith("/") && url.href === target ? target : undefined;
}

/** Bing's `/Date(1696118400000-0700)/` as a UTC day. */
function bingDate(value: unknown): string {
  const match = String(value ?? "").match(/^\/Date\((-?\d{1,15})(?:[+-]\d{4})?\)\/$/u);
  return match ? new Date(Number(match[1])).toISOString().slice(0, 10) : cell(value);
}

function rows(value: unknown, what: string): Record<string, unknown>[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ProviderRequestError(502, `Bing did not return ${what}`);
  return value.map(record);
}

/** `<site> <url> [<url> …]`: every URL inside the site, at most 100. */
export function siteUrls(statement: { target: string; text: string }): Record<string, string> | string {
  const usage = `name a site and up to ${MAX_URLS} of its URLs: <https://example.com/> <https://example.com/page> …`;
  const site = bingSite(statement.target);
  const words = statement.text.trim().split(/\s+/u).filter(Boolean);
  if (!site || !words.length || words.length > MAX_URLS) return usage;
  const host = new URL(site).hostname;
  const urls = words.map(pageUrl);
  if (urls.some(url => !url || url.hostname !== host || !url.href.startsWith(site))) return usage;
  return { site, urls: JSON.stringify([...new Set(urls.map(url => url!.href))]) };
}

function siteOnly(statement: { target: string; text: string }): Record<string, string> | string {
  const site = bingSite(statement.target);
  return site && !statement.text.trim() ? { site } : "name a site exactly as Bing lists it: https://example.com/";
}

function table(header: string, lines: string[], empty: string): string {
  return quoteRetrievedText(lines.length ? [header, ...lines].join("\n") : empty);
}

export const BING_WEBMASTER_ACTIONS: Record<string, ConnectorAction> = {
  list_sites: {
    effect: "read", requires: ["oauthToken|apiKey"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @bingwebmaster:list_sites:*",
    async execute({ credentials, egress }) {
      const sites = rows(await bing(credentials, egress, "GetUserSites"), "a site list");
      const lines = sites.slice(0, 250).map(site => [cell(site.Url), site.IsVerified === true ? "verified" : "not verified"].join("\t"));
      return { summary: "Bing Webmaster sites:\n" + table("site\tverification", lines, "(no sites for this account)") };
    },
  },
  traffic: {
    effect: "read", requires: ["oauthToken|apiKey"],
    parse: siteOnly,
    async execute({ credentials, egress }, input) {
      const days = rows(await bing(credentials, egress, "GetRankAndTrafficStats", { siteUrl: input.site! }), "traffic statistics");
      const lines = days.map(day => ({ date: bingDate(day.Date), clicks: Number(day.Clicks ?? 0), impressions: Number(day.Impressions ?? 0) }))
        .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30)
        .map(day => [day.date, day.clicks, day.impressions].join("\t"));
      return { summary: `Bing search traffic for ${input.site} (newest 30 days Bing reports):\n` + table("date\tclicks\timpressions", lines, "(no traffic data)") };
    },
  },
  ...Object.fromEntries((["queries", "pages"] as const).map(kind => [kind, {
    effect: "read", requires: ["oauthToken|apiKey"],
    parse: siteOnly,
    async execute({ credentials, egress }, input) {
      const method = kind === "queries" ? "GetQueryStats" : "GetPageStats";
      const stats = rows(await bing(credentials, egress, method, { siteUrl: input.site! }), `${kind} statistics`);
      const lines = stats.sort((a, b) => Number(b.Clicks ?? 0) - Number(a.Clicks ?? 0)).slice(0, MAX_ROWS).map(row => [cell(row.Query),
        Number(row.Clicks ?? 0), Number(row.Impressions ?? 0), Number(row.AvgClickPosition ?? 0) > 0 ? Number(row.AvgClickPosition).toFixed(1) : "-",
        Number(row.AvgImpressionPosition ?? 0) > 0 ? Number(row.AvgImpressionPosition).toFixed(1) : "-"].join("\t"));
      return { summary: `Top Bing ${kind} for ${input.site} by clicks (Bing's recent reporting window):\n` +
        table(`${kind === "queries" ? "query" : "page"}\tclicks\timpressions\tavg click position\tavg impression position`, lines, "(no data)") };
    },
  } satisfies ConnectorAction])),
  crawl_stats: {
    effect: "read", requires: ["oauthToken|apiKey"],
    parse: siteOnly,
    async execute({ credentials, egress }, input) {
      const days = rows(await bing(credentials, egress, "GetCrawlStats", { siteUrl: input.site! }), "crawl statistics");
      const fields = ["CrawledPages", "InIndex", "CrawlErrors", "Code4xx", "Code5xx", "BlockedByRobotsTxt", "ConnectionTimeout", "DnsFailures"];
      const lines = days.map(day => ({ date: bingDate(day.Date), day })).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14)
        .map(({ date, day }) => [date, ...fields.map(field => Number(day[field] ?? 0))].join("\t"));
      return { summary: `Bing crawl statistics for ${input.site} (newest 14 days):\n` +
        table(["date", ...fields].join("\t"), lines, "(no crawl data)") };
    },
  },
  submit_urls: {
    effect: "write", requires: ["oauthToken|apiKey"],
    parse: siteUrls,
    async execute({ credentials, egress }, input) {
      const urls = JSON.parse(input.urls!) as string[];
      await bing(credentials, egress, "SubmitUrlBatch", {}, { siteUrl: input.site, urlList: urls });
      const quota = record(await bing(credentials, egress, "GetUrlSubmissionQuota", { siteUrl: input.site! }));
      return { summary: `Submitted ${urls.length} URL(s) of ${input.site} to Bing; Bing crawls them asynchronously. ` +
        `Remaining quota today: ${cell(quota.DailyQuota ?? "?")}, this month: ${cell(quota.MonthlyQuota ?? "?")}.` };
    },
  },
  submit_sitemap: {
    effect: "write", requires: ["oauthToken|apiKey"],
    parse(statement) {
      const parsed = siteUrls(statement);
      return typeof parsed !== "string" && (JSON.parse(parsed.urls!) as string[]).length === 1
        ? { site: parsed.site!, feed: (JSON.parse(parsed.urls!) as string[])[0]! } : "name a site and one sitemap URL inside it: <https://example.com/> <https://example.com/sitemap.xml>";
    },
    async execute({ credentials, egress }, input) {
      await bing(credentials, egress, "SubmitFeed", {}, { siteUrl: input.site, feedUrl: input.feed });
      return { summary: `Submitted sitemap ${input.feed} to Bing for ${input.site}; Bing fetches it asynchronously.` };
    },
  },
  indexnow: {
    effect: "write", requires: ["indexNowKey"],
    parse: siteUrls,
    async execute({ credentials }, input) {
      const key = credentials.indexNowKey?.trim();
      if (!key || !/^[A-Za-z0-9-]{8,128}$/u.test(key)) throw new ProviderRequestError(401, "Save the site's IndexNow key (8-128 letters, digits or dashes) first");
      const urls = JSON.parse(input.urls!) as string[];
      const host = new URL(input.site!).hostname;
      await providerJson(INDEXNOW, { method: "POST", json: { host, key, keyLocation: `${new URL(input.site!).origin}/${key}.txt`, urlList: urls } });
      return { summary: `Sent ${urls.length} URL(s) of ${host} to IndexNow (Bing, Yandex, Naver, Seznam and other participating engines). ` +
        "Engines fetch the key file to confirm ownership, then crawl at their own pace." };
    },
  },
};

/** Confirm the key with a real read; the site list is not stored. */
export async function verifyBingWebmaster(credentials: Readonly<Record<string, string>>, _meter?: unknown, egress?: ProviderEgress): Promise<void> {
  if (!credentials.apiKey && !credentials.oauthToken) return;
  rows(await bing(credentials, egress, "GetUserSites"), "a site list for this account");
}
