import { ProviderRequestError } from "./http";
import { record, text } from "./event-format";
import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { GCP_PROJECT, PAGE_SIZE, request, list, report, columns, project, projectOnly } from "./gcp-common";
import { GCP_BILLING_ACTIONS } from "./gcp-billing";
import { GCP_SERVICE_ACTIONS } from "./gcp-services";
import { GCP_COST_REPORT_ACTIONS } from "./gcp-cost-report";

/* Google IAM remains authoritative. Fixed endpoints and typed resource names
 * prevent targets from becoming arbitrary URLs; no container environment,
 * metadata, access policies or credentials are returned with resource status. */
const REGION = /^[a-z]+-[a-z]+[1-9][0-9]?$/u;
const SERVICE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/u;
const MAX_MINUTES = 10_080;
type Credentials = Readonly<Record<string, string>>;

function runTarget(statement: ConnectorActionStatement, service: boolean) {
  const parts = statement.target.split("/");
  return !statement.text.trim() && parts.length === (service ? 3 : 2) && GCP_PROJECT.test(parts[0]!) &&
    REGION.test(parts[1]!) && (!service || SERVICE.test(parts[2]!))
    ? { project: parts[0]!, region: parts[1]!, ...(service ? { service: parts[2]! } : {}) }
    : `use <project>/<region>${service ? "/<service>" : ""}`;
}

/* JSON options avoid ambiguous whitespace and keep all query fragments typed.
 * A log text search is a quoted SEARCH literal, never a caller-authored filter. */
function options(statement: ConnectorActionStatement, metrics: boolean): Record<string, string> | string {
  const target = project(statement);
  if (typeof target === "string") return target;
  if (statement.text.length > 2_000) return "options must be at most 2000 characters";
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = statement.text.trim() ? JSON.parse(statement.text) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "options must be a JSON object";
    raw = parsed as Record<string, unknown>;
  } catch { return "options must be a JSON object"; }
  const keys = metrics ? ["minutes", "metric"] : ["minutes", "severity", "service", "text"];
  if (Object.keys(raw).some(key => !keys.includes(key))) return `options are ${keys.join(", ")}`;
  const minutes = raw.minutes ?? 60;
  if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_MINUTES) {
    return `minutes must be a whole number from 1 to ${MAX_MINUTES}`;
  }
  if (metrics) {
    if (typeof raw.metric !== "string" || raw.metric.length > 200 ||
        !/^[a-z][a-z0-9_.]+\/[A-Za-z0-9_./]+$/u.test(raw.metric)) return "name a metric type, e.g. compute.googleapis.com/instance/cpu/utilization";
    return { ...target, minutes: String(minutes), metric: raw.metric };
  }
  const severity = raw.severity ?? "DEFAULT";
  if (typeof severity !== "string" || !["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"].includes(severity)) {
    return "severity must be a Google Cloud log severity, e.g. ERROR";
  }
  if (raw.service !== undefined && (typeof raw.service !== "string" || !SERVICE.test(raw.service))) return "service must be a Cloud Run service name";
  if (raw.text !== undefined && (typeof raw.text !== "string" || raw.text.length > 200 ||
      [...raw.text].some(character => character.charCodeAt(0) < 32))) return "text must be at most 200 characters without control characters";
  return { ...target, minutes: String(minutes), severity, ...(raw.service ? { service: String(raw.service) } : {}),
    ...(raw.text ? { text: String(raw.text) } : {}) };
}

async function projects(credentials: Credentials) {
  return request(credentials, `https://cloudresourcemanager.googleapis.com/v3/projects:search?pageSize=${PAGE_SIZE}`);
}

export async function verifyGcp(credentials: Credentials): Promise<void> {
  list(await projects(credentials), "projects");
}

