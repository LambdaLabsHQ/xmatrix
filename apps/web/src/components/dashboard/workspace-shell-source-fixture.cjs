const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

/**
 * Strict owning-module fixture for workspace shell structural tests.
 * - Fixed required file list (missing file fails hard; no silent existsSync drops)
 * - No automatic extras from readdir
 * - Never reads untracked monofile backups
 * - TS AST extracts a unique function within one owning module
 */

/** Required production owning modules for the workspace shell graph. */
const REQUIRED_SHELL_MODULES = Object.freeze([
  "workspace-shell-domain-types.ts",
  "workspace-shell-agent-config-types.ts",
  "workspace-shell-message-model.ts",
  "workspace-shell-presence.ts",
  "workspace-shell-path.ts",
  "workspace-shell-desktop-labels.ts",
  "workspace-shell-search-model.ts",
  "workspace-shell-constants.ts",
  "status-tag.tsx",
  "workspace-shell-formatters.tsx",
  "workspace-shell-rich-message.tsx",
  "workspace-shell-navigation.ts",
  "mobile-channel-history-navigation.ts",
  "workspace-shell-helpers.tsx",
  "machine-daemon-presence.ts",
  "workspace-shell-helpers-extra.tsx",
  "space-scoped-tool-content.ts",
  "workspace-shell-chrome.tsx",
  "workspace-channel-sidebar.tsx",
  "use-channel-pins.ts",
  "workspace-message-timeline.tsx",
  "workspace-composer-dialogs.tsx",
  "agent-trace-window.tsx",
  "centered-dialog-shell.tsx",
  "workspace-fleet-views.tsx",
  "workspace-admin-views.tsx",
  "tool-split.tsx",
  "schedules-model.ts",
  "schedules-view.tsx",
  "my-agents-view.tsx",
  "workspace-shell-recovered.tsx",
  "channel-read-sync.ts",
  "use-channel-read-sync.ts",
  "use-workspace-shell-state.ts",
  "use-machine-daemon-load.ts",
  "use-workspace-shell-tail-cache.ts",
  "use-workspace-automation-actions.ts",
  "use-workspace-shell-actions.ts",
  "workspace-shell-view.tsx",
  "workspace-shell-modules.ts",
  "workspace-app-shell.tsx",
]);

/**
 * @param {string} [dashboardDir]
 * @returns {ReadonlyMap<string, string>} filename → source
 */
function loadWorkspaceShellModuleMap(dashboardDir = __dirname) {
  const map = new Map();
  const missing = [];
  for (const file of REQUIRED_SHELL_MODULES) {
    const full = path.join(dashboardDir, file);
    if (!fs.existsSync(full)) {
      missing.push(file);
      continue;
    }
    map.set(file, fs.readFileSync(full, "utf8"));
  }
  if (missing.length > 0) {
    throw new Error(
      `workspace shell owning modules missing (required contract): ${missing.join(", ")}`,
    );
  }
  return map;
}

/** Concatenation for whole-graph scans only; prefer per-module map for function contracts. */
function loadWorkspaceShellSource(dashboardDir = __dirname) {
  const map = loadWorkspaceShellModuleMap(dashboardDir);
  return REQUIRED_SHELL_MODULES.map((file) => map.get(file)).join("\n\n");
}

/**
 * Collect declaration nodes that define `functionName`.
 * - FunctionDeclaration named X
 * - VariableStatement / VariableDeclaration named X (const X = memo(function X...) etc.)
 * @param {ts.SourceFile} sf
 * @param {string} functionName
 * @param {boolean} nested
 * @returns {ts.Node[]}
 */
