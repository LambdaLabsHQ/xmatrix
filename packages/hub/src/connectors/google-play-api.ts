import generated from "./generated/google-play.json";
import type { GooglePlayOperationId } from "./generated/google-play";
import { catalogFail as fail, validateCatalogValue, type CatalogSchema } from "./api-catalog-schema";
import { oneLine, record, text } from "./event-format";
import { ConnectorRemedy, providerJson, ProviderRequestError } from "./http";
import { googleHeaders } from "./actions/google-headers";

/*
 * Google Play Android Developer API (androidpublisher v3) for the `googleplay`
 * connector (docs/connectors/google-play.md). The pinned discovery document in
 * vendor/google-play is the only source of operations, paths and request
 * schemas; callers name an operation and supply its parameters, never a URL,
 * method or header. Every call carries the connection's own OAuth token for
 * the androidpublisher scope; listing apps uses the read-only
 * playdeveloperreporting scope of the same grant.
 */

export const PLAY_ORIGIN = "https://androidpublisher.googleapis.com";
export const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const PATH_VALUE = /^[A-Za-z0-9][A-Za-z0-9._~:@+-]{0,1999}$/u;

export interface PlayOperation {
  path: string; method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; deprecated: boolean; description?: string;
  parameters: { name: string; in: "path" | "query"; required: boolean; reserved?: boolean; schema: CatalogSchema }[];
  body?: CatalogSchema; response?: string; upload?: { path: string; maxSize: number; accept: string[] }; download?: boolean;
}
const catalog = generated as unknown as { revision: string; sha256: string; operations: Record<string, PlayOperation>; schemas: Record<string, CatalogSchema> };
export const PLAY_OPERATIONS = catalog.operations;
export const PLAY_REVISION = catalog.revision;
export const PLAY_SHA = catalog.sha256;

export function resolvePlaySchema(schema: CatalogSchema): CatalogSchema {
  if (!schema.$ref) return schema;
  const value = Object.hasOwn(catalog.schemas, schema.$ref) ? catalog.schemas[schema.$ref] : undefined;
  if (!value) throw new ProviderRequestError(400, `${schema.$ref} is not a schema in the pinned Google Play discovery document`);
  return value;
}

export interface PlayInput { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown }
export interface PlayCall { id: string; operation: PlayOperation; path: string; query: [string, string][]; body?: unknown }

/** One `{name}` is one opaque segment; a `{+name}` resource name must match Google's own pattern, segment by segment. */
function pathValue(operation: PlayOperation["parameters"][number], value: unknown): string {
  const at = `path.${operation.name}`;
  if (typeof value !== "string") return fail(at, "must be text");
  if (!operation.reserved) return PATH_VALUE.test(value) ? encodeURIComponent(value) : fail(at, "must be one identifier, not a path");
  const segments = value.split("/");
  if (!operation.schema.pattern || !new RegExp(operation.schema.pattern, "u").test(value) || value.length > 2000 ||
    segments.some(segment => !PATH_VALUE.test(segment))) fail(at, `must be a resource name matching ${operation.schema.pattern ?? "its pattern"}`);
  return segments.map(encodeURIComponent).join("/");
}

/** Only catalog paths and declared query parameters, validated before any credential is used. */
export function playRequest(id: string, input: PlayInput): PlayCall {
  const operation = Object.hasOwn(PLAY_OPERATIONS, id) ? PLAY_OPERATIONS[id] : undefined;
  if (!operation) return fail("operation", "not in the pinned Google Play discovery document (see api_operations)");
  const query: [string, string][] = [];
  let path = operation.path;
  for (const kind of ["path", "query"] as const) {
    const supplied = record(input[kind]), declared = operation.parameters.filter(parameter => parameter.in === kind);
    for (const name of Object.keys(supplied)) if (!declared.some(parameter => parameter.name === name)) fail(`${kind}.${name}`, "unknown parameter");
    for (const parameter of declared) {
      const value = supplied[parameter.name];
      if (value === undefined) { if (parameter.required) fail(`${kind}.${parameter.name}`, "required"); continue; }
      validateCatalogValue(value, parameter.schema, resolvePlaySchema, `${kind}.${parameter.name}`);
      if (kind === "path") path = path.replace(`{${parameter.reserved ? "+" : ""}${parameter.name}}`, pathValue(parameter, value));
      else for (const item of Array.isArray(value) ? value : [value]) query.push([parameter.name, String(item)]);
    }
  }
  if (input.body !== undefined) {
    if (!operation.body) fail("body", "this operation does not accept a body");
    validateCatalogValue(input.body, operation.body!, resolvePlaySchema);
  }
  return { id, operation, path, query, ...(input.body === undefined ? {} : { body: input.body }) };
}

