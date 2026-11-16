import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

// PostgreSQL types every placeholder during parse analysis. A `values` entry that no
// longer appears in the statement text leaves its parameter untyped and the whole
// statement fails with 42P18 "could not determine data type of parameter $n" — a
// non-retryable class 42 defect that surfaces to product surfaces as an opaque 500.
// Injected test databases replay rows without parsing SQL, so only this static scan
// catches a predicate refactor that drops a placeholder but keeps its value.
function statements(source) {
  const found = [];
  // Resolve literal SQL fragments before checking their consumers. Otherwise a
  // shared WHERE using $1-$3 followed by a local $4 looks like unused inputs.
  const fragments = new Map();
  const syntax = ts.createSourceFile("statement.ts", source, ts.ScriptTarget.Latest, true);
  for (const statement of syntax.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const value = declaration.initializer;
      if (ts.isIdentifier(declaration.name) && value &&
          (ts.isNoSubstitutionTemplateLiteral(value) || ts.isStringLiteral(value))) {
        fragments.set(declaration.name.text, value.text);
      }
    }
  }
  const pattern = /name:\s*["'`]([A-Za-z0-9_]+)["'`],?\s*\n([\s\S]*?)values:\s*\[/gu;
  for (const match of source.matchAll(pattern)) {
    const [, name, body] = match;
    if (!/text:/u.test(body)) continue;
    const expanded = body.replace(/\$\{([A-Za-z_$][\w$]*)\}/gu,
      (expression, name) => fragments.get(name) ?? expression);
    const referenced = new Set([...expanded.matchAll(/\$(\d+)/gu)].map((value) => Number(value[1])));
    if (referenced.size === 0) continue;
    const line = source.slice(0, match.index).split("\n").length;
    found.push({ name, line, referenced });
  }
  return found;
}

test("every SQL statement references each placeholder up to its highest index", () => {
  const directory = new URL("../src/", import.meta.url);
  const unreferenced = [];
  for (const file of readdirSync(directory).filter((entry) => entry.endsWith(".ts"))) {
    const source = readFileSync(new URL(file, directory), "utf8");
    for (const statement of statements(source)) {
      const highest = Math.max(...statement.referenced);
      for (let index = 1; index <= highest; index += 1) {
        if (statement.referenced.has(index)) continue;
        unreferenced.push(`${file}:${statement.line} ${statement.name} never uses $${index}`);
      }
    }
  }
  assert.deepEqual(unreferenced, []);
});

test("the scan reports a placeholder a predicate refactor left behind", () => {
  const regressed = `
      const rows = await transaction.query({
        name: "channel_authorized_id_list_v2",
        text: \`SELECT c.channel_id FROM data.channels c
          WHERE c.space_id = $1 AND c.channel_id > $4
            AND \${predicate({ principalKindSql: "$5", principalIdSql: "$2" })}
          ORDER BY c.channel_id LIMIT $6\`,
        values: [spaceId, principalId, role, cursor, kind, limit + 1],
      });`;
  const [statement] = statements(regressed);
  assert.equal(statement.name, "channel_authorized_id_list_v2");
  assert.equal(statement.referenced.has(3), false);
  assert.equal(Math.max(...statement.referenced), 6);
});

test("literal SQL fragments contribute their placeholders without hiding gaps", () => {
  const source = [
    'const BINDING = `FROM bindings WHERE app=$1 AND installation=$3`;',
    'tx.query({ name: "binding_page_v1",',
    '  text: `SELECT id ${BINDING} AND id>$4`, values: [app, unused, installation, after] });',
  ].join("\n");
  const [statement] = statements(source);
  assert.deepEqual([...statement.referenced].sort(), [1, 3, 4]);
  assert.equal(statement.referenced.has(2), false, "a gap in the fragment still fails the contract");
});
