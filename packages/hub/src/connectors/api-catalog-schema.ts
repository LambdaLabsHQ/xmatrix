import { ProviderRequestError } from "./http";

/*
 * Bounded validation of untrusted command JSON against a pinned provider
 * contract (App Store Connect OpenAPI, Google Play discovery), before any
 * credential is used. Each provider resolves its own `$ref` names.
 */

export interface CatalogSchema {
  $ref?: string; type?: string; format?: string; nullable?: boolean; readOnly?: boolean; enum?: unknown[];
  properties?: Record<string, CatalogSchema>; required?: string[]; items?: CatalogSchema;
  additionalProperties?: boolean | CatalogSchema; allOf?: CatalogSchema[]; oneOf?: CatalogSchema[]; anyOf?: CatalogSchema[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; minItems?: number; maxItems?: number; pattern?: string;
}

export const catalogFail = (path: string, reason: string): never => { throw new ProviderRequestError(400, `${path}: ${reason}`); };

export function validateCatalogValue(value: unknown, input: CatalogSchema, resolve: (schema: CatalogSchema) => CatalogSchema, path = "body", depth = 0,
  /** The longest text a field may hold; a request body read from a file allows more than a typed command. */
  maxText = 16_000): void {
  if (depth > 24) catalogFail(path, "too deeply nested");
  const schema = resolve(input), fail = catalogFail;
  const child = (item: unknown, next: CatalogSchema, at: string) => validateCatalogValue(item, next, resolve, at, depth + 1, maxText);
  if (value === null && schema.nullable) return;
  if (schema.readOnly) fail(path, "read-only field");
  if (schema.enum && !schema.enum.includes(value)) fail(path, "not one of the provider's allowed values (see api_schema)");
  for (const part of schema.allOf ?? []) child(value, part, path);
  for (const alternatives of [schema.oneOf, schema.anyOf]) if (alternatives) {
    const matches = alternatives.filter(part => { try { child(value, part, path); return true; } catch { return false; } }).length;
    if (!matches || (alternatives === schema.oneOf && matches !== 1)) fail(path, "does not match the provider's schema alternatives");
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "must be an object");
    const fields = value as Record<string, unknown>;
    for (const required of schema.required ?? []) if (!Object.hasOwn(fields, required)) fail(`${path}.${required}`, "required");
    if (Object.keys(fields).length > 200) fail(path, "too many fields");
    for (const [key, item] of Object.entries(fields)) {
      if (["__proto__", "constructor", "prototype"].includes(key)) fail(`${path}.${key}`, "invalid field");
      const field = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (field) child(item, field, `${path}.${key}`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") child(item, schema.additionalProperties, `${path}.${key}`);
      else if (schema.additionalProperties !== true) fail(`${path}.${key}`, "unknown field");
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) fail(path, "must be an array");
    const items = value as unknown[];
    if (items.length < (schema.minItems ?? 0) || items.length > Math.min(schema.maxItems ?? 200, 200)) fail(path, "array length outside its limit (maximum 200)");
    for (const [index, item] of items.entries()) if (schema.items) child(item, schema.items, `${path}[${index}]`);
  } else if (schema.type === "string") {
    if (typeof value !== "string") fail(path, "must be text");
    const string = value as string;
    if ([...string].length < (schema.minLength ?? 0) || [...string].length > Math.min(schema.maxLength ?? maxText, maxText) ||
      (schema.pattern && !new RegExp(schema.pattern, "u").test(string))) fail(path, "text outside its allowed format or length");
  } else if (schema.type === "integer" || schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)) ||
      value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail(path, "number outside its allowed range");
  } else if (schema.type === "boolean" && typeof value !== "boolean") fail(path, "must be true or false");
}
