// Vendored from norn-lang/norn@879866cb314729dd7e6be1621ac64fc433c3309e; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import { astFromJson, astToJson } from "../frontend/json.js";
import type { AstNode, Pattern, Program, Statement, TopLevelItem } from "../frontend/ast.js";

/** Link a private Std module into ordinary AST, so the program carries the exact definitions it was compiled with. */
export function linkStd(program: Program, std?: Program): Program {
  return linkLibraries(program, { std });
}

/**
 * Links `Std` and any named libraries into ordinary AST so the compiled
 * program carries the exact definitions it was checked with (content-pinned).
 * Programs without `Open`, `Needs`, or `QualifiedIdentifier` keep their exact
 * AST and SHA-256 hash untouched.
 */
export function linkLibraries(
  program: Program,
  options: { std?: Program; libraries?: Readonly<Record<string, Program>> } = {},
): Program {
  const referenced = collectModuleRefs(program);
  const hasNeeds = program.body.some((node) => node.kind === "Needs");
  if (referenced.size === 0 && !hasNeeds) return program;

  const available = new Map<string, Program>();
  if (options.std) available.set("Std", options.std);
  for (const [name, lib] of Object.entries(options.libraries ?? {})) available.set(name, lib);

  // Fast path: preserve exact historical linking for `open Std` alone with no extra libraries.
  const onlyLegacyStd = referenced.size === 1 && referenced.has("Std") && !hasNeeds &&
    !program.body.some((n) => n.kind === "Open" && n.names?.length) &&
    !hasQualifiedIdentifier(program);
  if (onlyLegacyStd) {
    const std = available.get("Std");
    if (!std) throw new Error("open Std needs a pinned library AST: compile(program, {std: stdProgram})");
    return linkLegacyStd(program, std);
  }

  for (const mod of referenced) {
    if (!available.has(mod)) {
      throw new Error(mod === "Std"
        ? "open Std needs a pinned library AST: compile(program, {std: stdProgram})"
        : `Module ${mod} needs a pinned library AST: compile(program, {libraries: {${mod}: ...}})`);
    }
  }

  const main = astFromJson(astToJson(program));
  const usedNames = collectAllNames([main, ...[...referenced].map((m) => available.get(m)!)]);
  const hiddenFor = new Map<string, string>();
  const exportsFor = new Map<string, Set<string>>();
  const linkedTypes: TopLevelItem[] = [];
  const linkedModules: Statement[] = [];

  // Order libraries deterministically so dependencies referenced by libraries are also linked if needed.
  const ordered: string[] = [];
  const visited = new Set<string>();
  const visit = (mod: string) => {
    if (visited.has(mod)) return;
    visited.add(mod);
    const lib = available.get(mod);
    if (!lib) return;
    for (const dep of collectModuleRefs(lib)) {
      if (available.has(dep)) visit(dep);
    }
    ordered.push(mod);
  };
  for (const mod of [...referenced].sort()) visit(mod);

  for (const mod of ordered) {
    const lib = astFromJson(astToJson(available.get(mod)!));
    let hidden = `__norn_${mod}`;
    while (usedNames.has(hidden)) hidden += "_";
    usedNames.add(hidden);
    hiddenFor.set(mod, hidden);

    const hasPub = lib.body.some((n) => (n.kind === "Let" || n.kind === "LetRec") && n.visibility === "pub");
    const modExports = new Set<string>();
    const definitions: Statement[] = [];
    for (const node of lib.body) {
      if (node.kind === "TypeDecl") { linkedTypes.push(node); continue; }
      if (node.kind === "Needs") continue;
      if (node.kind === "Open") {
        const depHidden = hiddenFor.get(node.module);
        const depExports = exportsFor.get(node.module);
        if (depHidden && depExports) {
          const picked = node.names?.length ? node.names : [...depExports];
          if (picked.length) {
            definitions.push({
              kind: "Let",
              span: node.span,
              value: { kind: "Identifier", name: depHidden, span: node.span },
              pattern: {
                kind: "RecordPattern",
                span: node.span,
                fields: picked.map((name) => ({ kind: "FieldPattern", name, span: node.span, pattern: { kind: "VarPattern", name, span: node.span } })),
              },
            });
          }
        }
        continue;
      }
      if (node.kind === "Let") {
        definitions.push(node);
        if (!hasPub || node.visibility === "pub") bindPatternNames(node.pattern, modExports);
      } else if (node.kind === "LetRec") {
        definitions.push(node);
        if (!hasPub || node.visibility === "pub") node.bindings.forEach((b) => modExports.add(b.name));
      } else {
        throw new Error(`${mod} must contain only type and binding declarations`);
      }
    }
    rewriteQualified(definitions, hiddenFor);
    exportsFor.set(mod, modExports);
    const span = lib.span;
    linkedModules.push({
      kind: "Let",
      pattern: { kind: "VarPattern", name: hidden, span },
      value: {
        kind: "Block",
        span,
        body: [
          ...definitions,
          {
            kind: "RecordLiteral",
            spread: null,
            span,
            fields: [...modExports].map((name) => ({ kind: "RecordField", name, span, value: { kind: "Identifier", name, span } })),
          },
        ],
      },
      span,
    });
  }

  const body: TopLevelItem[] = [...linkedTypes, ...linkedModules];
  const last = main.body.findLastIndex((node) => !["Open", "Needs", "TypeDecl", "External"].includes(node.kind));
  main.body.forEach((node, index) => {
    if (node.kind === "Needs") return;
    if (node.kind !== "Open") { body.push(node); return; }
    const hidden = hiddenFor.get(node.module)!;
    const modExports = exportsFor.get(node.module)!;
    const picked = node.names?.length ? node.names : [...modExports];
    if (!picked.length || index > last) return;
    body.push({
      kind: "Let",
      span: node.span,
      value: { kind: "Identifier", name: hidden, span: node.span },
      pattern: {
        kind: "RecordPattern",
        span: node.span,
        fields: picked.map((name) => ({ kind: "FieldPattern", name, span: node.span, pattern: { kind: "VarPattern", name, span: node.span } })),
      },
    });
  });
  rewriteQualified(body, hiddenFor);
  return { ...main, body };
}