function collectNamedDefinitions(sf, functionName, nested) {
  /** @type {ts.Node[]} */
  const hits = [];

  const considerVariable = (stmt) => {
    if (!ts.isVariableStatement(stmt)) return;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.name.text === functionName) {
        hits.push(stmt);
      }
    }
  };

  if (!nested) {
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name?.text === functionName) {
        hits.push(stmt);
      }
      considerVariable(stmt);
    }
    return hits;
  }

  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
      hits.push(node);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === functionName) {
      // Prefer the enclosing VariableStatement when present.
      const parent = node.parent?.parent;
      hits.push(parent && ts.isVariableStatement(parent) ? parent : node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

/**
 * Extract a unique named definition from one owning module via TS AST.
 * Handles function declarations, const/memo components, prop destructuring,
 * return type annotations, and async.
 * Default: top-level SourceFile.statements only (owning-module contract).
 * Nested declarations require explicit allowNested:true (no silent fallback).
 * @param {string} source
 * @param {string} functionName
 * @param {{ fileName?: string, allowNested?: boolean }} [options]
 */
function extractFunctionSource(source, functionName, options = {}) {
  const fileName = options.fileName || "module.tsx";
  const allowNested = options.allowNested === true;
  const scriptKind = fileName.endsWith(".ts") && !fileName.endsWith(".tsx")
    ? ts.ScriptKind.TS
    : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  const hits = collectNamedDefinitions(sf, functionName, allowNested);
  if (hits.length === 0) {
    throw new Error(
      `function ${functionName} not found in ${fileName}` +
        (allowNested ? "" : " (top-level only; pass allowNested:true for hook-local helpers)"),
    );
  }
  if (hits.length > 1) {
    throw new Error(
      `function ${functionName} is not unique in ${fileName} (${hits.length} declarations)`,
    );
  }
  const node = hits[0];
  return source.slice(node.getStart(sf), node.getEnd());
}

/**
 * Locate function by name across the owning-module map; returns { file, source }.
 * Top-level only by default. Nested requires options.allowNested === true.
 * Prefer options.file when a name is defined in multiple modules.
 * @param {ReadonlyMap<string, string>} moduleMap
 * @param {string} functionName
 * @param {{ allowNested?: boolean, file?: string }} [options]
 */
function extractFunctionFromShellModules(moduleMap, functionName, options = {}) {
  const allowNested = options.allowNested === true;
  const preferredFile = options.file;

  /** @type {{ file: string, source: string }[]} */
  const found = [];
  for (const [file, source] of moduleMap) {
    if (preferredFile && file !== preferredFile) continue;
    try {
      const slice = extractFunctionSource(source, functionName, {
        fileName: file,
        allowNested,
      });
      found.push({ file, source: slice });
    } catch (error) {
      if (!String(error.message).includes("not found")) throw error;
    }
  }
  if (found.length === 0) {
    throw new Error(
      `function ${functionName} not found in any required shell module` +
        (preferredFile ? ` (file=${preferredFile})` : "") +
        (allowNested ? "" : " (top-level only)"),
    );
  }
  if (found.length > 1) {
    throw new Error(
      `function ${functionName} found in multiple modules: ${found.map((f) => f.file).join(", ")}` +
        `; pass { file: "..." } to disambiguate`,
    );
  }
  return found[0];
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = source.indexOf(needle, from);
    if (idx < 0) break;
    count += 1;
    from = idx + needle.length;
  }
  return count;
}

/**
 * Run extracted TypeScript function sources as one CommonJS module and return
 * its exports. `bindings` supplies free identifiers the functions close over.
 * @param {string} source
 * @param {Record<string, unknown>} [bindings]
 */
function evaluateExtractedSource(source, bindings = {}) {
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(bindings), compiled)(exported, ...Object.values(bindings));
  return exported;
}

/**
 * Extract the named functions from the shell modules and run them together.
 * @param {ReadonlyMap<string, string>} moduleMap
 * @param {string[]} names
 * @param {string} [epilogue] statements appended after the functions
 */
function loadShellFunctions(moduleMap, names, epilogue = "") {
  const source = names.map((name) => extractFunctionFromShellModules(moduleMap, name).source).join("\n\n");
  return evaluateExtractedSource(`${source}\n${epilogue}`);
}

module.exports = {
  REQUIRED_SHELL_MODULES,
  loadWorkspaceShellModuleMap,
  loadWorkspaceShellSource,
  extractFunctionSource,
  extractFunctionFromShellModules,
  countOccurrences,
  evaluateExtractedSource,
  loadShellFunctions,
};
