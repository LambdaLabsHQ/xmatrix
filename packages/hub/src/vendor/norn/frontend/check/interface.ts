// Vendored from norn-lang/norn@1dd36e4e31d002a62e9a61864a9d9d4b9695b16c; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Host interfaces (docs/types.md §7). A host tells the checker what its
 * programs can see in a Norn file of `type` and `external` declarations. Only
 * such a file may declare an abstract type or an external.
 */
import type * as A from "../ast.js";
import { STACK_EXHAUSTED, isStackExhausted } from "../diagnostics.js";
import { builtinTable, builtinValues, type Family } from "./builtins.js";
import { TypeReader, declareTypes, externalType, typeInfo, type Origin, type TypeTable } from "./declarations.js";
import { sortDiagnostics, type CheckDiagnostic } from "./diagnostics.js";
import { FACT, SOURCE, resolve, type Type } from "./types.js";

/** A name bound to a value: a built-in, an external, a standard library function, or a binding of the program. */
export interface ValueBinding {
  readonly name: string;
  /** Generalized for built-ins, externals and let bindings; a plain type for parameters and switch cases. */
  type: Type;
  readonly origin: Origin;
  /** The function this name is bound to directly, as in `let f = (…) => …` or `let rec`: the effects summary follows calls into it. */
  lambda: A.Lambda | null;
  /** The effect family a built-in performs. */
  readonly family: Family | null;
  /** Where the name is bound. */
  readonly node: A.AstNode | null;
  /** For a parameter of a function: which one, by position or label. */
  readonly parameter: { readonly lambda: A.Lambda; readonly index: number } | { readonly lambda: A.Lambda; readonly label: string } | null;
  /** Whether any identifier refers to this binding. */
  used: boolean;
}

export function binding(fields: Partial<ValueBinding> & Pick<ValueBinding, "name" | "type" | "origin">): ValueBinding {
  return { lambda: null, family: null, node: null, parameter: null, used: false, ...fields };
}

/** What a host lets its programs see. */
export interface HostInterface {
  /** The file it was read from, for messages. */
  readonly file: string;
  readonly table: TypeTable;
  /** The built-in functions and the host's externals. */
  readonly values: ReadonlyMap<string, ValueBinding>;
  readonly diagnostics: readonly CheckDiagnostic[];
  /** Whether the interface file declares no errors. */
  readonly ok: boolean;
}

/** The built-ins alone, with an abstract `report`: a host that declares nothing. */
export function builtinInterface(): HostInterface {
  return loadInterface({ kind: "Program", body: [], span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } } }, "<built-in>");
}

/** Reads a host interface file. Each item must be a `type` or an `external` declaration. */
export function loadInterface(program: A.Program, file: string): HostInterface {
  const diagnostics: CheckDiagnostic[] = [];
  const report = (diagnostic: CheckDiagnostic) => diagnostics.push(diagnostic);
  const table = builtinTable();
  const values = new Map<string, ValueBinding>();
  try {
    declare(program, table, values, report);
  } catch (error) {
    // A type nested deeper than the stack can follow.
    if (!isStackExhausted(error)) throw error;
    report({ severity: "error", code: "too-deep", message: STACK_EXHAUSTED, span: program.span });
  }
  return { file, table, values, diagnostics: sortDiagnostics(diagnostics), ok: !diagnostics.some((d) => d.severity === "error") };
}

function declare(program: A.Program, table: TypeTable, values: Map<string, ValueBinding>, report: (diagnostic: CheckDiagnostic) => void): void {
  const decls: A.TypeDecl[] = [];
  const externals: A.External[] = [];
  for (const item of program.body) {
    if (item.kind === "TypeDecl") decls.push(item);
    else if (item.kind === "External") externals.push(item);
    else {
      report({
        severity: "error",
        code: "interface-item",
        message: `a host interface file holds only type and external declarations, found ${describeItem(item)}`,
        span: item.span,
      });
    }
  }
  declareTypes(table, decls, "host", report, true);
  // run gives the host's report. A host that does not declare it gets an abstract one.
  const declared = table.types.get("report");
  if (declared === undefined) table.types.set("report", typeInfo({ name: "report", kind: "abstract", origin: "host" }));
  else if (declared.params.length > 0) {
    report({
      severity: "error",
      code: "type-arity",
      message: "expected no type parameters for report, found " + declared.params.length + ": report is what run answers, as in request<report>",
      span: declared.decl!.span,
    });
  }

  for (const builtin of builtinValues()) {
    values.set(builtin.name, binding({ name: builtin.name, type: builtin.type, origin: "builtin", family: builtin.family }));
  }
  const reader = new TypeReader(table, report);
  for (const node of externals) {
    const existing = values.get(node.name);
    if (existing !== undefined) {
      report({
        severity: "error",
        code: "duplicate-external",
        message: existing.origin === "builtin"
          ? `${node.name} is a built-in; an interface cannot declare it again`
          : `the external ${node.name} is already declared at ${where(existing.node)}`,
        span: node.span,
      });
      continue;
    }
    values.set(node.name, binding({ name: node.name, type: externalType(node, reader), origin: "host", node }));
  }
}

function where(node: A.AstNode | null): string {
  return node === null ? "another place" : `${node.span.start.line}:${node.span.start.column}`;
}

function describeItem(item: A.TopLevelItem): string {
  switch (item.kind) {
    case "Open":
      return "'open Std'";
    case "Let":
    case "LetRec":
      return "a let binding";
    default:
      return "an expression";
  }
}

/**
 * The facts and streams a host's interface declares, by name: what
 * `compile(program, { sources })` needs so that a program can wait on them.
 * An external is one when it is, or returns, an `event` or a `stream`.
 */
export function hostSources(host: HostInterface): Record<string, "fact" | "stream"> {
  const sources: Record<string, "fact" | "stream"> = {};
  for (const [name, value] of host.values) {
    if (value.origin !== "host") continue;
    const declared = resolve(value.type), type = declared.tag === "fun" ? resolve(declared.result) : declared;
    if (type.tag !== "con" || type.name !== SOURCE) continue;
    const kind = resolve(type.args[0]);
    sources[name] = kind.tag === "con" && kind.name === FACT.name ? "fact" : "stream";
  }
  return sources;
}
