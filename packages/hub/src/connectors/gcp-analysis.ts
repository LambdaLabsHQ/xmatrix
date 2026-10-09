import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { ProviderRequestError } from "./http";
import { record } from "./event-format";
import { GCP_PROJECT, PAGE_SIZE, columns, list, optionsJson, project, report, request } from "./gcp-common";

const SKU = /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/u;
const API_SERVICE = /^(?:generativelanguage|aiplatform|run)\.googleapis\.com$/u;

export function usageOptions(statement: ConnectorActionStatement, retentionDays = 90): Record<string, string> | string {
  const target = project(statement);
  if (typeof target === "string") return target;
  if (/^[0-9]/u.test(target.project)) return "API usage requires a project ID, not a project number";
  const raw = optionsJson(statement, ["from", "to", "apiService", "responseClass", "pageToken", "groupBy"]);
  if (typeof raw === "string") return raw;
  const timestamp = (value: unknown) => typeof value === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value;
  if (!timestamp(raw.from) || !timestamp(raw.to)) return "from/to must be UTC RFC3339 timestamps, to exclusive";
  const from = Date.parse(String(raw.from));
  const to = Date.parse(String(raw.to));
  if (from < Date.now() - retentionDays * 86_400_000 || to > Date.now() || to <= from || to - from > 31 * 86_400_000) return `use a completed interval up to 31 days within the last ${retentionDays} days`;
  const apiService = raw.apiService ?? "generativelanguage.googleapis.com";
  if (typeof apiService !== "string" || !API_SERVICE.test(apiService)) return "apiService must be generativelanguage, aiplatform or run.googleapis.com";
  const responseClass = raw.responseClass ?? "all";
  if (typeof responseClass !== "string" || !["all", "2xx", "4xx", "5xx"].includes(responseClass)) return "responseClass must be all, 2xx, 4xx or 5xx";
  const groupBy = raw.groupBy ?? "day";
  if (typeof groupBy !== "string" || !["day", "credential", "credential_method"].includes(groupBy)) return "groupBy must be day, credential or credential_method";
  if (groupBy !== "day" && to - from < 60_000) return "credential grouping requires an interval of at least 60 seconds";
  if (raw.pageToken !== undefined && (typeof raw.pageToken !== "string" || raw.pageToken.length > 2_000 || /\s/u.test(raw.pageToken))) return "pageToken must be a bounded Google continuation token";
  return { ...target, from: String(raw.from), to: String(raw.to), apiService, responseClass, groupBy,
    ...(raw.pageToken ? { pageToken: String(raw.pageToken) } : {}) };
}

export const GCP_ANALYSIS_ACTIONS: Record<string, ConnectorAction> = {
  read_sku: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => {
      const parts = statement.target.split("/");
      return !statement.text.trim() && parts.length === 2 && GCP_PROJECT.test(parts[0]!) && SKU.test(parts[1]!)
        ? { project: parts[0]!, sku: parts[1]! } : "use <quota-project>/<SKU-ID>, e.g. my-project/ABCD-1234-5678";
    },
    async execute({ credentials }, input) {
      const name = `skus/${input.sku}`;
      const result = await request(credentials, `https://cloudbilling.googleapis.com/v2beta/${name}`, undefined, input.project);
      if (result.name !== name || result.skuId !== input.sku) throw new ProviderRequestError(502, "Google Cloud did not return the requested SKU");
      return report("Public billing SKU metadata (NOT usage or account prices)", [columns("SKU", result.skuId),
        columns("Description", result.displayName), columns("Service", result.service),
        columns("Categories", JSON.stringify(record(result.productTaxonomy).taxonomyCategories ?? [])),
        "Quota uses the named project and the same connected OAuth identity; Google requires serviceusage.services.use and an enabled Cloud Billing API."], {});
    },
  },
  query_api_usage: {
    effect: "read", requires: ["oauthToken"], parse: statement => usageOptions(statement),
    async execute({ credentials }, input) {
      const filter = ['metric.type = "serviceruntime.googleapis.com/api/request_count"', 'resource.type = "consumed_api"',
        `resource.labels.project_id = ${JSON.stringify(input.project)}`,
        `resource.labels.service = ${JSON.stringify(input.apiService)}`];
      if (input.responseClass !== "all") filter.push(`metric.labels.response_code_class = ${JSON.stringify(input.responseClass)}`);
      const url = new URL(`https://monitoring.googleapis.com/v3/projects/${input.project}/timeSeries`);
      url.search = new URLSearchParams({ filter: filter.join(" AND "), view: "FULL", pageSize: String(PAGE_SIZE),
        "interval.startTime": input.from!, "interval.endTime": input.to!, "aggregation.alignmentPeriod": input.groupBy === "day" ? "86400s" : `${(Date.parse(input.to!) - Date.parse(input.from!)) / 1000}s`,
        "aggregation.perSeriesAligner": "ALIGN_SUM", "aggregation.crossSeriesReducer": "REDUCE_SUM",
        ...(input.pageToken ? { pageToken: input.pageToken } : {}) }).toString();
      if (input.groupBy !== "day") url.searchParams.append("aggregation.groupByFields", "resource.labels.credential_id");
      if (input.groupBy === "credential_method") url.searchParams.append("aggregation.groupByFields", "resource.labels.method");
      const result = await request(credentials, url, undefined, input.project);
      const rows: string[] = [columns("Project", input.project), columns("API", input.apiService), columns("Response class", input.responseClass),
        input.groupBy === "day" ? "UTC interval start\tUTC interval end\tAPI request count" : "Credential ID\tMethod\tUTC interval start\tUTC interval end\tAPI request count"];
      let count = 0;
      for (const value of list(result, "timeSeries")) {
        const labels = record(record(record(value).resource).labels);
        const points = record(value).points;
        if (points !== undefined && !Array.isArray(points)) throw new ProviderRequestError(502, "Google Cloud returned malformed usage points");
        for (const item of Array.isArray(points) ? points : []) {
          const point = record(item);
          const interval = record(point.interval);
          const sample = record(point.value).int64Value;
          if (typeof sample !== "string" || !/^[0-9]{1,20}$/u.test(sample)) throw new ProviderRequestError(502, "Google Cloud returned malformed usage counts");
          if (count++ < PAGE_SIZE) rows.push(input.groupBy === "day" ? columns(interval.startTime, interval.endTime, sample) :
            columns(labels.credential_id ?? "(unattributed)", input.groupBy === "credential_method" ? labels.method ?? "(unknown)" : "(all methods)", interval.startTime, interval.endTime, sample));
        }
      }
      if (!count) rows.push("No returned usage points; absence does not establish zero requests.");
      if (result.nextPageToken) rows.push(columns("Next pageToken", result.nextPageToken));
      if (count > PAGE_SIZE || result.nextPageToken) rows.push("This page is incomplete; do not sum it as the complete interval.");
      rows.push(input.groupBy === "day" ? "Counts sum API calls across methods and credentials; not billable tokens or application users. Daily alignment uses the returned UTC intervals, which differ from Pacific billing days." :
        "Credential IDs identify API keys or OAuth clients, not people, programs or models. These are request counts, not per-credential billed costs. Preserve returned intervals and continuation before comparing totals.");
      return report(`Aggregated API request usage${count > PAGE_SIZE ? " (truncated; first 30 points only)" : ""}`, rows, result);
    },
  },
};
