import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "pg";
import ts from "typescript";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultSourceDirectory = resolve(scriptDirectory, "../src");

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function staticText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === null || right === null ? null : left + right;
  }
  return null;
}

export function extractStaticNamedQueries(source, file = "source.ts") {
  const root = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const queries = [];
  let dynamic = 0;
  const dynamicQueries = [];
  function visit(node) {
    if (ts.isObjectLiteralExpression(node)) {
      let name = null;
      let text = null;
      let hasText = false;
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = propertyName(property.name);
        if (key === "name") name = staticText(property.initializer);
        if (key === "text") {
          hasText = true;
          text = staticText(property.initializer);
        }
      }
      if (name !== null && hasText) {
        if (text === null) {
          dynamic += 1;
          dynamicQueries.push({ name, file,
            line: root.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        }
        else queries.push({ name, text, file, line: root.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(root);
  return { queries, dynamic, dynamicQueries };
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

export async function collectStaticNamedQueries(directory = defaultSourceDirectory) {
  const collected = [];
  let dynamic = 0;
  const dynamicQueries = [];
  for (const path of await sourceFiles(directory)) {
    const result = extractStaticNamedQueries(await readFile(path, "utf8"), relative(directory, path));
    collected.push(...result.queries);
    dynamic += result.dynamic;
    dynamicQueries.push(...result.dynamicQueries);
  }
  return { queries: collected, dynamic, dynamicQueries };
}

async function audit() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  const { queries, dynamic } = await collectStaticNamedQueries();
  const client = new Client({ connectionString, application_name: "xmatrix-sql-prepare-audit",
    keepAlive: true, connectionTimeoutMillis: 10_000 });
  const failures = [];
  await client.connect();
  try {
    for (let start = 0; start < queries.length; start += 40) {
      const batch = queries.slice(start, start + 40);
      try {
        await client.query(batch.map((query, offset) => {
          const preparedName = `xmatrix_sql_audit_${start + offset}`;
          return `PREPARE ${preparedName} AS ${query.text}; DEALLOCATE ${preparedName};`;
        }).join("\n"));
      } catch {
        await client.query("DEALLOCATE ALL").catch(() => undefined);
        for (let offset = 0; offset < batch.length; offset += 1) {
          const query = batch[offset];
          const preparedName = `xmatrix_sql_audit_${start + offset}`;
          try {
            await client.query(`PREPARE ${preparedName} AS ${query.text}`);
            await client.query(`DEALLOCATE ${preparedName}`);
          } catch (error) {
            failures.push({ ...query, error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
    }
  } finally {
    await client.end();
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      process.stderr.write(`${failure.file}:${failure.line} ${failure.name}: ${failure.error}\n`);
    }
    throw new Error(`${failures.length} of ${queries.length} static named PostgreSQL queries failed PREPARE`);
  }
  process.stdout.write(JSON.stringify({ ok: true, prepared: queries.length, dynamicSkipped: dynamic }) + "\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await audit();