function linkLegacyStd(program: Program, std: Program): Program {
  const main = astFromJson(astToJson(program)), library = astFromJson(astToJson(std));
  const exports = new Set<string>(), names = collectAllNames([main, library]);
  let hidden = "__norn_Std";
  while (names.has(hidden)) hidden += "_";
  const definitions: Statement[] = [], types: TopLevelItem[] = [];
  for (const node of library.body) {
    if (node.kind === "TypeDecl") types.push(node);
    else if (node.kind === "Let") { definitions.push(node); bindPatternNames(node.pattern, exports); }
    else if (node.kind === "LetRec") { definitions.push(node); node.bindings.forEach((b) => exports.add(b.name)); }
    else throw new Error("Std must contain only type and binding declarations");
  }
  const span = library.span;
  const linkedModule: Statement = { kind: "Let", pattern: { kind: "VarPattern", name: hidden, span }, value: {
    kind: "Block", span, body: [...definitions, { kind: "RecordLiteral", spread: null, span,
      fields: [...exports].map((name) => ({ kind: "RecordField", name, span, value: { kind: "Identifier", name, span } })) }],
  }, span };
  const body: TopLevelItem[] = [...types, linkedModule];
  const last = main.body.findLastIndex((node) => !["Open", "TypeDecl", "External"].includes(node.kind));
  main.body.forEach((node, index) => {
    if (node.kind !== "Open") { body.push(node); return; }
    // A trailing open has no consumers and must not replace the program's final expression value.
    if (!exports.size || index > last) return;
    body.push({ kind: "Let", span: node.span, value: { kind: "Identifier", name: hidden, span: node.span }, pattern: {
      kind: "RecordPattern", span: node.span, fields: [...exports].map((name) => ({ kind: "FieldPattern", name, span: node.span,
        pattern: { kind: "VarPattern", name, span: node.span } })),
    } });
  });
  return { ...main, body };
}

