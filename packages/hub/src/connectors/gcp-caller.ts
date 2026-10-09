import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { ProviderRequestError } from "./http";
import { record } from "./event-format";
import { PAGE_SIZE, columns, list, optionsJson, report, request } from "./gcp-common";
import { usageOptions } from "./gcp-analysis";

function keyOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  if (!/^[1-9][0-9]{5,19}$/u.test(statement.target)) return "name a Google Cloud project number";
  const raw = optionsJson(statement, ["pageToken", "showDeleted"], true);
  if (typeof raw === "string") return raw;
  if (raw.pageToken !== undefined && (typeof raw.pageToken !== "string" || raw.pageToken.length > 2_000 || /\s/u.test(raw.pageToken))) return "pageToken must be a bounded Google continuation token";
  if (raw.showDeleted !== undefined && typeof raw.showDeleted !== "boolean") return "showDeleted must be boolean";
  return { project: statement.target, showDeleted: String(raw.showDeleted ?? false), ...(raw.pageToken ? { pageToken: String(raw.pageToken) } : {}) };
}

function auditOptions(statement: ConnectorActionStatement): Record<string, string> | string {
  const raw = optionsJson(statement, ["from", "to", "service", "pageToken"]);
  if (typeof raw === "string") return raw;
  const service = raw.service ?? "generativelanguage.googleapis.com";
  if (typeof service !== "string" || !["generativelanguage.googleapis.com", "apikeys.googleapis.com"].includes(service)) return "service must be generativelanguage.googleapis.com or apikeys.googleapis.com";
  const base = usageOptions({ ...statement, text: JSON.stringify({ from: raw.from, to: raw.to, ...(raw.pageToken !== undefined ? { pageToken: raw.pageToken } : {}) }) }, 400);
  return typeof base === "string" ? base : { ...base, service };
}

export const GCP_CALLER_ACTIONS: Record<string, ConnectorAction> = {
  list_api_keys: {
    effect: "read", requires: ["oauthToken"], parse: keyOptions,
    async execute({ credentials }, input) {
      const parent = `projects/${input.project}/locations/global`;
      const url = new URL(`https://apikeys.googleapis.com/v2/${parent}/keys`);
      url.search = new URLSearchParams({ pageSize: String(PAGE_SIZE), showDeleted: input.showDeleted!, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }).toString();
      const result = await request(credentials, url, undefined, input.project);
      const rows = ["Key resource\tUID\tDisplay name\tCreated UTC\tDeleted UTC\tBound service account\tAPI restrictions\tClient restriction types"];
      const keys = list(result, "keys");
      for (const value of keys) {
        const key = record(value);
        if (typeof key.name !== "string" || !key.name.startsWith(`${parent}/keys/`) || !/^[a-z0-9-]{1,63}$/u.test(key.name.slice(`${parent}/keys/`.length)) ||
            typeof key.uid !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(key.uid)) throw new ProviderRequestError(502, "Google Cloud returned an invalid API key identity");
        const restrictions = record(key.restrictions);
        const targets = list(restrictions, "apiTargets").map(target => record(target).service).filter(service => typeof service === "string" && /^[a-z0-9.-]+\.googleapis\.com$/u.test(service));
        const clients = ["browserKeyRestrictions", "serverKeyRestrictions", "androidKeyRestrictions", "iosKeyRestrictions"].filter(type => restrictions[type] !== undefined);
        rows.push(columns(key.name, key.uid, key.displayName, key.createTime, key.deleteTime ?? "(active)", key.serviceAccountEmail ?? "(not bound)",
          targets.length ? targets.join(", ") : "(none reported)", clients.join(", ") || "(none reported)"));
      }
      if (!keys.length) rows.push("No returned key metadata; absence does not establish that no credentials were used.");
      if (result.nextPageToken) rows.push(columns("Next pageToken", result.nextPageToken));
      rows.push("Metadata only: no key strings, annotations, client addresses or creation actor. Key names and bound service accounts do not prove the human or program using them. Deleted keys are visible only within Google's retention window.");
      return report("API key metadata (NOT secret key values or caller identity)", rows, result);
    },
  },
  query_audit_activity: {
    effect: "read", requires: ["oauthToken"], parse: auditOptions,
    async execute({ credentials }, input) {
      const filter = [`timestamp >= ${JSON.stringify(input.from)}`, `timestamp < ${JSON.stringify(input.to)}`,
        `protoPayload.serviceName = ${JSON.stringify(input.service)}`, 'protoPayload."@type" = "type.googleapis.com/google.cloud.audit.AuditLog"'];
      const result = await request(credentials, "https://logging.googleapis.com/v2/entries:list", { resourceNames: [`projects/${input.project}`],
        filter: filter.join(" AND "), orderBy: "timestamp desc", pageSize: PAGE_SIZE, ...(input.pageToken ? { pageToken: input.pageToken } : {}) }, input.project);
      const rows = [columns("Project", input.project), columns("Service", input.service), "Timestamp UTC\tPrincipal email\tPrincipal subject\tMethod\tStatus code\tAPI key resource"];
      const entries = list(result, "entries");
      for (const value of entries) {
        const entry = record(value);
        const payload = record(entry.protoPayload);
        if (payload.serviceName !== input.service) throw new ProviderRequestError(502, "Google Cloud returned audit activity for another service");
        const auth = record(payload.authenticationInfo);
        const keyResource = typeof payload.resourceName === "string" && /^projects\/[1-9][0-9]{5,19}\/locations\/global\/keys\/[a-z0-9-]{1,63}$/u.test(payload.resourceName) ? payload.resourceName : "(not a key resource)";
        rows.push(columns(entry.timestamp, auth.principalEmail ?? "(not recorded)", auth.principalSubject ?? "(not recorded)", payload.methodName, record(payload.status).code ?? "(not recorded)", keyResource));
      }
      if (!entries.length) rows.push("No returned audit entries; absence does not prove no use or that Data Access logging was enabled.");
      if (result.nextPageToken) rows.push(columns("Next pageToken", result.nextPageToken));
      rows.push("Audit metadata only: no request/response bodies, key strings, IPs or user agents. API key administration principals are creators/managers, not necessarily inference callers. Data Access entries require retained logging and Google private-log access.");
      return report("Historical audit principal activity (NOT per-key model costs)", rows, result);
    },
  },
};
