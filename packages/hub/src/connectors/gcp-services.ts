import type { ConnectorAction, ConnectorActionStatement } from "./provider";
import { GCP_PROJECT, columns, report, request } from "./gcp-common";
import { record } from "./event-format";

const APIS = ["cloudbilling.googleapis.com", "bigquery.googleapis.com", "cloudasset.googleapis.com",
  "cloudresourcemanager.googleapis.com", "run.googleapis.com", "logging.googleapis.com", "monitoring.googleapis.com"];

function apiTarget(statement: ConnectorActionStatement): Record<string, string> | string {
  const parts = statement.target.split("/");
  const [project, api] = parts;
  return !statement.text.trim() && parts.length === 2 && project && GCP_PROJECT.test(project) && api && APIS.includes(api)
    ? { project, api } : `use <project>/<api>; supported APIs: ${APIS.join(", ")}`;
}

export const GCP_SERVICE_ACTIONS: Record<string, ConnectorAction> = {
  read_api_status: {
    effect: "read", requires: ["oauthToken"], parse: apiTarget,
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://serviceusage.googleapis.com/v1/projects/${input.project}/services/${input.api}`);
      return report("Google Cloud API status", [columns(result.name, result.state)], {});
    },
  },
  enable_api: {
    effect: "write", requires: ["oauthToken"], parse: apiTarget,
    async execute({ credentials }, input) {
      const result = await request(credentials, `https://serviceusage.googleapis.com/v1/projects/${input.project}/services/${input.api}:enable`, {});
      const failure = record(result.error);
      return report("Google Cloud API enable request", [columns("API", input.api, "project", input.project),
        columns("Operation", result.name), columns("State", result.error ? "failed" : result.done === true ? "complete" : "pending"),
        ...(result.error ? [columns("Error code", failure.code)] : ["Use read_api_status to verify ENABLED before retrying the original action."])], {});
    },
  },
};
