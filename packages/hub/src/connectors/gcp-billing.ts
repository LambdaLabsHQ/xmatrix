import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { ProviderRequestError } from "./http";
import { record, text } from "./event-format";
import { GCP_PROJECT, PAGE_SIZE, columns, list, projectOnly, report, request } from "./gcp-common";

const DATASET = /^[A-Za-z_][A-Za-z0-9_]{0,199}$/u;
const BILLING_TABLE = /^gcp_billing_export_(?:resource_)?v1_[A-Za-z0-9_]{1,100}$/u;
const LOCATION = /^(?:US|EU|[a-z]+-[a-z]+[1-9][0-9]?)$/u;
const JOB = /^[A-Za-z0-9_-]{1,200}$/u;
const GROUPS: Record<string, string> = {
  month: "FORMAT_DATE('%Y-%m', DATE(usage_start_time, @timezone))",
  day: "FORMAT_DATE('%Y-%m-%d', DATE(usage_start_time, @timezone))",
  service: "service.description",
  sku: "CONCAT(service.description, ' / ', sku.description)",
  month_service: "CONCAT(FORMAT_DATE('%Y-%m', DATE(usage_start_time, @timezone)), ' / ', service.description)",
};

function jsonOptions(statement: ConnectorActionStatement, keys: string[]): Record<string, unknown> | string {
  if (statement.text.length > 4_000) return "options must be at most 4000 characters";
  try {
    const value: unknown = statement.text.trim() ? JSON.parse(statement.text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return "options must be a JSON object";
    const options = value as Record<string, unknown>;
    return Object.keys(options).some(key => !keys.includes(key)) ? `options are ${keys.join(", ")}` : options;
  } catch { return "options must be a JSON object"; }
}

function pageOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  const options = jsonOptions(statement, ["pageToken"]);
  if (typeof options === "string") return options;
  if (options.pageToken !== undefined && (typeof options.pageToken !== "string" || options.pageToken.length > 2_000 || [...options.pageToken].some(character => character.charCodeAt(0) <= 32))) {
    return "pageToken must be a bounded Google continuation token";
  }
  return options.pageToken ? { pageToken: String(options.pageToken) } : {};
}

function paged(statement: ConnectorActionStatement, dataset = false): Record<string, string> | string {
  const parts = statement.target.split("/");
  if (parts.length !== (dataset ? 2 : 1) || !GCP_PROJECT.test(parts[0]!) || (dataset && !DATASET.test(parts[1]!))) {
    return dataset ? "use <project>/<dataset>" : "name a Google Cloud project ID or number";
  }
  const options = pageOptions(statement);
  return typeof options === "string" ? options : { project: parts[0]!, ...(dataset ? { dataset: parts[1]! } : {}), ...options };
}

function pageUrl(base: string, input: Record<string, string>) {
  const url = new URL(base);
  url.searchParams.set("maxResults", String(PAGE_SIZE));
  if (input.pageToken) url.searchParams.set("pageToken", input.pageToken);
  return url;
}

function continuation(result: Record<string, unknown>): string[] {
  return result.nextPageToken ? [columns("Next pageToken", result.nextPageToken)] : [];
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

function costOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  const parts = statement.target.split("/");
  if (parts.length !== 3 || !GCP_PROJECT.test(parts[0]!) || !DATASET.test(parts[1]!) || !BILLING_TABLE.test(parts[2]!)) {
    return "use <export-project>/<dataset>/<gcp_billing_export_v1_… or gcp_billing_export_resource_v1_…>";
  }
  const options = jsonOptions(statement, ["project", "from", "to", "groupBy", "timezone", "location", "maximumBytesBilled", "dryRun", "job"]);
  if (typeof options === "string") return options;
  if (typeof options.project !== "string" || !GCP_PROJECT.test(options.project) || /^[0-9]/u.test(options.project)) return "project must be the billed project ID (not its number)";
  const now = new Date();
  const from = options.from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  const to = options.to ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  if (!validDate(from) || !validDate(to) || Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 366 * 86_400_000) {
    return "from/to must be valid YYYY-MM-DD dates, to exclusive, at most 366 days apart";
  }
  const groupBy = options.groupBy ?? "month_service";
  if (typeof groupBy !== "string" || !Object.hasOwn(GROUPS, groupBy)) return `groupBy must be ${Object.keys(GROUPS).join(", ")}`;
  const timezone = options.timezone ?? "UTC";
  if (typeof timezone !== "string" || timezone.length > 80) return "timezone must be an IANA time zone";
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { return "timezone must be an IANA time zone"; }
  if (typeof options.location !== "string" || !LOCATION.test(options.location)) return "location must match the export dataset, e.g. US, EU or us-central1";
  const maximum = options.maximumBytesBilled ?? "100000000";
  if (typeof maximum !== "string" || !/^[1-9][0-9]{0,9}$/u.test(maximum) || BigInt(maximum) > 1_000_000_000n) return "maximumBytesBilled must be a positive integer string up to 1000000000";
  const dryRun = options.dryRun ?? true;
  if (typeof dryRun !== "boolean") return "dryRun must be true or false (defaults to true; no query charge)";
  if (options.job !== undefined && (typeof options.job !== "string" || !JOB.test(options.job) || dryRun)) return "job must be a BigQuery job ID with dryRun=false";
  return { exportProject: parts[0]!, dataset: parts[1]!, table: parts[2]!, project: options.project,
    from, to, groupBy, timezone, location: options.location, maximumBytesBilled: maximum, dryRun: String(dryRun),
    ...(options.job ? { job: String(options.job) } : {}) };
}

