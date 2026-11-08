#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import openapiTS, { astToString } from "openapi-typescript";

const root = new URL("../", import.meta.url);
const source = new URL("vendor/app-store-connect/openapi.json", root);
const output = new URL("packages/hub/src/connectors/generated/", root);
const raw = await readFile(source, "utf8");
const spec = JSON.parse(raw);
const methods = ["get", "post", "patch", "delete"];
const schemaKeys = new Set(["$ref", "type", "properties", "items", "required", "enum", "nullable", "allOf", "oneOf", "anyOf",
  "additionalProperties", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "pattern", "readOnly"]);
const schemas = {};
function schema(value) {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const name = value.$ref.replace(/^#\/components\/schemas\//u, "");
    if (name === value.$ref || !spec.components.schemas[name]) throw new Error(`Nonlocal or missing schema: ${value.$ref}`);
    if (!(name in schemas)) { schemas[name] = null; schemas[name] = schema(spec.components.schemas[name]); }
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => schemaKeys.has(key)).map(([key, item]) =>
    [key, key === "properties" ? Object.fromEntries(Object.entries(item).map(([name, field]) => [name, schema(field)])) : schema(item)]));
}
const operations = {};
for (const [path, item] of Object.entries(spec.paths)) for (const method of methods) {
  const op = item[method];
  if (!op) continue;
  if (!op.operationId || operations[op.operationId]) throw new Error(`Missing/duplicate operation ID at ${path}`);
  const responses = Object.entries(op.responses).filter(([status]) => status.startsWith("2")).map(([, response]) => response);
  const content = [...new Set(responses.flatMap(response => Object.keys(response.content ?? {})))];
  operations[op.operationId] = { path, method: method.toUpperCase(), tags: op.tags ?? [], deprecated: op.deprecated === true,
    parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])].map(parameter => {
      if (parameter.$ref || !["path", "query"].includes(parameter.in)) throw new Error(`Unsupported parameter at ${path}`);
      return { name: parameter.name, in: parameter.in, required: parameter.required === true, schema: schema(parameter.schema) };
    }), ...(op.requestBody ? { body: schema(op.requestBody.content["application/json"]?.schema), bodyRequired: op.requestBody.required === true } : {}), content };
  if (op.requestBody && !operations[op.operationId].body) throw new Error(`Unsupported request encoding at ${path}`);
}
const catalog = { version: spec.info.version, sha256: createHash("sha256").update(raw).digest("hex"), operations, schemas };
const generated = {
  "app-store-connect.json": JSON.stringify(catalog) + "\n",
  "app-store-connect.d.ts": astToString(await openapiTS(spec, { alphabetize: true, silent: true })),
};
for (const [file, contents] of Object.entries(generated)) {
  const destination = new URL(file, output);
  if (process.argv.includes("--check")) {
    if (await readFile(destination, "utf8") !== contents) throw new Error(`${file} is stale; run pnpm asc:generate`);
  } else await writeFile(destination, contents);
}
// Comparing a newly downloaded official snapshot does not silently replace the pinned authority.
const comparison = process.argv.indexOf("--compare");
if (comparison !== -1) {
  const next = JSON.parse(await readFile(process.argv[comparison + 1], "utf8"));
  const ids = Object.fromEntries(Object.values(next.paths).flatMap(item => methods.flatMap(method => item[method]
    ? [[item[method].operationId, item[method].deprecated === true]] : [])));
  console.log(JSON.stringify({ version: next.info.version, added: Object.keys(ids).filter(id => !operations[id]),
    removed: Object.keys(operations).filter(id => !(id in ids)), deprecated: Object.keys(ids).filter(id => ids[id] && !operations[id]?.deprecated) }, null, 2));
}
console.log(`Apple ${catalog.version}: ${Object.keys(operations).length} operations; ${process.argv.includes("--check") ? "verified" : "generated"}`);
