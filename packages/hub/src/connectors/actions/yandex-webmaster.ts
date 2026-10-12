import { quoteRetrievedText } from "./common";
import { cell } from "./google-report";
import { pageUrl } from "./google-search-console-site";
import type { ConnectorAction } from "../provider";
import { providerJson, ProviderRequestError } from "../http";
import { record } from "../command-support";

/*
 * Yandex Webmaster API v4. The credential is an OAuth token of the Yandex
 * account with the `webmaster:hostinfo` (and, for recrawl, `webmaster:verify`)
 * permissions, sent as `Authorization: OAuth <token>`. A host is Yandex's id,
 * `https:example.com:443`; every call first reads the token's user id.
 */

const API = "https://api.webmaster.yandex.net/v4";
const HOST = /^(https?):((?=.{1,253}:)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}):(\d{1,5})$/u;
const MAX_ROWS = 50;

function headers(credentials: Readonly<Record<string, string>>): Record<string, string> {
  const token = credentials.token?.trim();
  if (!token || token.length > 512 || !/^[A-Za-z0-9._-]+$/u.test(token)) throw new ProviderRequestError(401, "Save a Yandex OAuth token first");
  return { authorization: `OAuth ${token}` };
}

const describeError = (payload: Record<string, unknown>) =>
  [payload.error_code, payload.error_message].filter(value => typeof value === "string").join(": ") || undefined;

async function yandex(credentials: Readonly<Record<string, string>>, path: string, json?: unknown): Promise<Record<string, unknown>> {
  return providerJson(`${API}${path}`, { headers: headers(credentials), describeError, ...(json === undefined ? {} : { method: "POST", json }) });
}

/** The connected account's user id, which prefixes every host path. */
async function userPath(credentials: Readonly<Record<string, string>>): Promise<string> {
  const id = (await yandex(credentials, "/user")).user_id;
  if (!Number.isSafeInteger(id) || Number(id) <= 0) throw new ProviderRequestError(502, "Yandex did not return the token's user");
  return `/user/${id}`;
}

/** `https:example.com:443`, Yandex's host id. */
export function yandexHost(target: string): string | undefined {
  const match = target.match(HOST);
  return match && Number(match[3]) <= 65_535 ? target : undefined;
}

function hostOnly(statement: { target: string; text: string }): Record<string, string> | string {
  const host = yandexHost(statement.target);
  return host && !statement.text.trim() ? { host } : "name a host as Yandex lists it: https:example.com:443";
}

export const YANDEX_WEBMASTER_ACTIONS: Record<string, ConnectorAction> = {
  list_hosts: {
    effect: "read", requires: ["token"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @yandexwebmaster:list_hosts:*",
    async execute({ credentials }) {
      const result = await yandex(credentials, `${await userPath(credentials)}/hosts`);
      if (!Array.isArray(result.hosts)) throw new ProviderRequestError(502, "Yandex did not return a host list");
      const lines = result.hosts.slice(0, 250).map(value => {
        const host = record(value);
        return [cell(host.host_id), cell(host.ascii_host_url), host.verified === true ? "verified" : "not verified",
          host.main_mirror ? `mirror of ${cell(record(host.main_mirror).host_id)}` : ""].join("\t");
      });
      return { summary: "Yandex Webmaster hosts (host id, address, verification):\n" +
        quoteRetrievedText(lines.join("\n") || "(no hosts for this Yandex account)") };
    },
  },
  summary: {
    effect: "read", requires: ["token"],
    parse: hostOnly,
    async execute({ credentials }, input) {
      const result = await yandex(credentials, `${await userPath(credentials)}/hosts/${encodeURIComponent(input.host!)}/summary`);
      if (result.searchable_pages_count === undefined && result.sqi === undefined) throw new ProviderRequestError(502, "Yandex did not return a host summary");
      const problems = record(result.site_problems);
      const lines = [`site quality index (SQI): ${cell(result.sqi)}`, `pages in search: ${cell(result.searchable_pages_count)}`,
        `excluded pages: ${cell(result.excluded_pages_count)}`,
        `problems: ${["FATAL", "CRITICAL", "POSSIBLE_PROBLEM", "RECOMMENDATION"].map(level => `${level.toLowerCase()} ${Number(problems[level] ?? 0)}`).join(", ")}`];
      return { summary: `Yandex summary for ${input.host}:\n` + quoteRetrievedText(lines.join("\n")) };
    },
  },
  queries: {
    effect: "read", requires: ["token"],
    parse: hostOnly,
    async execute({ credentials }, input) {
      const indicators = ["TOTAL_SHOWS", "TOTAL_CLICKS", "AVG_SHOW_POSITION", "AVG_CLICK_POSITION"];
      const query = new URLSearchParams({ order_by: "TOTAL_CLICKS", limit: String(MAX_ROWS) });
      for (const indicator of indicators) query.append("query_indicator", indicator);
      const result = await yandex(credentials, `${await userPath(credentials)}/hosts/${encodeURIComponent(input.host!)}/search-queries/popular?${query}`);
      if (!Array.isArray(result.queries)) throw new ProviderRequestError(502, "Yandex did not return search queries");
      const lines = result.queries.map(value => {
        const row = record(value);
        const numbers = record(row.indicators);
        return [cell(row.query_text), ...indicators.map(name => {
          const number = numbers[name] === null || numbers[name] === undefined ? NaN : Number(numbers[name]);
          return Number.isFinite(number) ? (name.startsWith("AVG") ? number.toFixed(1) : String(number)) : "-";
        })].join("\t");
      });
      return { summary: `Top Yandex queries for ${input.host} by clicks, ${cell(result.date_from)} to ${cell(result.date_to)}:\n` +
        quoteRetrievedText(lines.length ? ["query\tshows\tclicks\tavg show position\tavg click position", ...lines].join("\n") : "(no data)") };
    },
  },
  recrawl: {
    effect: "write", requires: ["token"],
    parse(statement) {
      const usage = "name a host and one page inside it: <https:example.com:443> <https://example.com/page>";
      const host = yandexHost(statement.target)?.match(HOST);
      const page = pageUrl(statement.text.trim());
      return host && page && page.protocol === `${host[1]}:` && page.hostname === host[2] && (page.port || (host[1] === "https" ? "443" : "80")) === host[3]
        ? { host: statement.target, page: page.href } : usage;
    },
    async execute({ credentials }, input) {
      const result = await yandex(credentials, `${await userPath(credentials)}/hosts/${encodeURIComponent(input.host!)}/recrawl/queue`, { url: input.page });
      return { summary: `Queued ${input.page} for Yandex recrawl${result.quota_remainder !== undefined ? `; ${cell(result.quota_remainder)} recrawls left today` : ""}.` };
    },
  },
};

/** Confirm the token with a real read; the user id is not stored. */
export async function verifyYandexWebmaster(credentials: Readonly<Record<string, string>>): Promise<void> {
  await userPath(credentials);
}
