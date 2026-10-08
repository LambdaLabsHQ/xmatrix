/**
 * Search in one Space: what is being looked for (text plus the `in:` and
 * `from:` filters), how that is written into the results page's address, and
 * the searches a reader ran recently. Pure; no React.
 */
import type { AppView } from "./workspace-shell-navigation";

/** Who wrote it: a person by user id, an Agent by name (its Instances share no author id). */
export type SearchAuthor =
  | { kind: "user"; userId: string; label: string }
  | { kind: "agent"; name: string; label: string };

export type SearchFilters = {
  /** Only this conversation and its threads. */
  channel?: { id: string; label: string };
  from?: SearchAuthor;
};

export type SearchRequest = SearchFilters & { text: string };

export function searchHasFilters(filters: SearchFilters): boolean {
  return Boolean(filters.channel || filters.from);
}

/** A search the Hub can run: some text, or a filter on its own. */
export function searchIsRunnable(request: SearchRequest): boolean {
  return Boolean(request.text.trim()) || searchHasFilters(request);
}

/** The Hub's `from=` value. */
export function searchAuthorParam(author: SearchAuthor): string {
  return author.kind === "user" ? `user:${author.userId}` : `agent:${author.name}`;
}

/** The results page's query string; labels ride along so a shared link reads the same. */
export function searchRequestParams(request: SearchRequest): URLSearchParams {
  const params = new URLSearchParams();
  const text = request.text.trim();
  if (text) params.set("q", text);
  if (request.channel) {
    params.set("in", request.channel.id);
    params.set("inLabel", request.channel.label);
  }
  if (request.from) {
    params.set("from", searchAuthorParam(request.from));
    params.set("fromLabel", request.from.label);
  }
  return params;
}

/** The reverse of `searchRequestParams`. */
export function searchRequestFromParams(params: URLSearchParams): SearchRequest {
  const request: SearchRequest = { text: params.get("q")?.trim() ?? "" };
  const channelId = params.get("in")?.trim();
  if (channelId) request.channel = { id: channelId, label: params.get("inLabel")?.trim() || channelId };
  const from = params.get("from")?.trim() ?? "";
  const at = from.indexOf(":");
  const id = from.slice(at + 1).trim();
  const label = params.get("fromLabel")?.trim() || id;
  if (at > 0 && id) {
    const kind = from.slice(0, at);
    if (kind === "user") request.from = { kind, userId: id, label };
    if (kind === "agent") request.from = { kind, name: id, label };
  }
  return request;
}

export function searchRequestKey(request: SearchRequest): string {
  return searchRequestParams(request).toString();
}

/** How a search reads in one line: `deploy in #general from Yiming`. */
export function searchRequestLabel(request: SearchRequest): string {
  return [
    request.text.trim() ? `“${request.text.trim()}”` : "",
    request.channel ? `in #${request.channel.label}` : "",
    request.from ? `from ${request.from.label}` : "",
  ].filter(Boolean).join(" ");
}

const RECENT_SEARCHES_PREFIX = "xmatrix:recent-searches:";
const RECENT_SEARCHES_LIMIT = 6;

/** The reader's recent searches in this Space, newest first. Kept on this device only. */
export function readRecentSearches(spaceId: string | null): SearchRequest[] {
  if (!spaceId || typeof window === "undefined") return [];
  try {
    const stored = JSON.parse(window.localStorage.getItem(`${RECENT_SEARCHES_PREFIX}${spaceId}`) ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored
      .filter((item): item is string => typeof item === "string")
      .map((item) => searchRequestFromParams(new URLSearchParams(item)))
      .filter(searchIsRunnable);
  } catch {
    return [];
  }
}

export function rememberRecentSearch(spaceId: string | null, request: SearchRequest): void {
  if (!spaceId || typeof window === "undefined" || !searchIsRunnable(request)) return;
  const key = searchRequestKey(request);
  const next = [key, ...readRecentSearches(spaceId).map(searchRequestKey).filter((item) => item !== key)]
    .slice(0, RECENT_SEARCHES_LIMIT);
  window.localStorage.setItem(`${RECENT_SEARCHES_PREFIX}${spaceId}`, JSON.stringify(next));
}

/**
 * Places in the app search can open by name, so no destination needs to be
 * found on the rail first.
 */
export const SEARCH_DESTINATIONS: ReadonlyArray<{ view: AppView; label: string; keywords: string }> = [
  { view: "pages", label: "Pages", keywords: "pages docs documents" },
  { view: "messages", label: "Channels", keywords: "channels conversations messages" },
  { view: "status", label: "Status", keywords: "status overview" },
  { view: "agents", label: "Agents", keywords: "agents harness runtime" },
  { view: "machines", label: "Machines", keywords: "machines computers daemons" },
  { view: "automation", label: "Schedules", keywords: "schedules automations cron" },
  { view: "apps", label: "Apps", keywords: "apps connectors integrations github" },
  { view: "team", label: "Team", keywords: "team members people invite roles" },
  { view: "activity", label: "Activity", keywords: "activity events" },
  { view: "settings", label: "Settings", keywords: "settings preferences secrets appearance" },
];

export function matchingSearchDestinations(text: string): typeof SEARCH_DESTINATIONS {
  const needle = text.trim().toLowerCase();
  if (!needle) return [];
  return SEARCH_DESTINATIONS.filter((destination) =>
    destination.label.toLowerCase().startsWith(needle) ||
    destination.keywords.split(" ").some((word) => word.startsWith(needle)));
}

/** Splits text around every case-insensitive occurrence of `needle`, for highlighting. */
export function searchHighlightParts(text: string, needle: string): Array<{ text: string; match: boolean }> {
  const wanted = needle.trim().toLocaleLowerCase();
  if (!wanted) return [{ text, match: false }];
  const lower = text.toLocaleLowerCase();
  const parts: Array<{ text: string; match: boolean }> = [];
  let from = 0;
  for (let at = lower.indexOf(wanted); at >= 0; at = lower.indexOf(wanted, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + wanted.length), match: true });
    from = at + wanted.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
