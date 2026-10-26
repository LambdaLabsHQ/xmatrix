import type { ConnectorActionStatement } from "../provider";
import { LINEAR_ID, LINEAR_ISSUE, LINEAR_TEAM } from "./linear-api";

type Rule = (value: unknown) => boolean;
export type LinearFields = Readonly<Record<string, Rule>>;
export const linearText = (max = 4000): Rule => value => typeof value === "string" && value.length <= max;
export const linearName: Rule = value => typeof value === "string" && !!value.trim() && value.length <= 250;
export const linearId: Rule = value => typeof value === "string" && LINEAR_ID.test(value);
export const linearIssueRef: Rule = value => typeof value === "string" && (LINEAR_ID.test(value) || LINEAR_ISSUE.test(value));
export const linearTeamRef: Rule = value => typeof value === "string" && (LINEAR_ID.test(value) || LINEAR_TEAM.test(value));
export const linearNullable = (rule: Rule): Rule => value => value === null || rule(value);
export const linearIds: Rule = value => Array.isArray(value) && value.length <= 50 && value.every(linearId) &&
  new Set(value).size === value.length;
export const linearInteger = (min: number, max: number): Rule => value => typeof value === "number" &&
  Number.isInteger(value) && value >= min && value <= max;
export const linearBoolean: Rule = value => typeof value === "boolean";
export const linearEnum = (...values: string[]): Rule => value => typeof value === "string" && values.includes(value);
export const linearDate: Rule = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export const linearTimestamp: Rule = value => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
export const linearColor: Rule = value => typeof value === "string" && /^#[0-9a-f]{6}$/iu.test(value);
export const linearHttpUrl: Rule = value => {
  if (typeof value !== "string" || value.length > 2000) return false;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; } catch { return false; }
};

/** Strict field lists: no arbitrary GraphQL, hidden writes, or unbounded provider filters. */
export function linearJson(text: string, fields: LinearFields, required: readonly string[] = [], optional = false):
  Record<string, unknown> | string {
  if (!text.trim() && optional) return {};
  if (text.length > 16_000) return "Linear JSON is limited to 16,000 characters";
  let value: unknown;
  try { value = JSON.parse(text); } catch { return "provide a JSON object with the documented fields"; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "provide a JSON object";
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).length && !optional) return "provide at least one field";
  for (const [key, entry] of Object.entries(record)) {
    if (!Object.hasOwn(fields, key) || !fields[key]!(entry)) return `invalid Linear field: ${key}; allowed fields: ${Object.keys(fields).join(", ")}`;
  }
  for (const key of required) if (!Object.hasOwn(record, key) || record[key] === null) return `Linear field ${key} is required`;
  return record;
}

export function linearTarget(target: string, kind: "issue" | "team" | "id" | "all" | "teamOrAll"): string | undefined {
  if ((kind === "all" || kind === "teamOrAll") && target === "*") return target;
  if (kind === "issue" && linearIssueRef(target)) return LINEAR_ISSUE.test(target) ? target.toUpperCase() : target.toLowerCase();
  if ((kind === "team" || kind === "teamOrAll") && linearTeamRef(target)) return LINEAR_ID.test(target) ? target.toLowerCase() : target.toUpperCase();
  if (kind === "id" && linearId(target)) return target.toLowerCase();
  return undefined;
}

export function linearStatement(statement: ConnectorActionStatement, kind: Parameters<typeof linearTarget>[1],
  fields: LinearFields, required: readonly string[] = [], optional = false): Record<string, string> | string {
  const target = linearTarget(statement.target, kind);
  if (!target) return `name a Linear ${kind === "id" ? "resource UUID" : kind === "issue" ? "issue identifier or UUID" : "team key or * as documented"}`;
  const data = linearJson(statement.text, fields, required, optional);
  return typeof data === "string" ? data : { target, data: JSON.stringify(data) };
}

export const LINEAR_PAGE_FIELDS: LinearFields = { limit: linearInteger(1, 50), after: linearText(512), includeArchived: linearBoolean };
