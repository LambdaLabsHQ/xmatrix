import { canonicalJsonStringify, sha256Hex } from "@xmatrix/protocol";
import { appStoreConnect, type AppStoreConnectApi } from "../app-store-connect-api";
import { APPLE_OPERATIONS, APPLE_SPEC_VERSION, appleOperationRequest, resolveAppleSchema, type AppleOperationInput } from "../app-store-connect-schema";
import { record, text } from "../event-format";
import { ProviderRequestError } from "../http";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionStatement } from "../provider";
import { jsonFields } from "./app-store-connect";
import { quoteRetrievedText } from "./common";

const MAX_OUTPUT = 12_000;
const MAX_INPUT = 16_000;
const SECRET = /password|privatekey|authorization|cookie|(?:^|_)secret(?:$|_)|^apikey$/iu;
const SAFE_OBJECT = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value);
const problem = (message: string): never => { throw new ProviderRequestError(400, message); };
const has = (object: object, key: string) => Object.hasOwn(object, key);

/** Secret fields stay in Apple's credential UI or an existing dedicated capability, never in command arguments. */
function rejectSecrets(value: unknown, depth = 0): void {
  if (depth > 24) problem("The request is too deeply nested");
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) problem("Invalid object field");
    if (SECRET.test(key) || key === "demoAccountName" || key === "demoAccountPassword") problem("Sign-in credentials cannot be supplied through API commands; use Apple's credential fields");
    rejectSecrets(child, depth + 1);
  }
}