/** Google's own error message is the useful part (a used version code, a missing track); it never carries the token. */
function describePlayError(payload: Record<string, unknown>): string {
  const error = record(payload.error);
  return [text(error.status), oneLine(text(error.message), 600)].filter(Boolean).join(": ") || "Google Play request failed without details";
}

export function playUrl(path: string, query: readonly [string, string][] = []): URL {
  const url = new URL(path, PLAY_ORIGIN);
  if (url.origin !== PLAY_ORIGIN || !url.pathname.startsWith("/androidpublisher/v3/")) throw new ProviderRequestError(500, "Google Play path left its API");
  for (const [name, value] of query) url.searchParams.append(name, value);
  return url;
}

/** One provider call of a validated catalog request. Errors keep Google's message and name the likely fix. */
export async function sendPlay(credentials: Readonly<Record<string, string>>, call: PlayCall): Promise<Record<string, unknown>> {
  try {
    return await providerJson(playUrl(call.path, call.query), { method: call.operation.method, maxBytes: MAX_RESPONSE_BYTES,
      headers: googleHeaders(credentials, "Google Play Console"), describeError: describePlayError,
      ...(call.body === undefined ? {} : { json: call.body }) });
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    const hint = error.status === 401 ? " (reconnect Google Play Console in Apps)"
      : error.status === 403 ? " (the connected Google account needs this permission for the app in Play Console → Users and permissions, and the Google Play Android Developer API must be enabled)" : "";
    throw new ProviderRequestError(error.status, `${error.message.replace(/^Provider returned/u, "Google Play returned")}${hint}`);
  }
}

/** Typed shortcut for business actions: the operation id is checked at compile time, its input at runtime. */
export function play(credentials: Readonly<Record<string, string>>, id: GooglePlayOperationId, input: PlayInput) {
  return sendPlay(credentials, playRequest(id, input));
}

/** One page of the apps the connected account can see, from the Play Developer Reporting API (the publishing API lists none). */
export async function playApps(credentials: Readonly<Record<string, string>>, pageToken?: string) {
  const url = new URL("https://playdeveloperreporting.googleapis.com/v1beta1/apps:search");
  url.searchParams.set("pageSize", "100");
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  let result: Record<string, unknown>;
  try {
    result = await providerJson(url, { headers: googleHeaders(credentials, "Google Play Console"), describeError: describePlayError });
  } catch (error) {
    if (!(error instanceof ProviderRequestError)) throw error;
    if (error.status === 401) throw new ConnectorRemedy(401, "Google no longer accepts the Google Play Console sign-in; reconnect", { kind: "reconnect" });
    throw new ProviderRequestError(error.status, error.message.replace(/^Provider returned/u, "Google Play Developer Reporting API returned"));
  }
  if (result.apps !== undefined && !Array.isArray(result.apps)) throw new ProviderRequestError(502, "Google Play did not return an app list");
  const apps = ((result.apps ?? []) as unknown[]).map(record).map(app => ({ packageName: text(app.packageName), displayName: text(app.displayName) }))
    .filter(app => PACKAGE_NAME.test(app.packageName));
  return { apps, nextPageToken: text(result.nextPageToken) || undefined };
}

/** Check: one real read, the apps this sign-in can see. An account with no app yet still passes. */
export async function verifyGooglePlay(credentials: Readonly<Record<string, string>>): Promise<void> {
  await playApps(credentials);
}
