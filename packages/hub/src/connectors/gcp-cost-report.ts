import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { ProviderRequestError } from "./http";
import { record, text } from "./event-format";
import { GCP_PROJECT, columns, list, project, report, request } from "./gcp-common";

const ID = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/u;
const OPERATION = /^[A-Za-z0-9_-]{1,200}$/u;
const DIMENSIONS: Record<string, string[]> = {
  total: ["project"], product: ["project", "product_display_name"],
  month: ["project", "month"], month_product: ["project", "product_display_name", "month"],
  day: ["project", "day"], sku: ["location", "product_display_name", "project", "sku"],
};
const ALLOWED_COLUMNS = new Set([...Object.values(DIMENSIONS).flat(), "cost"]);

function options(statement: ConnectorActionStatement, keys: string[]): Record<string, unknown> | string {
  if (statement.text.length > 3_000) return "options must be at most 3000 characters";
  try {
    const raw: unknown = statement.text.trim() ? JSON.parse(statement.text) : {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "options must be a JSON object";
    const value = raw as Record<string, unknown>;
    return Object.keys(value).some(key => !keys.includes(key)) ? `options are ${keys.join(", ")}` : value;
  } catch { return "options must be a JSON object"; }
}

function createOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  const target = project(statement);
  if (typeof target === "string") return target;
  const raw = options(statement, ["from", "to", "groupBy", "reportId"]);
  if (typeof raw === "string") return raw;
  const now = Date.now();
  const from = raw.from ?? new Date(now - 7 * 86_400_000).toISOString();
  const to = raw.to ?? new Date(now).toISOString();
  const date = (value: unknown) => typeof value === "string" && /^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/u.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace(".000Z", "Z") === value.replace(".000Z", "Z");
  if (!date(from) || !date(to) || Date.parse(String(from)) < now - 90 * 86_400_000 || Date.parse(String(to)) > now + 86_400_000 || Date.parse(String(to)) <= Date.parse(String(from))) {
    return "from/to must be UTC RFC3339 timestamps, to exclusive, from within the last 90 days and to at most one day ahead";
  }
  const groupBy = raw.groupBy ?? "product";
  if (typeof groupBy !== "string" || !Object.hasOwn(DIMENSIONS, groupBy)) return `groupBy must be ${Object.keys(DIMENSIONS).join(", ")}`;
  if (raw.reportId !== undefined && (typeof raw.reportId !== "string" || !ID.test(raw.reportId))) return "reportId must be a lowercase resource ID up to 63 characters";
  return { ...target, from: String(from), to: String(to), groupBy, ...(raw.reportId ? { reportId: String(raw.reportId) } : {}) };
}

function named(statement: ConnectorActionStatement, operation = false): Record<string, string> | string {
  const parts = statement.target.split("/");
  if (parts.length !== 2 || !GCP_PROJECT.test(parts[0]!) || !(operation ? OPERATION : ID).test(parts[1]!)) return `use <project>/<${operation ? "operation" : "report"}-id>`;
  const raw = options(statement, operation ? [] : ["pageToken"]);
  if (typeof raw === "string") return raw;
  if (raw.pageToken !== undefined && (typeof raw.pageToken !== "string" || raw.pageToken.length > 2_000 || [...raw.pageToken].some(character => character.charCodeAt(0) <= 32))) return "pageToken must be a bounded Google continuation token";
  return { project: parts[0]!, id: parts[1]!, ...(raw.pageToken ? { pageToken: String(raw.pageToken) } : {}) };
}

function amount(value: unknown): string {
  const money = record(value);
  const currency = money.currency_code ?? money.currencyCode;
  const units = money.units ?? "0";
  const nanos = money.nanos ?? 0;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/u.test(currency) || typeof units !== "string" || !/^-?[0-9]{1,20}$/u.test(units) ||
      typeof nanos !== "number" || !Number.isInteger(nanos) || Math.abs(nanos) >= 1_000_000_000) throw new ProviderRequestError(502, "App Optimize returned an invalid cost amount");
  const total = BigInt(units) * 1_000_000_000n + BigInt(nanos);
  const absolute = total < 0n ? -total : total;
  const fraction = String(absolute % 1_000_000_000n).padStart(9, "0").replace(/0+$/u, "");
  return `${currency} ${total < 0n ? "-" : ""}${absolute / 1_000_000_000n}${fraction ? `.${fraction}` : ""}`;
}