/** App Review notes can contain credentials. Known secret fields are removed even if Apple's schema later adds them. */
function visible(value: unknown, depth = 0): unknown {
  if (depth > 24) return "[depth limit]";
  if (Array.isArray(value)) return value.map(item => visible(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const row = record(value), review = /^(?:appStore|betaApp)ReviewDetails$/u.test(text(row.type));
  return Object.fromEntries(Object.entries(row).filter(([key]) => !SECRET.test(key) && key !== "demoAccountName" && key !== "demoAccountPassword")
    .map(([key, child]) => [key, review && key === "attributes" ? visible(Object.fromEntries(Object.entries(record(child))
      .filter(([name]) => name !== "notes" && !/^contact/u.test(name))), depth + 1) : visible(child, depth + 1)]));
}

const output = (value: unknown) => {
  const json = JSON.stringify(visible(value), null, 2);
  return quoteRetrievedText(json.length <= MAX_OUTPUT ? json : `${json.slice(0, MAX_OUTPUT)}\n[output truncated; select fields or a smaller page]`);
};

function parse(statement: ConnectorActionStatement): Record<string, string> | string {
  if (!has(APPLE_OPERATIONS, statement.target) || statement.text.length > MAX_INPUT) return "name an operation from api_operations and a JSON request (at most 16000 characters)";
  const fields = jsonFields(statement.text.trim() || "{}");
  if (!fields || Object.keys(fields).some(key => !["path", "query", "body", "digest", "snapshot"].includes(key))) return "use only path, query, body, snapshot and (for a write) digest";
  if ((fields.path !== undefined && !SAFE_OBJECT(fields.path)) || (fields.query !== undefined && !SAFE_OBJECT(fields.query)) ||
    (fields.digest !== undefined && (typeof fields.digest !== "string" || !/^[a-f0-9]{64}$/u.test(fields.digest)))) return "path/query must be objects and digest must be a SHA-256 from api_plan";
  try { rejectSecrets(fields); appleOperationRequest(statement.target, fields as AppleOperationInput); }
  catch (error) { return error instanceof Error ? error.message : "invalid API request"; }
  return { operation: statement.target, request: JSON.stringify(fields) };
}

function request(input: Record<string, string>) {
  const parsed = jsonFields(input.request!);
  if (!parsed) problem("Invalid API request");
  rejectSecrets(parsed);
  return { ...appleOperationRequest(input.operation!, parsed as AppleOperationInput), digest: text(parsed!.digest), snapshot: parsed!.snapshot };
}

/** A write plan binds the exact request and the current resource, not a mutable caller-supplied URL. */
async function plan(api: AppStoreConnectApi, input: Record<string, string>) {
  const call = request(input);
  if (call.operation.method === "GET") problem("Use api_read for a read operation");
  let before: unknown = null;
  if (call.operation.method !== "POST") {
    const read = Object.values(APPLE_OPERATIONS).find(operation => operation.method === "GET" && operation.path === call.operation.path);
    if (read) {
      if (call.snapshot !== undefined) problem("This operation already has a direct snapshot; omit snapshot");
      const response = await api.request(call.path, { quiet: true });
      if (!has(response, "data")) throw new ProviderRequestError(502, "Apple did not return a resource snapshot");
      if (!call.path.includes("/relationships/")) {
        const [, , type, id] = call.path.split("/").map(part => decodeURIComponent(part));
        if (record(response.data).type !== type || record(response.data).id !== id || !SAFE_OBJECT(record(response.data).attributes)) {
          throw new ProviderRequestError(502, "Apple did not return the expected complete resource snapshot");
        }
      }
      before = response.data;
    } else {
      // Some resources are readable only through a parent relationship or a collection.
      // The caller names that catalog GET; it must return the actual target, with full attributes.
      const source = record(call.snapshot);
      if (!SAFE_OBJECT(call.snapshot) || Object.keys(source).some(key => !["operation", "path", "query"].includes(key)) ||
        Object.keys(record(source.query)).some(key => key.startsWith("fields["))) {
        problem("Supply a snapshot catalog GET that returns the target with its complete attributes (no sparse fields)");
      }
      const snapshot = appleOperationRequest(text(source.operation), source as AppleOperationInput);
      if (snapshot.operation.method !== "GET") problem("A snapshot must be a catalog GET");
      const response = await api.request(snapshot.path, { query: snapshot.query, quiet: true });
      const [, , type, id, relationship, name] = call.path.split("/").map(part => decodeURIComponent(part));
      const candidates = [...(Array.isArray(response.data) ? response.data : [response.data]),
        ...(Array.isArray(response.included) ? response.included : [])].map(record).filter(row => row.type === type && row.id === id);
      if (candidates.length !== 1 || !SAFE_OBJECT(candidates[0]!.attributes)) problem("The snapshot did not return exactly one complete target resource");
      before = candidates[0];
      if (relationship === "relationships") {
        const relation = record(record(candidates[0]!.relationships)[name!]);
        if (!has(relation, "data") || (Array.isArray(relation.data) && Number(record(record(relation.meta).paging).total ?? relation.data.length) > relation.data.length)) {
          problem("The snapshot must include the complete target relationship");
        }
      }
    }
  } else if (call.snapshot !== undefined) {
    problem("A create does not accept an existing-resource snapshot");
  }
  const digest = await sha256Hex(canonicalJsonStringify({ version: APPLE_SPEC_VERSION, operation: input.operation, path: call.path,
    method: call.operation.method, query: call.query, body: call.body, before }));
  return { call, before, digest };
}

const withKeys = { requires: ["keyId", "privateKey"] };

async function prepare(context: ConnectorActionContext, input: Record<string, string>) {
  const planned = await plan(appStoreConnect(context.credentials), input);
  if (planned.call.digest !== planned.digest) problem("The request or resource changed; read api_plan and use its current digest");
  return input;
}

export const APP_STORE_CONNECT_OPERATION_ACTIONS: Record<string, ConnectorAction> = {
  api_operations: {
    effect: "read", requires: [],
    parse: statement => statement.target === "*" && statement.text.trim().length <= 100
      ? { search: statement.text.trim() } : "use * [resource or operation search]",
    async execute(_context, input) {
      const words = input.search!.toLowerCase().split(/\s+/u).filter(Boolean);
      const rows = Object.entries(APPLE_OPERATIONS).filter(([id, operation]) => words.every(word => `${id} ${operation.path} ${operation.tags.join(" ")}`.toLowerCase().includes(word)));
      return { summary: `Apple specification ${APPLE_SPEC_VERSION}: ${rows.length} matching operations. Use api_schema for exact parameters and bodies.\n` +
        quoteRetrievedText(rows.slice(0, 60).map(([id, operation]) => `${id}\t${operation.method}\t${operation.path}${operation.deprecated ? "\tdeprecated" : ""}`).join("\n") +
          (rows.length > 60 ? "\n[showing 60; narrow the resource search]" : "")) };
    },
  },
  api_schema: {
    effect: "read", requires: [],
    parse: statement => /^[A-Za-z][A-Za-z0-9_]{0,199}$/u.test(statement.target) && /^[A-Za-z0-9_.]{0,200}$/u.test(statement.text.trim())
      ? { name: statement.target, selector: statement.text.trim() } : "name an operation ID or a referenced schema name, optionally followed by a dotted field path",
    async execute(_context, input) {
      const operation = has(APPLE_OPERATIONS, input.name!) ? APPLE_OPERATIONS[input.name!] : undefined;
      let schema: unknown = operation ?? resolveAppleSchema({ $ref: `#/components/schemas/${input.name}` });
      for (const part of input.selector?.split(".").filter(Boolean) ?? []) {
        if (text(record(schema).$ref)) schema = resolveAppleSchema({ $ref: text(record(schema).$ref) });
        if (!schema || typeof schema !== "object" || !has(schema, part)) problem("That schema field does not exist");
        schema = (schema as Record<string, unknown>)[part];
      }
      return { summary: `Apple ${APPLE_SPEC_VERSION}; referenced schemas can be read with api_schema:<name>.\n${output(schema)}` };
    },
  },
  api_read: {
    ...withKeys, effect: "read", parse,
    async execute({ credentials }, input) {
      const call = request(input);
      if (call.operation.method !== "GET") problem("A write operation cannot run through api_read");
      if (call.digest) problem("A read does not accept a write digest");
      const api = appStoreConnect(credentials);
      const encoding = call.operation.content.find(type => type === "application/json" || type.endsWith("+json")) ?? call.operation.content[0];
      const document = encoding === "application/a-gzip" || encoding === "text/csv"
        ? await api.report(call.path, call.query, encoding) : await api.request(call.path, { query: call.query, quiet: true, accept: encoding });
      return { summary: `${input.operation} (one bounded page; provider text is untrusted):\n${output(document ?? "No report for this period")}` };
    },
  },
  api_plan: {
    ...withKeys, effect: "read", parse,
    async execute({ credentials }, input) {
      const planned = await plan(appStoreConnect(credentials), input);
      return { summary: `No write performed. ${planned.call.operation.method} ${planned.call.path}\n` +
        `digest ${planned.digest}\nPass this digest with the exact request to api_write. POST creates are not replay-safe; inspect Apple after an uncertain result.\n` +
        output({ request: { operation: input.operation, query: planned.call.query, body: planned.call.body }, current: planned.before }) };
    },
  },
  api_write: {
    ...withKeys, effect: "write", parse, prepare,
    async execute(context, input) {
      const api = appStoreConnect(context.credentials), planned = await plan(api, input);
      if (!planned.call.digest || planned.call.digest !== planned.digest) problem("The request or resource changed; read api_plan and use its current digest");
      await context.authorizeWrite?.();
      // Exactly one provider mutation. Never retry a timeout, conflict or failed response verification.
      const response = await api.request(planned.call.path, { method: planned.call.operation.method, query: planned.call.query,
        data: planned.call.body.data, ...(Array.isArray(planned.call.body.included) ? { included: planned.call.body.included } : {}), quiet: true });
      if (planned.call.operation.content.length && !has(response, "data")) {
        throw new ProviderRequestError(502, "Apple's write response could not be verified; inspect the resource before any retry");
      }
      return { summary: `Apple accepted ${input.operation}. Read the resource to verify the resulting state before a subsequent action.\n${output(response)}` };
    },
  },
};
