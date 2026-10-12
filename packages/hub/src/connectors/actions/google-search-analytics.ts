import { record } from "../command-support";

const DIMENSIONS = new Set(["query", "page", "country", "device", "date", "hour", "searchAppearance"]);
const FILTER_DIMENSIONS = new Set(["query", "page", "country", "device", "searchAppearance"]);
const OPERATORS = new Set(["contains", "equals", "notContains", "notEquals", "includingRegex", "excludingRegex"]);
const SEARCH_TYPES = new Set(["web", "image", "video", "news", "discover", "googleNews"]);
const AGGREGATIONS = new Set(["auto", "byPage", "byProperty", "byNewsShowcasePanel"]);
const STATES = new Set(["final", "all", "hourly_all"]);
const DAY_MS = 86_400_000;

type Filter = { dimension: string; operator?: string; expression: string };
interface AnalyticsOptions {
  dimensions: string[]; startDate: string; endDate: string; rowLimit: number; type: string;
  startRow?: number; aggregationType?: string; dataState?: string;
  dimensionFilterGroups?: { groupType?: string; filters: Filter[] }[];
}

function dateMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined;
}

/** Bounded API JSON supports filters, offsets, explicit dates, aggregation and hourly data. */
function jsonOptions(text: string): AnalyticsOptions | string {
  if (text.length > 24_000) return "query JSON is limited to 24000 characters";
  let value: Record<string, unknown>;
  try { value = record(JSON.parse(text)); } catch { return "query options must be a JSON object"; }
  const keys = new Set(["startDate", "endDate", "dimensions", "type", "rowLimit", "startRow", "aggregationType", "dataState", "dimensionFilterGroups"]);
  if (Object.keys(value).some(key => !keys.has(key))) return "unknown Search Analytics JSON field";
  const start = dateMs(value.startDate), end = dateMs(value.endDate);
  if (start === undefined || end === undefined || start > end || end - start >= 480 * DAY_MS) return "supply real startDate/endDate dates spanning 1-480 days (Pacific Time)";
  const dimensions = value.dimensions ?? [];
  if (!Array.isArray(dimensions) || dimensions.some(d => typeof d !== "string" || !DIMENSIONS.has(d)) || new Set(dimensions).size !== dimensions.length) return "dimensions must be distinct supported dimensions";
  const rowLimit = value.rowLimit ?? 25;
  if (!Number.isSafeInteger(rowLimit) || Number(rowLimit) < 1 || Number(rowLimit) > 250) return "rowLimit is 1-250; page through rows with startRow";
  if (value.startRow !== undefined && (!Number.isSafeInteger(value.startRow) || Number(value.startRow) < 0 || Number(value.startRow) > 2_147_483_647)) return "startRow must be a nonnegative 32-bit integer";
  if (!SEARCH_TYPES.has(String(value.type ?? "web")) || (value.aggregationType !== undefined && !AGGREGATIONS.has(String(value.aggregationType))) ||
      (value.dataState !== undefined && !STATES.has(String(value.dataState)))) return "invalid type, aggregationType or dataState";
  if (value.dimensionFilterGroups !== undefined) {
    if (!Array.isArray(value.dimensionFilterGroups) || value.dimensionFilterGroups.length > 10) return "supply at most 10 filter groups";
    for (const item of value.dimensionFilterGroups) {
      const group = record(item);
      if (Object.keys(group).some(key => !["groupType", "filters"].includes(key)) || (group.groupType !== undefined && group.groupType !== "and") ||
          !Array.isArray(group.filters) || group.filters.length > 20) return "each filter group has groupType=and and at most 20 filters";
      for (const item of group.filters) {
        const filter = record(item);
        if (Object.keys(filter).some(key => !["dimension", "operator", "expression"].includes(key)) || !FILTER_DIMENSIONS.has(String(filter.dimension)) ||
            !OPERATORS.has(String(filter.operator ?? "equals")) || typeof filter.expression !== "string" || filter.expression.length > 4096) return "invalid dimension filter (expression is limited to 4096 characters)";
      }
    }
  }
  return { ...value, dimensions, rowLimit, type: value.type ?? "web" } as AnalyticsOptions;
}

/** Existing concise options remain compatible; JSON exposes the other API parameters. */
export function searchAnalyticsOptions(text: string, now = Date.now()): AnalyticsOptions | string {
  if (text.trim().startsWith("{")) return jsonOptions(text);
  const options: Record<string, string> = {};
  for (const word of text.trim().split(/\s+/u).filter(Boolean)) {
    const match = word.match(/^(by|days|limit|type)=(\S{1,100})$/u);
    if (!match || options[match[1]!] !== undefined) return "use by=<dimensions|none> days=<1-480> limit=<1-250> type=<search type>, or Search Analytics JSON";
    options[match[1]!] = match[2]!;
  }
  const dimensions = options.by === "none" ? [] : (options.by ?? "query").split(",");
  if (dimensions.length > 3 || new Set(dimensions).size !== dimensions.length || dimensions.some(value => !DIMENSIONS.has(value))) return `by is none or up to three of ${[...DIMENSIONS].join(", ")}; use JSON for more dimensions`;
  const days = Number(options.days ?? "28"), rowLimit = Number(options.limit ?? "25");
  if (!Number.isSafeInteger(days) || days < 1 || days > 480) return "days is a whole number from 1 to 480";
  if (!Number.isSafeInteger(rowLimit) || rowLimit < 1 || rowLimit > 250) return "limit is a whole number from 1 to 250";
  const type = options.type ?? "web";
  if (!SEARCH_TYPES.has(type)) return `type is one of ${[...SEARCH_TYPES].join(", ")}`;
  // Search Analytics dates are Pacific calendar days, not UTC days.
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  const end = Date.parse(`${part("year")}-${part("month")}-${part("day")}`);
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { dimensions, startDate: iso(end - (days - 1) * DAY_MS), endDate: iso(end), rowLimit, type };
}
