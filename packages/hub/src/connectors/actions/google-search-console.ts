import { record } from "../command-support";
import { providerJson, ProviderRequestError } from "../http";
import type { ConnectorAction } from "../provider";
import { quoteRetrievedText } from "./common";
import { pageUrl, searchConsoleSite, searchConsoleSiteContains } from "./google-search-console-site";
import { GOOGLE_SITE_VERIFICATION_ACTIONS } from "./google-site-verification";
import { searchAnalyticsOptions } from "./google-search-analytics";
import { googleHeaders } from "./google-headers";

/*
 * Google Search Console (Search Console API v1 / webmasters v3). The grant is
 * `webmasters` and `siteverification` scopes; Google decides
 * whether the connected account may read or submit for it.
 */

const API = "https://www.googleapis.com/webmasters/v3";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";
const MAX_LINES = 250;

function siteUrl(site: string, path = ""): string {
  return `${API}/sites/${encodeURIComponent(site)}${path}`;
}

function cell(value: unknown): string {
  return String(value ?? "").slice(0, 300).replace(/[\r\n\t]/gu, " ");
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
  ...GOOGLE_SITE_VERIFICATION_ACTIONS,
  ...Object.fromEntries((["get_site", "add_site", "delete_site"] as const).map(id => {
    const method = id === "get_site" ? "GET" : id === "add_site" ? "PUT" : "DELETE";
    return [id, { effect: method === "GET" ? "read" : "write", requires: ["oauthToken"],
      parse: statement => siteOnly(statement, "name an exact Search Console property"),
      async execute({ credentials }, input) {
        const result = await providerJson(siteUrl(input.site!), { method, headers: googleHeaders(credentials, "Google Search Console") });
        if (method === "GET" && (result.siteUrl !== input.site || typeof result.permissionLevel !== "string")) {
          throw new ProviderRequestError(502, "Google did not return the requested property");
        }
        return { summary: method === "GET" ? `Property ${input.site}:\n` + quoteRetrievedText(cell(result.permissionLevel)) :
          method === "PUT" ? `Added ${input.site} to the connected account; ownership verification is a separate step.` :
          `Removed ${input.site} from the connected account's Search Console property list; site content is unchanged.` };
      },
    } satisfies ConnectorAction];
  })),
  ...Object.fromEntries((["get_sitemap", "delete_sitemap"] as const).map(id => {
    const method = id === "get_sitemap" ? "GET" : "DELETE";
    return [id, { effect: method === "GET" ? "read" : "write", requires: ["oauthToken"],
      parse: statement => siteAndPage(statement, "name a property and a sitemap URL inside it"),
      async execute({ credentials }, input) {
        const result = await providerJson(siteUrl(input.site!, `/sitemaps/${encodeURIComponent(input.page!)}`), {
          method, headers: googleHeaders(credentials, "Google Search Console") });
        if (method === "GET" && result.path !== input.page) throw new ProviderRequestError(502, "Google did not return the requested sitemap");
        return { summary: method === "GET" ? `Sitemap ${input.page}:\n` + quoteRetrievedText(JSON.stringify(result), 16_000) :
          `Removed sitemap ${input.page} from ${input.site}; the sitemap file is unchanged.` };
      },
    } satisfies ConnectorAction];
  })),
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
        headers: googleHeaders(credentials, "Google Search Console"), json: options });
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
      return { summary: `Search performance for ${input.site} (${options.type}, ${options.startDate} to ${options.endDate} Pacific Time; ` +
        `by ${options.dimensions.join(", ") || "total"}; dataState=${options.dataState ?? "final"}):\n` +
        `Next startRow: ${(options.startRow ?? 0) + rows.length}; returned ${rows.length} rows; Google returns top rows, not a complete export.\n` +
        quoteRetrievedText(JSON.stringify({ responseAggregationType: result.responseAggregationType, metadata: result.metadata }) + "\n" +
          (rows.length ? lines.join("\n") : "(no data for this range)"), 16_000) };
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
    parse(statement) {
      const [page = "", language, ...extra] = statement.text.trim().split(/\s+/u);
      const input = siteAndPage({ ...statement, text: page }, "name a property and a page inside it: <property> <page url>");
      if (typeof input === "string") return input;
      if (extra.length || (language !== undefined && !/^language=[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/iu.test(language))) {
        return "optional language is language=<BCP-47 code>, for example language=en-US";
      }
      return { ...input, ...(language ? { languageCode: language.slice(9) } : {}) };
    },
    async execute({ credentials }, input) {
      const result = await providerJson(INSPECT, { method: "POST", headers: googleHeaders(credentials, "Google Search Console"),
        json: { inspectionUrl: input.page, siteUrl: input.site, ...(input.languageCode ? { languageCode: input.languageCode } : {}) } });
      const status = record(record(result.inspectionResult).indexStatusResult);
      if (typeof status.verdict !== "string") throw new ProviderRequestError(502, "Google did not return an index status");
      const fields = ["verdict", "coverageState", "indexingState", "robotsTxtState", "pageFetchState", "lastCrawlTime",
        "crawledAs", "googleCanonical", "userCanonical"];
      const lines = fields.filter(field => status[field] !== undefined).map(field => `${field}: ${cell(status[field])}`);
      return { summary: `URL inspection for ${input.page} in ${input.site}:\n` + quoteRetrievedText(lines.join("\n") +
        "\nFull inspection (including rich results and referring URLs):\n" + JSON.stringify(result.inspectionResult), 16_000) };
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

export { searchConsoleSite } from "./google-search-console-site";

export { searchAnalyticsOptions } from "./google-search-analytics";