export const GCP_ACTIONS: Record<string, ConnectorAction> = {
  ...GCP_BILLING_ACTIONS,
  ...GCP_SERVICE_ACTIONS,
  ...GCP_COST_REPORT_ACTIONS,
  list_projects: {
    effect: "read", requires: ["oauthToken"],
    parse: statement => statement.target === "*" && !statement.text.trim() ? {} : "use @gcp:list_projects:*",
    async execute({ credentials }) {
      const result = await projects(credentials);
      return report("Google Cloud projects (ID, name, state, resource name)", list(result, "projects").map(value => {
        const row = record(value);
        return columns(row.projectId, row.displayName, row.state, row.name);
      }), result);
    },
  },
  list_resources: {
    effect: "read", requires: ["oauthToken"], parse: projectOnly,
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://cloudasset.googleapis.com/v1/projects/${input.project}:searchAllResources?pageSize=${PAGE_SIZE}`);
      return report(`${input.project} resources (name, type, location, state)`, list(result, "results").map(value => {
        const row = record(value);
        return columns(row.name, row.assetType, row.location, row.state);
      }), result, `https://console.cloud.google.com/asset-inventory?project=${input.project}`);
    },
  },
  list_services: {
    effect: "read", requires: ["oauthToken"], parse: statement => runTarget(statement, false),
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://run.googleapis.com/v2/projects/${input.project}/locations/${input.region}/services?pageSize=${PAGE_SIZE}`);
      const rows = list(result, "services").map(value => {
        const row = record(value);
        return columns(row.name, record(row.terminalCondition).state, row.latestReadyRevision);
      });
      if (Array.isArray(result.unreachable) && result.unreachable.length) rows.push(columns("Unreachable regions", result.unreachable.join(", ")));
      return report("Cloud Run services (name, state, ready revision)", rows, result,
        `https://console.cloud.google.com/run?project=${input.project}`);
    },
  },
  read_service: {
    effect: "read", requires: ["oauthToken"], parse: statement => runTarget(statement, true),
    async execute({ credentials }, input) {
      const name = `projects/${input.project}/locations/${input.region}/services/${input.service}`;
      const result = await request(credentials, `https://run.googleapis.com/v2/${name}`);
      if (result.name !== name) throw new ProviderRequestError(502, "Google Cloud did not return the requested service");
      const condition = record(result.terminalCondition);
      const rows = [columns("State", condition.state, condition.reason, condition.message),
        columns("Ready revision", result.latestReadyRevision), columns("Created revision", result.latestCreatedRevision),
        columns("Reconciling", result.reconciling === true ? "yes" : "no")];
      for (const traffic of list(result, "trafficStatuses")) {
        const row = record(traffic);
        rows.push(columns("Traffic", row.revision, row.percent, row.tag));
      }
      return report(name, rows, result, `https://console.cloud.google.com/run/detail/${input.region}/${input.service}/metrics?project=${input.project}`);
    },
  },
  query_logs: {
    effect: "read", requires: ["oauthToken"], parse: statement => options(statement, false),
    async execute({ credentials }, input) {
      const end = Date.now();
      const filter = [`timestamp >= ${JSON.stringify(new Date(end - Number(input.minutes) * 60_000).toISOString())}`,
        `timestamp <= ${JSON.stringify(new Date(end).toISOString())}`, `severity >= ${input.severity}`];
      if (input.service) filter.push('resource.type = "cloud_run_revision"', `resource.labels.service_name = ${JSON.stringify(input.service)}`);
      if (input.text) filter.push(`SEARCH(${JSON.stringify(input.text)})`);
      const result = await request(credentials, "https://logging.googleapis.com/v2/entries:list", {
        resourceNames: [`projects/${input.project}`], filter: filter.join(" AND "), orderBy: "timestamp desc", pageSize: PAGE_SIZE });
      return report(`${input.project} logs, last ${input.minutes} minutes (time, severity, resource, message)`, list(result, "entries").map(value => {
        const row = record(value);
        const message = row.textPayload ?? record(row.jsonPayload).message ?? (row.jsonPayload ? JSON.stringify(row.jsonPayload) : "(structured/protobuf log; open Logs Explorer)");
        return columns(row.timestamp, row.severity, record(row.resource).type, message);
      }), result, `https://console.cloud.google.com/logs/query?project=${input.project}`);
    },
  },
  query_metrics: {
    effect: "read", requires: ["oauthToken"], parse: statement => options(statement, true),
    async execute({ credentials }, input) {
      const end = Date.now();
      const url = new URL(`https://monitoring.googleapis.com/v3/projects/${input.project}/timeSeries`);
      url.search = new URLSearchParams({ filter: `metric.type = ${JSON.stringify(input.metric)}`, view: "FULL", pageSize: String(PAGE_SIZE),
        "interval.startTime": new Date(end - Number(input.minutes) * 60_000).toISOString(), "interval.endTime": new Date(end).toISOString() }).toString();
      const result = await request(credentials, url);
      return report(`${input.project} ${input.metric}, last ${input.minutes} minutes (resource, labels, newest returned point)`, list(result, "timeSeries").map(value => {
        const row = record(value);
        const point = record(Array.isArray(row.points) ? row.points[0] : undefined);
        const sample = record(point.value);
        const distribution = record(sample.distributionValue);
        return columns(record(row.resource).type, JSON.stringify(record(row.resource).labels ?? {}),
          JSON.stringify(record(row.metric).labels ?? {}), record(point.interval).endTime,
          sample.doubleValue ?? sample.int64Value ?? sample.boolValue ?? sample.stringValue ??
          (sample.distributionValue ? `count=${text(distribution.count)} mean=${text(distribution.mean)}` : "(no point)"));
      }), result, `https://console.cloud.google.com/monitoring/metrics-explorer?project=${input.project}`);
    },
  },
  list_alert_policies: {
    effect: "read", requires: ["oauthToken"], parse: projectOnly,
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://monitoring.googleapis.com/v3/projects/${input.project}/alertPolicies?pageSize=${PAGE_SIZE}`);
      return report(`${input.project} alert policies (name, display name, enabled)`, list(result, "alertPolicies").map(value => {
        const row = record(value);
        return columns(row.name, row.displayName, row.enabled === true ? "enabled" : "disabled");
      }), result, `https://console.cloud.google.com/monitoring/alerting?project=${input.project}`);
    },
  },
};