function base(projectId: string) { return `https://appoptimize.googleapis.com/v1beta/projects/${projectId}/locations/global`; }

export const GCP_COST_REPORT_ACTIONS: Record<string, ConnectorAction> = {
  create_cost_report: {
    // Creates a provider report resource that expires in 24h, not infrastructure.
    effect: "write", requires: ["oauthToken"], parse: createOptions,
    async execute({ credentials }, input) {
      const id = input.reportId ?? `xm-cost-${crypto.randomUUID()}`;
      const result = await request(credentials, `${base(input.project!)}/reports?reportId=${id}`, {
        scopes: [{ project: `projects/${input.project}` }], dimensions: DIMENSIONS[input.groupBy!], metrics: ["cost"],
        filter: `hour >= timestamp(${JSON.stringify(input.from)}) && hour < timestamp(${JSON.stringify(input.to)})`,
      });
      if (result.error) throw new ProviderRequestError(502, `App Optimize report creation failed (code ${text(record(result.error).code)})`);
      return report("App Optimize cost report requested (gross costs before credits)", [columns("Report target", `${input.project}/${id}`),
        columns("Operation", result.name), columns("State", result.done === true ? "ready" : "pending"),
        columns("UTC interval, to exclusive", input.from, input.to), columns("Grouping", input.groupBy),
        "Time dimensions use Pacific Time and can expand the interval to whole periods. Reports expire after 24 hours."], {});
    },
  },
  read_cost_operation: {
    effect: "read", requires: ["oauthToken"], parse: statement => named(statement, true),
    async execute({ credentials }, input) {
      const result = await request(credentials, `${base(input.project!)}/operations/${input.id}`);
      const response = record(result.response);
      return report("App Optimize cost report operation", [columns("State", result.error ? "failed" : result.done === true ? "ready" : "pending"),
        ...(result.error ? [columns("Error code", record(result.error).code)] : [columns("Report", response.name)])], {});
    },
  },
  read_cost_report: {
    effect: "read", requires: ["oauthToken"], parse: statement => named(statement),
    async execute({ credentials }, input) {
      const name = `projects/${input.project}/locations/global/reports/${input.id}`;
      const metadata = await request(credentials, `https://appoptimize.googleapis.com/v1beta/${name}`);
      const metrics = Array.isArray(metadata.metrics) ? metadata.metrics : [];
      const scopes = Array.isArray(metadata.scopes) ? metadata.scopes : [];
      if (metadata.name !== name || metrics.length !== 1 || metrics[0] !== "cost" || scopes.length > 1 ||
          scopes.some(scope => record(scope).project !== `projects/${input.project}` || record(scope).application !== undefined)) throw new ProviderRequestError(400, "report must contain only costs scoped to this project");
      const result = await request(credentials, `https://appoptimize.googleapis.com/v1beta/${name}:read`, {
        pageSize: 30, ...(input.pageToken ? { pageToken: input.pageToken } : {}),
      });
      if (result.nextPageToken === undefined && result.next_page_token !== undefined) result.nextPageToken = result.next_page_token;
      const names = list(result, "columns").map(value => text(record(value).name));
      if (!names.includes("cost") || names.some(column => !ALLOWED_COLUMNS.has(column))) throw new ProviderRequestError(502, "App Optimize returned an unsupported cost schema");
      const rows = list(result, "rows").map(value => {
        if (!Array.isArray(value) || value.length !== names.length) throw new ProviderRequestError(502, "App Optimize returned a malformed cost row");
        return columns(...value.map((cell, index) => names[index] === "cost" ? amount(cell) : text(cell)));
      });
      const output = [columns("Scope", input.project), columns("Filter", metadata.filter), columns("Expires", metadata.expireTime),
        names.join("\t"), ...rows];
      if (!rows.length) output.push("No reported rows; this does not establish zero spend.");
      if (result.nextPageToken) output.push(columns("Next pageToken", result.nextPageToken), "This page is incomplete; do not sum it as the project total.");
      output.push("Gross contract-price costs before credits, not invoice/net totals. Usage can be delayed more than 24 hours. Time groups use Pacific Time and can expand to full periods.");
      return report("App Optimize project cost data", output, result);
    },
  },
};
