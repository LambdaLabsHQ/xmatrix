import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * A module-level variable lives as long as the isolate and is seen by every
 * request it serves. A Worker request cannot await a promise another request
 * created: once that request ends, its unsettled read is dropped and every
 * waiter fails ("can never settle", HUB-DJ #1785). Values kept across requests
 * are settled values in a `SettledCache`; a promise shared among one request's
 * own tasks is created inside that request. This scans the Worker's sources
 * for a module-level variable whose type, including the local types it names,
 * holds a promise.
 */
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ROOTS = ["packages/hub/src", "packages/db/src", "packages/protocol/src"];

async function sources(dir) {
  return (await readdir(dir, { recursive: true }))
    .filter(file => /\.tsx?$/u.test(file) && !file.endsWith(".d.ts")).map(file => path.join(dir, file));
}

const PROMISES = new Set(["Promise", "PromiseLike"]);

/** Module-level variables whose type holds a promise, as `name: type`. A
 * function's return type is not held, so a port whose methods are async passes. */
function isolateSharedPromises(text) {
  const source = ts.createSourceFile("module.ts", text, ts.ScriptTarget.Latest, true);
  const localTypes = new Map();
  for (const statement of source.statements) {
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement)) localTypes.set(statement.name.text, statement);
  }
  const holdsPromise = (node, seen) => {
    if (ts.isFunctionTypeNode(node) || ts.isConstructorTypeNode(node) || ts.isMethodSignature(node) ||
      ts.isCallSignatureDeclaration(node) || ts.isConstructSignatureDeclaration(node)) return false;
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const name = node.typeName.text;
      if (PROMISES.has(name)) return true;
      const local = localTypes.get(name);
      // Each local type is written out once, so a recursive type ends.
      if (local && !seen.has(name) && holdsPromise(local, seen.add(name))) return true;
    }
    return ts.forEachChild(node, child => holdsPromise(child, seen) || undefined) ?? false;
  };
  const found = [];
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      let initializer = declaration.initializer;
      while (initializer && (ts.isAsExpression(initializer) || ts.isParenthesizedExpression(initializer) ||
        ts.isSatisfiesExpression(initializer))) initializer = initializer.expression;
      // A promise held at module scope, such as `const ready = load()`, is the same mistake;
      // only its declared type tells, so an unannotated call is left to review.
      const types = [declaration.type, ...(initializer && ts.isNewExpression(initializer) ? initializer.typeArguments ?? [] : [])]
        .filter(Boolean);
      if (types.some(type => holdsPromise(type, new Set()))) {
        found.push(`${declaration.name.getText(source)}: ${types.map(type => type.getText(source)).join(", ")}`);
      }
    }
  }
  return found;
}

test("the scan finds a promise held at module scope, directly or through a local type", () => {
  assert.deepEqual(isolateSharedPromises(`
    const files = new Map<string, { at: number; file: Promise<string> }>();
    type TokenState = { token?: string; pending?: Promise<string> };
    const tokens = new Map<string, TokenState>();
    let key: Promise<CryptoKey> | undefined;
    const kept = new SettledCache<string, CryptoKey>(8);
    const names = new Set(["a"]);
    function local() { const inFlight = new Map<string, Promise<string>>(); return inFlight; }
    class Repository { private readonly names = new Map<string, Promise<string>>(); }
    interface Port { read(id: string): Promise<string>; write: (id: string) => Promise<void> }
    const PORT: Port = { read: async id => id, write: async () => {} };
  `), [
    "files: string, { at: number; file: Promise<string> }",
    "tokens: string, TokenState",
    "key: Promise<CryptoKey> | undefined",
  ]);
});

test("no Worker module keeps a promise where another request can await it", async () => {
  const found = [];
  for (const root of ROOTS) {
    for (const file of await sources(path.join(repository, root))) {
      for (const variable of isolateSharedPromises(await readFile(file, "utf8"))) {
        found.push(`${path.relative(repository, file)}: ${variable}`);
      }
    }
  }
  assert.deepEqual(found, [], "keep settled values in a SettledCache (@xmatrix/protocol); share an in-flight promise only inside the request that created it");
});
