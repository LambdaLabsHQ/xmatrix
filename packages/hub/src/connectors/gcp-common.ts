import { providerJson, ProviderRequestError } from "./http";
import { oneLine, text } from "./event-format";
import type { ConnectorActionStatement } from "./provider";
import { quoteRetrievedText } from "./actions/common";
import { describeGoogleError } from "./google-provider-error";
import { googleHeaders } from "./actions/google-headers";

export const GCP_PROJECT = /^(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{5,19})$/u;
export const PAGE_SIZE = 30;
type Credentials = Readonly<Record<string, string>>;


export async function request(credentials: Credentials, url: URL | string, json?: unknown, quotaProject?: string) {
  if (quotaProject !== undefined && !GCP_PROJECT.test(quotaProject)) throw new ProviderRequestError(400, "Invalid Google Cloud quota project");
  return providerJson(url, { describeError: describeGoogleError,
    headers: { ...googleHeaders(credentials, "Google Cloud"), ...(quotaProject ? { "x-goog-user-project": quotaProject } : {}) },
    ...(json === undefined ? {} : { method: "POST", json }) });
}

export function list(result: Record<string, unknown>, key: string): unknown[] {
  if (result[key] !== undefined && !Array.isArray(result[key])) {
    throw new ProviderRequestError(502, `Google Cloud did not return a ${key} list`);
  }
  return ((result[key] ?? []) as unknown[]).slice(0, PAGE_SIZE);
}

export function report(title: string, rows: string[], result: Record<string, unknown>, url?: string) {
  const content = rows.join("\n");
  const truncated = content.length > 12_000 || Boolean(result.nextPageToken) ||
    Object.values(result).some(value => Array.isArray(value) && value.length > PAGE_SIZE);
  return { summary: `${title}${truncated ? " (truncated; first page only)" : ""}:\n` +
    quoteRetrievedText(content.slice(0, 12_000) || "(no results)"), ...(url ? { url } : {}) };
}

export function columns(...values: unknown[]): string {
  return values.map(value => oneLine(typeof value === "boolean" ? String(value) : text(value), 400)).join("\t");
}

export function project(statement: ConnectorActionStatement) {
  return GCP_PROJECT.test(statement.target) ? { project: statement.target } : "name a Google Cloud project ID or number";
}

export function projectOnly(statement: ConnectorActionStatement) {
  return statement.text.trim() ? "this action takes only a project ID or number" : project(statement);
}

export function optionsJson(statement: ConnectorActionStatement, keys: readonly string[], emptyAllowed = false): Record<string, unknown> | string {
  if (statement.text.length > 3_000) return "options must be at most 3000 characters";
  try {
    const value: unknown = emptyAllowed && !statement.text.trim() ? {} : JSON.parse(statement.text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return "options must be a JSON object";
    return Object.keys(value).some(key => !keys.includes(key)) ? `options are ${keys.join(", ")}` : value as Record<string, unknown>;
  } catch { return "options must be a JSON object"; }
}
