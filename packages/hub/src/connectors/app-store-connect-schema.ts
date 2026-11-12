import generated from "./generated/app-store-connect.json";
import type { operations } from "./generated/app-store-connect";
import type { AppStoreConnectApi } from "./app-store-connect-api";
import { record } from "./event-format";
import { ProviderRequestError } from "./http";
import { catalogFail, validateCatalogValue, type CatalogSchema } from "./api-catalog-schema";

export type AppleSchema = CatalogSchema;
export interface AppleOperation {
  path: string; method: "GET" | "POST" | "PATCH" | "DELETE"; tags: string[]; deprecated: boolean;
  parameters: { name: string; in: "path" | "query"; required: boolean; schema: AppleSchema }[];
  body?: AppleSchema; bodyRequired?: boolean; content: string[];
}
const catalog = generated as unknown as { version: string; sha256: string; operations: Record<string, AppleOperation>; schemas: Record<string, AppleSchema> };
export const APPLE_OPERATIONS = catalog.operations;
export const APPLE_SPEC_VERSION = catalog.version;
export const APPLE_SPEC_SHA = catalog.sha256;

export function resolveAppleSchema(schema: AppleSchema): AppleSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.replace(/^#\/components\/schemas\//u, "");
  const value = Object.hasOwn(catalog.schemas, name) ? catalog.schemas[name] : undefined;
  if (!value) throw new ProviderRequestError(502, "The pinned Apple specification has an unresolved schema");
  return value;
}

const fail = catalogFail;

/** Bound validation of untrusted commands against the pinned provider contract, before credentials are used. */
export function validateAppleValue(value: unknown, input: AppleSchema, path = "body"): void {
  validateCatalogValue(value, input, resolveAppleSchema, path);
}

export interface AppleOperationInput { path?: Record<string, string>; query?: Record<string, unknown>; body?: unknown }

/** Only catalog paths and declared query parameters; no URL, headers, credentials or method supplied by the caller. */
export function appleOperationRequest(id: string, input: AppleOperationInput) {
  const operation = Object.hasOwn(APPLE_OPERATIONS, id) ? APPLE_OPERATIONS[id] : undefined;
  if (!operation) fail("operation", "not in the pinned Apple specification");
  const suppliedPath = record(input.path), suppliedQuery = record(input.query), query: Record<string, string> = {};
  let path = operation!.path;
  for (const [kind, supplied] of [["path", suppliedPath], ["query", suppliedQuery]] as const) {
    const parameters = operation!.parameters.filter(parameter => parameter.in === kind);
    // Apple's documented cursor is common to collections but omitted from per-operation OpenAPI parameters.
    // https://developer.apple.com/documentation/appstoreconnectapi/generating-tokens-for-api-requests
    if (kind === "query" && operation!.method === "GET" && Object.hasOwn(supplied, "cursor")) {
      validateAppleValue(supplied.cursor, { type: "string", minLength: 1, maxLength: 2048 }, "query.cursor");
      query.cursor = supplied.cursor as string;
    }
    for (const name of Object.keys(supplied)) if (!(kind === "query" && name === "cursor" && operation!.method === "GET") &&
      !parameters.some(parameter => parameter.name === name)) fail(`${kind}.${name}`, "unknown parameter");
    for (const parameter of parameters) {
      const value = supplied[parameter.name];
      if (value === undefined) { if (parameter.required) fail(`${kind}.${parameter.name}`, "required"); continue; }
      validateAppleValue(value, parameter.schema, `${kind}.${parameter.name}`);
      if (kind === "path") {
        if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._~-]{0,199}$/u.test(value)) fail(`path.${parameter.name}`, "must be an opaque resource ID");
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(value as string));
      } else query[parameter.name] = Array.isArray(value) ? value.join(",") : String(value);
    }
  }
  if (input.body === undefined) { if (operation!.bodyRequired) fail("body", "required"); }
  else if (!operation!.body) fail("body", "this operation does not accept a body");
  else validateAppleValue(input.body, operation!.body);
  return { operation: operation!, path, query, body: record(input.body) };
}

type ParametersOf<O extends keyof operations> = operations[O] extends { parameters: infer P } ? P : never;
type BodyOf<O extends keyof operations> = operations[O] extends { requestBody: { content: { "application/json": infer B } } } ? { body: B } : { body?: never };
type InputOf<O extends keyof operations> = ParametersOf<O> & BodyOf<O>;

/** Zero-runtime generated types for business actions; the existing transport owns JWTs, origin and byte limits. */
export function requestAppleOperation<O extends keyof operations>(api: AppStoreConnectApi, id: O, input: InputOf<O>) {
  const call = appleOperationRequest(id, input as AppleOperationInput);
  return api.request(call.path, { method: call.operation.method, query: call.query, data: call.body.data,
    ...(Array.isArray(call.body.included) ? { included: call.body.included } : {}) });
}
