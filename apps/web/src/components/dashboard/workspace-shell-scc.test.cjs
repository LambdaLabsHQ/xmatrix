/**
 * Formal shell import-DAG gate: Tarjan SCC over REQUIRED_SHELL_MODULES.
 * Replaces the temporary scripts/_shell_scc_analysis.py (regex-only) with a
 * fixture-owned module list + TypeScript AST import edges.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { test } = require("node:test");
const ts = require("typescript");

const {
  REQUIRED_SHELL_MODULES,
  loadWorkspaceShellModuleMap,
} = require("./workspace-shell-source-fixture.cjs");

function moduleId(fileName) {
  return fileName.replace(/\.tsx?$/, "");
}

/**
 * @param {string} source
 * @param {string} fileName
 * @param {ReadonlySet<string>} nodes
 * @returns {string[]}
 */
function relativeImportTargets(source, fileName, nodes) {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".ts") && !fileName.endsWith(".tsx")
      ? ts.ScriptKind.TS
      : ts.ScriptKind.TSX,
  );
  const out = [];
  /** @param {string} spec */
  function consider(spec) {
    if (!(spec.startsWith("./") || spec.startsWith("../"))) return;
    const base = path.posix.normalize(spec.replace(/^\.\//, "")).replace(/\.tsx?$/, "");
    const id = base.split("/").pop();
    if (id && nodes.has(id)) out.push(id);
  }
  const visit = (node) => {
    // import ... from "./x"
    if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      consider(node.moduleSpecifier.text);
    }
    // export ... from "./x"  (re-export edges)
    if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      consider(node.moduleSpecifier.text);
    }
    // import x = require("./x") / import-equals
    if (ts.isImportEqualsDeclaration(node) && node.moduleReference) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        consider(node.moduleReference.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Tarjan strongly connected components.
 * @param {string[]} nodes
 * @param {Map<string, Set<string>>} edges
 * @returns {string[][]}
 */
function tarjanScc(nodes, edges) {
  let index = 0;
  const stack = [];
  const onstack = new Set();
  const idx = new Map();
  const low = new Map();
  const sccs = [];

  function strong(v) {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onstack.add(v);
    for (const w of edges.get(v) || []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (onstack.has(w)) {
        low.set(v, Math.min(low.get(v), idx.get(w)));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      while (true) {
        const w = stack.pop();
        onstack.delete(w);
        comp.push(w);
        if (w === v) break;
      }
      sccs.push(comp);
    }
  }

  for (const v of nodes) {
    if (!idx.has(v)) strong(v);
  }
  return sccs;
}

test("workspace shell import DAG has no nontrivial SCCs", () => {
  const map = loadWorkspaceShellModuleMap(__dirname);
  const nodes = REQUIRED_SHELL_MODULES.map(moduleId);
  const nodeSet = new Set(nodes);
  /** @type {Map<string, Set<string>>} */
  const edges = new Map(nodes.map((n) => [n, new Set()]));

  for (const file of REQUIRED_SHELL_MODULES) {
    const src = map.get(file);
    assert.ok(src, `missing module source: ${file}`);
    const id = moduleId(file);
    for (const target of relativeImportTargets(src, file, nodeSet)) {
      if (target !== id) edges.get(id).add(target);
    }
  }

  const sccs = tarjanScc(nodes, edges);
  const nontrivial = sccs.filter((c) => c.length > 1);
  assert.equal(
    nontrivial.length,
    0,
    nontrivial.length === 0
      ? "acyclic"
      : `nontrivial SCCs: ${nontrivial.map((c) => `[${c.sort().join(", ")}]`).join("; ")}`,
  );
});
