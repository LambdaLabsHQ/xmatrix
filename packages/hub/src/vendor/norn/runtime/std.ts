// Vendored from norn-lang/norn@9333fe512bf5af158f5f0695e27fbeb27218243b; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import { astFromJson, astToJson } from "../frontend/json.js";
import type { Pattern, Program, Statement, TopLevelItem } from "../frontend/ast.js";

/** Link a private Std module into ordinary AST, so the program carries the exact definitions it was compiled with. */
export function linkStd(program: Program, std?: Program): Program {
  if (!program.body.some(node => node.kind === "Open")) return program;
  if (!std) throw new Error("open Std needs a pinned library AST: compile(program, {std: stdProgram})");
  const main = astFromJson(astToJson(program)), library = astFromJson(astToJson(std));
  const exports = new Set<string>(), names = new Set<string>();
  const pending: unknown[] = [main, library];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if ("name" in value && typeof value.name === "string") names.add(value.name);
    for (const child of Object.values(value)) pending.push(child);
  }
  let hidden = "__norn_Std";
  while (names.has(hidden)) hidden += "_";
  const definitions: Statement[] = [], types: TopLevelItem[] = [];
  function bind(pattern: Pattern): void {
    const pending: unknown[] = [pattern];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== "object") continue;
      if ("kind" in value && value.kind === "VarPattern") exports.add((value as Extract<Pattern, {kind: "VarPattern"}>).name);
      for (const child of Object.values(value)) pending.push(child);
    }
  }
  for (const node of library.body) {
    if (node.kind === "TypeDecl") types.push(node);
    else if (node.kind === "Let") { definitions.push(node); bind(node.pattern); }
    else if (node.kind === "LetRec") { definitions.push(node); node.bindings.forEach(b => exports.add(b.name)); }
    else throw new Error("Std must contain only type and binding declarations");
  }
  const span = library.span;
  const linkedModule: Statement = { kind: "Let", pattern: { kind: "VarPattern", name: hidden, span }, value: {
    kind: "Block", span, body: [...definitions, { kind: "RecordLiteral", spread: null, span,
      fields: [...exports].map(name => ({ kind: "RecordField", name, span, value: { kind: "Identifier", name, span } })) }],
  }, span };
  const body: TopLevelItem[] = [...types, linkedModule];
  const last = main.body.findLastIndex(node => !["Open", "TypeDecl", "External"].includes(node.kind));
  main.body.forEach((node, index) => {
    if (node.kind !== "Open") { body.push(node); return; }
    // A trailing open has no consumers and must not replace the program's final expression value.
    if (!exports.size || index > last) return;
    body.push({ kind: "Let", span: node.span, value: { kind: "Identifier", name: hidden, span: node.span }, pattern: {
      kind: "RecordPattern", span: node.span, fields: [...exports].map(name => ({ kind: "FieldPattern", name, span: node.span,
        pattern: { kind: "VarPattern", name, span: node.span } })),
    } });
  });
  return { ...main, body };
}

/** An old artifact with an unresolved import cannot silently load today's library. */
export function requireLinked(program: Program): void {
  if (program.body.some(node => node.kind === "Open")) throw new Error("Pinned AST contains an unlinked open Std; compile with its original library AST");
}
