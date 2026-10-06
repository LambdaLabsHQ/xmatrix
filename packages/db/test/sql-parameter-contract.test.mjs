import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

// PostgreSQL types every placeholder during parse analysis. A `values` entry that no
// longer appears in the statement text leaves its parameter untyped and the whole
// statement fails with 42P18 "could not determine data type of parameter $n" — a
// non-retryable class 42 defect that surfaces to product surfaces as an opaque 500.
// Injected test databases replay rows without parsing SQL, so only this static scan
// catches a predicate refactor that drops a placeholder but keeps its value.
function statements(source) {
  const found = [];
  const pattern = /name:\s*["'`]([A-Za-z0-9_]+)["'`],?\s*\n([\s\S]*?)values:\s*\[/gu;
  for (const match of source.matchAll(pattern)) {
    const [, name, body] = match;
    if (!/text:/u.test(body)) continue;
    const referenced = new Set([...body.matchAll(/\$(\d+)/gu)].map((value) => Number(value[1])));
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