// Identifiers pass closed grammars; user values are named parameters. No raw SQL,
// DDL, destinations, wildcard tables, external connections or resource writes.
function costSql(input: Record<string, string>): string {
  return `WITH cost_rows AS (
  SELECT ${GROUPS[input.groupBy!]} AS cost_group, currency,
    CAST(cost AS NUMERIC) AS cost,
    IFNULL((SELECT SUM(CAST(c.amount AS NUMERIC)) FROM UNNEST(credits) c), 0) AS credits,
    export_time, usage_end_time
  FROM \`${input.exportProject}.${input.dataset}.${input.table}\`
  WHERE project.id = @project
    AND usage_start_time >= TIMESTAMP(@from, @timezone)
    AND usage_start_time < TIMESTAMP(@to, @timezone)
), grouped AS (
  SELECT cost_group, currency, SUM(cost) AS cost, SUM(credits) AS credits,
    SUM(cost + credits) AS net_cost, COUNT(*) AS line_items,
    MAX(export_time) AS exported_through, MAX(usage_end_time) AS usage_through
  FROM cost_rows GROUP BY cost_group, currency
)
SELECT cost_group, currency, cost, credits, net_cost, line_items,
  SUM(cost) OVER (PARTITION BY currency) AS total_cost,
  SUM(credits) OVER (PARTITION BY currency) AS total_credits,
  SUM(net_cost) OVER (PARTITION BY currency) AS total_net_cost,
  SUM(line_items) OVER (PARTITION BY currency) AS total_line_items,
  COUNT(*) OVER () AS total_groups,
  MAX(exported_through) OVER () AS exported_through,
  MAX(usage_through) OVER () AS usage_through
FROM grouped ORDER BY currency, net_cost DESC, cost_group LIMIT 30`;
}

function queryParameters(input: Record<string, string>) {
  return ["project", "from", "to", "timezone"].map(name => ({ name,
    parameterType: { type: name === "from" || name === "to" ? "DATE" : "STRING" }, parameterValue: { value: input[name] } }));
}

async function queryResult(credentials: Readonly<Record<string, string>>, input: Record<string, string>) {
  const base = `https://bigquery.googleapis.com/bigquery/v2/projects/${input.exportProject}`;
  if (!input.job) return request(credentials, `${base}/queries`, {
    query: costSql(input), queryParameters: queryParameters(input), parameterMode: "NAMED", useLegacySql: false,
    dryRun: input.dryRun === "true", useQueryCache: true, maximumBytesBilled: input.maximumBytesBilled,
    location: input.location, maxResults: PAGE_SIZE, timeoutMs: 5_000, jobTimeoutMs: "20000",
    labels: { xmatrix_action: "gcp_costs_v1" },
  });
  const metadataUrl = new URL(`${base}/jobs/${input.job}`);
  metadataUrl.searchParams.set("location", input.location!);
  const job = await request(credentials, metadataUrl);
  const configuration = record(job.configuration);
  const query = record(configuration.query);
  const parameters = Array.isArray(query.queryParameters) ? query.queryParameters : [];
  const expected = queryParameters(input);
  if (record(configuration.labels).xmatrix_action !== "gcp_costs_v1" || query.query !== costSql(input) || query.useLegacySql !== false ||
      parameters.length !== expected.length || expected.some(parameter => !parameters.some(value => {
        const actual = record(value);
        return actual.name === parameter.name && record(actual.parameterType).type === parameter.parameterType.type &&
          record(actual.parameterValue).value === parameter.parameterValue.value;
      }))) throw new ProviderRequestError(400, "job must match this Connector cost query and parameters");
  if (record(job.status).errorResult) throw new ProviderRequestError(502, "BigQuery cost job failed; inspect the job in Google Cloud");
  const url = new URL(`${base}/queries/${input.job}`);
  url.search = new URLSearchParams({ location: input.location!, maxResults: String(PAGE_SIZE), timeoutMs: "1000" }).toString();
  return request(credentials, url);
}

