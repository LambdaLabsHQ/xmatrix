#!/usr/bin/env node
/**
 * Fail if a tracked TypeScript source file imports a name it never uses.
 *
 * Files split out of a large one tended to copy its whole import prelude, so
 * a module carried hundreds of names it did not read. knip only sees unused
 * exports, so nothing caught it. `noUnusedLocals` in tsconfig.base.json now
 * covers every file a package's tsconfig compiles; this check also covers the
 * files no tsconfig does, such as the web e2e suite. It reads each file's
 * syntax tree: an import binding is used when an identifier with its name
 * appears outside the import declarations.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export function unusedImports(fileName, text) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const bindings = [];
  for (const statement of source.statements) {
    const clause = ts.isImportDeclaration(statement) ? statement.importClause : undefined;
    if (!clause) continue;
    if (clause.name) bindings.push(clause.name);
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named)) bindings.push(named.name);
    if (named && ts.isNamedImports(named)) for (const element of named.elements) bindings.push(element.name);
  }
  if (!bindings.length) return [];
  const used = new Set();
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return bindings
    .filter((name) => !used.has(name.text))
    .map((name) => ({ name: name.text, line: source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1 }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.(ts|tsx|mts|cts)$/u.test(file) && !file.endsWith(".d.ts") && fs.existsSync(file));
  const found = [];
  for (const file of files) {
    for (const { name, line } of unusedImports(file, fs.readFileSync(file, "utf8"))) found.push(`${file}:${line} ${name}`);
  }
  if (found.length) {
    for (const entry of found) console.error(entry);
    console.error(`${found.length} unused import(s): delete them rather than carrying a copied prelude.`);
    process.exit(1);
  }
  console.log("OK: no unused imports in", files.length, "TypeScript files");
}
