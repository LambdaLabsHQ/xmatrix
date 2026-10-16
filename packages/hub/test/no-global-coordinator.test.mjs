import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Work belongs to the entity it concerns (docs/architecture/entity-coordinators.md).
 * A Durable Object addressed by a constant name is one object for the whole
 * system; three such coordinators appeared during the PostgreSQL cutover
 * without anything objecting. Every constant-named address is listed here
 * with its reason, and a new one fails until it is reviewed.
 */
const REVIEWED = new Map([
  ['"default"', "Device authorization broker: one OAuth device flow table by nature."],
  ["RELAY_CONTROL_PLANE_RETIREMENT_MANIFEST_OBJECT_NAME", "Immutable retirement manifest; read-only, holds no work."],
  ["RELAY_RANK_AUTHORITY_DIRECTORY_OBJECT_NAME", "Rank authority directory: a lookup table, holds no work."],
  ["RELAY_RUNTIME_SINGLE_CELL_NAME", "Runtime single cell: known global, tracked separately; not a work coordinator."],
]);

async function sources(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => entry.isDirectory()
    ? sources(`${dir}/${entry.name}`) : entry.name.endsWith(".ts") ? [`${dir}/${entry.name}`] : []));
  return files.flat();
}

/** Inspect the complete argument: JSON.stringify(entity) is a call, not the constant JSON. */
function constantNames(text) {
  const source = ts.createSourceFile("coordinator.ts", text, ts.ScriptTarget.Latest, true);
  const names = [];
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "idFromName") {
      let argument = node.arguments[0];
      while (argument && ts.isParenthesizedExpression(argument)) argument = argument.expression;
      if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) names.push(JSON.stringify(argument.text));
      else if (argument && ts.isIdentifier(argument) && /^[A-Z][A-Z0-9_]{2,}$/u.test(argument.text)) names.push(argument.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

test("constant coordinator detection distinguishes an entity expression from an uppercase namespace", () => {
  assert.deepEqual(constantNames('namespace.idFromName(JSON.stringify([ref.spaceId, ref.requestId]))'), []);
  assert.deepEqual(constantNames('namespace.idFromName("upload:" + requestId)'), []);
  assert.deepEqual(constantNames('namespace.idFromName("global"); namespace.idFromName((GLOBAL_OBJECT_NAME))'),
    ['"global"', "GLOBAL_OBJECT_NAME"]);
});

test("no Durable Object is addressed by a new constant name", async () => {
  const root = new URL("../src", import.meta.url).pathname;
  const found = [];
  for (const file of await sources(root)) {
    const text = await readFile(file, "utf8");
    for (const name of constantNames(text)) {
      if (!REVIEWED.has(name)) found.push(`${file.slice(root.length + 1)}: ${name}`);
    }
  }
  assert.deepEqual(found, [], "A constant-named Durable Object is a global coordinator; own the work per entity instead");
});