function costReport(result: Record<string, unknown>, input: Record<string, string>) {
  const title = `${input.project} exported costs ${input.from} through ${input.to} (exclusive), ${input.timezone}; grouped by ${input.groupBy}`;
  if (Array.isArray(result.errors) && result.errors.length) throw new ProviderRequestError(502, "BigQuery reported cost query errors; no totals are available");
  if (input.dryRun === "true") return report(`${title}; dry run only, NOT actual costs`, [columns("Estimated bytes processed", result.totalBytesProcessed ?? "unknown"),
    columns("Query billing cap (bytes)", input.maximumBytesBilled), "Set dryRun=false to read actual export totals; BigQuery query charges can apply."], {});
  if (result.jobComplete !== true) {
    const job = record(result.jobReference);
    if (job.projectId !== input.exportProject || typeof job.jobId !== "string" || !JOB.test(job.jobId)) throw new ProviderRequestError(502, "BigQuery did not return a resumable cost job");
    return report(`${title}; query pending, no totals yet`, [columns("Resume query_costs with the same options and job", job.jobId), columns("Location", job.location ?? input.location)], {});
  }
  const fields = record(result.schema).fields;
  const names = Array.isArray(fields) ? fields.map(value => text(record(value).name)) : [];
  const rows = list(result, "rows").map(value => {
    const cells = record(value).f;
    return Object.fromEntries(names.map((name, index) => [name, record(Array.isArray(cells) ? cells[index] : undefined).v]));
  });
  const totals = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!["cost_group", "currency", "cost", "credits", "net_cost", "total_net_cost", "total_cost", "total_credits", "total_groups"].every(name => row[name] !== undefined)) {
      throw new ProviderRequestError(502, "BigQuery did not return the cost report schema");
    }
    totals.set(text(row.currency), row);
  }
  const output: string[] = [];
  for (const [currency, row] of totals) output.push(columns("TOTAL", currency, "cost", row.total_cost, "credits", row.total_credits, "net", row.total_net_cost));
  output.push("Group\tCurrency\tCost\tCredits\tNet cost\tExported line items");
  for (const row of rows) output.push(columns(row.cost_group, row.currency, row.cost, row.credits, row.net_cost, row.line_items));
  if (!rows.length) output.push("No exported line items in this interval; this does not prove zero spend.");
  if (rows.length) output.push(columns("Latest exported record", rows[0]!.exported_through), columns("Latest returned usage end", rows[0]!.usage_through));
  output.push("Usage-date totals from the export; data can arrive late, and invoice/tax totals can differ. No forecast is included.");
  if (rows.some(row => Number(row.total_groups) > PAGE_SIZE)) output.push("Only the first 30 groups are shown; each displayed currency total includes all its groups.");
  return report(title, output, {});
}

export const GCP_BILLING_ACTIONS: Record<string, ConnectorAction> = {
  list_billing_accounts: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" ? pageOptions(statement) : "use * with optional pageToken",
    async execute({ credentials }, input) {
      const url = new URL("https://cloudbilling.googleapis.com/v1/billingAccounts");
      url.search = new URLSearchParams({ pageSize: String(PAGE_SIZE), ...(input.pageToken ? { pageToken: input.pageToken } : {}) }).toString();
      const result = await request(credentials, url);
      return report("Billing accounts (name, display name, open; NOT actual costs)", [...list(result, "billingAccounts").map(value => {
        const row = record(value); return columns(row.name, row.displayName, row.open);
      }), ...continuation(result)], result);
    },
  },
  read_billing_info: {
    effect: "read", requires: ["oauthToken"], parse: projectOnly,
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://cloudbilling.googleapis.com/v1/projects/${input.project}/billingInfo`);
      return report(`${input.project} billing linkage (NOT actual costs)`, [columns("Project", result.projectId),
        columns("Billing account", result.billingAccountName), columns("Billing enabled", result.billingEnabled)], {});
    },
  },
  list_datasets: {
    effect: "read", requires: ["oauthToken"], parse: statement => paged(statement),
    async execute({ credentials }, input) {
      const result = await request(credentials, pageUrl(`https://bigquery.googleapis.com/bigquery/v2/projects/${input.project}/datasets`, input));
      return report(`${input.project} BigQuery datasets (ID, location)`, [...list(result, "datasets").map(value => {
        const row = record(value); return columns(record(row.datasetReference).datasetId, row.location);
      }), ...continuation(result)], result);
    },
  },
  list_billing_tables: {
    effect: "read", requires: ["oauthToken"], parse: statement => paged(statement, true),
    async execute({ credentials }, input) {
      const result = await request(credentials, pageUrl(`https://bigquery.googleapis.com/bigquery/v2/projects/${input.project}/datasets/${input.dataset}/tables`, input));
      const tables = list(result, "tables").map(record);
      const rows = tables.filter(row => BILLING_TABLE.test(text(record(row.tableReference).tableId)))
        .map(row => columns(record(row.tableReference).tableId, row.type));
      if (!rows.length) rows.push("No standard/detailed billing export table on this page; check continuation pages and other export projects/datasets.");
      return report(`${input.project}/${input.dataset} standard/detailed billing export tables`, [...rows, ...continuation(result)], result);
    },
  },
  query_costs: {
    effect: "read", requires: ["oauthToken"], parse: costOptions,
    async execute({ credentials }, input) { return costReport(await queryResult(credentials, input), input); },
  },
};