function bindPatternNames(pattern: Pattern, out: Set<string>): void {
  const pending: unknown[] = [pattern];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if ("kind" in value && value.kind === "VarPattern") out.add((value as Extract<Pattern, { kind: "VarPattern" }>).name);
    for (const child of Object.values(value)) pending.push(child);
  }
}

function collectAllNames(roots: unknown[]): Set<string> {
  const names = new Set<string>();
  const pending: unknown[] = [...roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if ("name" in value && typeof (value as { name: unknown }).name === "string") names.add((value as { name: string }).name);
    for (const child of Object.values(value)) pending.push(child);
  }
  return names;
}

const BUILTIN_MODULES = new Set(["String", "List", "Option", "Result", "JSON", "Events", "Actions"]);

function collectModuleRefs(program: Program): Set<string> {
  const modules = new Set<string>();
  const pending: unknown[] = [program];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if ("kind" in value) {
      const node = value as AstNode;
      if (node.kind === "Open" && !BUILTIN_MODULES.has(node.module)) modules.add(node.module);
      else if (node.kind === "QualifiedIdentifier" && !BUILTIN_MODULES.has(node.module)) modules.add(node.module);
      else if (node.kind === "Needs" && !BUILTIN_MODULES.has(node.module)) modules.add(node.module);
    }
    for (const child of Object.values(value)) pending.push(child);
  }
  return modules;
}

function hasQualifiedIdentifier(program: Program): boolean {
  const pending: unknown[] = [program];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) { pending.push(...value); continue; }
    if ("kind" in value && (value as AstNode).kind === "QualifiedIdentifier") {
      const q = value as Extract<AstNode, { kind: "QualifiedIdentifier" }>;
      if (!BUILTIN_MODULES.has(q.module)) return true;
    }
    for (const child of Object.values(value)) pending.push(child);
  }
  return false;
}

function rewriteQualified(roots: unknown[], hiddenFor: ReadonlyMap<string, string>): void {
  const pending: unknown[] = [...roots];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item && typeof item === "object" && "kind" in item && (item as AstNode).kind === "QualifiedIdentifier") {
          const q = item as Extract<AstNode, { kind: "QualifiedIdentifier" }>;
          if (!BUILTIN_MODULES.has(q.module)) value[i] = toFieldAccess(q, hiddenFor);
        } else {
          pending.push(item);
        }
      }
      continue;
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const child = record[key];
      if (child && typeof child === "object" && "kind" in child && (child as AstNode).kind === "QualifiedIdentifier") {
        const q = child as Extract<AstNode, { kind: "QualifiedIdentifier" }>;
        if (!BUILTIN_MODULES.has(q.module)) record[key] = toFieldAccess(q, hiddenFor);
      } else {
        pending.push(child);
      }
    }
  }
}

function toFieldAccess(node: Extract<AstNode, { kind: "QualifiedIdentifier" }>, hiddenFor: ReadonlyMap<string, string>): AstNode {
  const hidden = hiddenFor.get(node.module);
  if (!hidden) throw new Error(`Unlinked module reference ${node.module}.${node.name}`);
  return {
    kind: "FieldAccess",
    record: { kind: "Identifier", name: hidden, span: { start: { ...node.span.start }, end: { ...node.span.end } } },
    field: node.name,
    span: { start: { ...node.span.start }, end: { ...node.span.end } },
  };
}

/** An old artifact with an unresolved import cannot silently load today's library. */
export function requireLinked(program: Program): void {
  if (program.body.some((node) => node.kind === "Open")) throw new Error("Pinned AST contains an unlinked open Std; compile with its original library AST");
}
