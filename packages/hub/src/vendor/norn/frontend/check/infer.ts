// Vendored from norn-lang/norn@a667dd5a0243281efd075834e7d42a8f371a30d5; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Type inference for Norn programs (docs/types.md §1–§6a).
 *
 * Hindley–Milner with let-generalization by levels, uncurried labelled
 * functions, the classes of §3, the typing of `?`, nominal records and global
 * constructors. Exhaustiveness, the rules that keep requests and replies from
 * being dropped, and the effects summary run over the inferred types afterwards.
 *
 * Chains, the spines of calls, pipes, field accesses, `?`, prefix and binary
 * operators, and `else if`, are walked in loops, so a 10,000-link `->` chain
 * checks without deep recursion. Nested constructs recurse; running out of
 * stack on them becomes the `too-deep` diagnostic at the public boundary.
 */
import type * as A from "../ast.js";
import { STACK_EXHAUSTED, isStackExhausted } from "../diagnostics.js";
import { builtinModuleExports, t } from "./builtins.js";
import { REMOVED_CONSTRUCTORS, REMOVED_NAMES, removedLabel } from "./removed.js";
import { TypeReader, TypeTable, canonicalTypeName, declareTypes, externalType, type CtorInfo, type TypeInfo } from "./declarations.js";
import { both, closest, count, either, ordinal, sortDiagnostics, type CheckDiagnostic, type Code } from "./diagnostics.js";
import { effectsSummary, type EffectSummary } from "./effects.js";
import { validateActionAgainstManifests, validateEventKindAgainstManifests, type ConnectorManifest } from "./events.js";
import { analyzeMatch, type Row } from "./exhaustiveness.js";
import type { FormEvidencePlan } from "./elaborate.js";
import { formOf, type ReportForm } from "./forms.js";
import { binding, type HostInterface, type ValueBinding } from "./interface.js";
import {
  GENERIC, Namer, SOURCE, UnifyError, con, fun, generalize, instantiate, isReply, isRequest, newVar, printScheme, printType, rebuild, resolve, sameShape,
  substitute, tuple, unify, type Clash, type ClassName, type TCon, type TFun, type TLabel, type TVar, type Type,
} from "./types.js";

/** A checked library (`Std`, application library, or Space library). */
export interface Library {
  readonly file: string;
  readonly name?: string;
  readonly program: A.Program;
  /** Its exported (`pub`, or all when no `pub` is used in a legacy library) top-level bindings, in order. */
  readonly exports: readonly ValueBinding[];
  /** Its exported type declarations. */
  readonly types: readonly TypeInfo[];
  /** Its declared `needs` dependencies. */
  readonly needs?: readonly string[];
  /** All declared types (including private ones), for interface derivation and diagnostics. */
  readonly allTypes?: readonly TypeInfo[];
  readonly resolutions: ReadonlyMap<A.Identifier | A.QualifiedIdentifier, ValueBinding>;
  readonly diagnostics: readonly CheckDiagnostic[];
  readonly effects?: readonly EffectSummary[];
  readonly ok: boolean;
}

export interface LoadLibraryOptions {
  /** Library module name (e.g. `"Review"`, `"GitHub"`, `"Std"`). */
  name?: string;
  /** Libraries available to this library via `open`, `needs`, or qualified `Lib.name`. */
  libraries?: Readonly<Record<string, Library>>;
  /** Standard library available to `open Std` inside this library. */
  std?: Library | null;
  /** When true, only `pub` declarations are exported even if no `pub` appears in the file. */
  strictVisibility?: boolean;
  /** Connector manifests the library's `Events.kind` and `Actions.action` calls are checked against. */
  manifests?: readonly ConnectorManifest[];
}

export interface CheckOptions {
  host: HostInterface;
  /** What `open Std` brings in; null when the standard library is not available. */
  std: Library | null;
  /** Named libraries available via `Lib.name`, `open Lib`, `open Lib.{a, b}`, or `needs Lib`. */
  libraries?: Readonly<Record<string, Library>>;
  /** Optional connector manifests used to statically validate `Events.kind(app, kind)`, `Actions.action(app, name)` and their fields. */
  manifests?: readonly ConnectorManifest[];
  /** When true, emit a `default-report-form` warning when an unconstrained `run` falls back to host `report`. */
  warnDefaultReport?: boolean;
  /** When true (edition 1 strict mode), require explicit `~by` on `ask`/`confirm`/`choose`/`run`. */
  requireDeadline?: boolean;
}

export interface CheckResult {
  ok: boolean;
  /** Errors and warnings, in source order. */
  diagnostics: CheckDiagnostic[];
  /** The program's top-level bindings at its end, with their types, as in `remind: (participant, string, ~at: 'a) => reply<string> where 'a: deadline`. */
  bindings: { name: string; type: string }[];
  /** What the program may do, for review (§8); null when it has errors. */
  effects: EffectSummary[] | null;
  /** Each direct call of `run` and the form of its report (§5a); empty when the program has errors. */
  reports: { node: A.Call | A.Pipe; form: ReportForm; defaulted?: boolean }[];
  /** Wadler-Blott evidence plan for generic helpers wrapping `run`. */
  formEvidence?: FormEvidencePlan;
}

/** Checks a program against a host interface, `Std`, and any named libraries. */
export function checkProgram(program: A.Program, options: CheckOptions): CheckResult {
  const libs = options.libraries ?? {};
  const checker = new Checker(options.host, options.std, libs, null, false, options.manifests ?? [], options.warnDefaultReport ?? false, options.requireDeadline ?? false);
  checker.run(program);
  const diagnostics = sortDiagnostics(checker.diagnostics);
  const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  let effects: EffectSummary[] | null = null;
  if (ok) {
    try {
      effects = effectsSummary(program, checker.resolutions, options.std, libs);
    } catch (error) {
      if (!isStackExhausted(error)) throw error;
      diagnostics.push({ severity: "error", code: "too-deep", message: STACK_EXHAUSTED, span: program.span });
      return { ok: false, diagnostics, bindings: [], effects: null, reports: [] };
    }
  }
  const hasEvidence = checker.formEvidence.lambdas.length > 0;
  return {
    ok,
    diagnostics,
    bindings: [...checker.topLevel.values()].map((b) => ({ name: b.name, type: printScheme(b.type) })),
    effects,
    reports: ok ? checker.reports : [],
    ...(ok && hasEvidence ? { formEvidence: checker.formEvidence } : {}),
  };
}

/** Checks a library (`Std`, application library, or Space library). */
export function loadLibrary(program: A.Program, file: string, host: HostInterface, options: LoadLibraryOptions = {}): Library {
  const name = options.name;
  const libs = options.libraries ?? {};
  const checker = new Checker(host, options.std ?? null, libs, name ?? "<library>", options.strictVisibility ?? false, options.manifests ?? []);
  checker.run(program);
  const diagnostics = sortDiagnostics(checker.diagnostics);
  const ok = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const effects = ok ? effectsSummary(program, checker.resolutions, options.std ?? null, libs) : [];
  return {
    file,
    ...(name ? { name } : {}),
    program,
    exports: checker.exportedBindings(),
    types: checker.exportedTypes(),
    needs: checker.needs,
    allTypes: checker.ownTypes,
    resolutions: checker.resolutions,
    diagnostics,
    effects,
    ok,
  };
}

// -------------------------------------------------------------------------------

/** A label of a later labelled parameter while a default value is read: the name is bound only if the caller passes it. */
interface Pending {
  readonly pending: A.LabelledParam;
}

/** A name imported by two different `open` statements: must be qualified at the use site. */
interface Ambiguous {
  readonly ambiguous: { readonly name: string; readonly modules: string[] };
}

type Entry = ValueBinding | Pending | Ambiguous;

/** Lexical scope: each name maps to a stack of bindings, and a log undoes them when a block ends. */
class Scope {
  private readonly names = new Map<string, Entry[]>();
  private readonly log: string[] = [];

  mark(): number {
    return this.log.length;
  }

  bind(name: string, entry: Entry): void {
    let stack = this.names.get(name);
    if (stack === undefined) {
      stack = [];
      this.names.set(name, stack);
    }
    stack.push(entry);
    this.log.push(name);
  }

  reset(mark: number): void {
    while (this.log.length > mark) this.names.get(this.log.pop()!)!.pop();
  }

  lookup(name: string): Entry | undefined {
    return this.names.get(name)?.at(-1);
  }

  *visible(): Generator<string> {
    for (const [name, stack] of this.names) if (stack.length > 0) yield name;
  }
}

/** A function being checked: the type it returns, and the first `?` inside it, which fixes the family of what it returns. */
interface FunctionContext {
  readonly returnType: Type;
  firstTry: { span: A.Span; family: TryFamily } | null;
}

type TryFamily = "reply" | "option" | "result";

/** A pattern match to check for exhaustiveness and unreachable cases once all types are known. */
interface Match {
  readonly kind: "switch" | "let" | "parameter";
  readonly node: A.Switch | A.Pattern;
  readonly type: Type;
  readonly rows: Row[];
  /** A pattern had a type error: the analysis would only repeat it. */
  readonly broken: boolean;
}

/** The names a pattern binds, so far: for duplicates, and to add them to the scope afterwards. */
interface Binder {
  readonly names: Map<string, ValueBinding>;
  /** For a parameter's own name: which parameter it is, for the effects summary. */
  readonly parameter: ValueBinding["parameter"];
  /** "pattern" or "parameters": where a duplicate name is. */
  readonly within: string;
}

/** What a call's callee is: its type, a name for messages, and what it is bound to. */
interface Callee {
  readonly type: Type;
  readonly name: string | null;
  readonly binding?: ValueBinding | undefined;
}

/** How a type error is described: where the value is, a hint, and the code for a plain mismatch. */
interface Context {
  /** Completes "expected X …", as in "for the first argument of ask". */
  readonly where: string;
  /** Appended after "found Y", as in "; take the bool out with ? or switch". */
  readonly hint?: (expected: Type, found: Type) => string;
  readonly code?: Code;
}

export class Checker {
  readonly diagnostics: CheckDiagnostic[] = [];
  readonly resolutions = new Map<A.Identifier | A.QualifiedIdentifier, ValueBinding>();
  /** The program's top-level bindings, the latest of each name. */
  readonly topLevel = new Map<string, ValueBinding>();
  ownTypes: TypeInfo[] = [];
  readonly needs: string[] = [];

  private readonly host: HostInterface;
  private readonly std: Library | null;
  private readonly libraries: Readonly<Record<string, Library>>;
  private readonly builtinModules: Readonly<Record<string, readonly ValueBinding[]>>;
  private readonly manifests: readonly ConnectorManifest[];
  private readonly warnDefaultReport: boolean;
  private readonly requireDeadline: boolean;
  private readonly libraryName: string | null;
  private readonly strictVisibility: boolean;
  private hasExplicitPub = false;
  private readonly table: TypeTable;
  private readonly scope = new Scope();
  private readonly openedBy = new Map<string, { module: string; binding: ValueBinding }[]>();
  private readonly localTopLevel = new Set<string>();
  private level = 0;
  private readonly functions: FunctionContext[] = [];
  private readonly lambdaStack: A.Lambda[] = [];
  private readonly matches: Match[] = [];
  /** Statements before the last of their block, with their types: none may be a request or a reply (§6a). */
  private readonly statementsBeforeLast: { node: A.Expression; type: Type }[] = [];
  /** The patterns of `let`s and the names they bind (§6a). */
  private readonly lets: { pattern: A.Pattern; bindings: ValueBinding[] }[] = [];
  private readonly patternTypes = new Map<A.Pattern, Type>();
  private readonly chooseOptions: { arg: A.Expression; element: Type }[] = [];
  /** Each direct call of `run`, with the type of its report (§5a) and enclosing lambda (if any). */
  private readonly runs: { node: A.Call | A.Pipe; report: Type; enclosingLambda: A.Lambda | null }[] = [];
  /** Calls to named functions whose lambdas contain polymorphic `run` calls, for Wadler-Blott evidence passing. */
  private readonly genericFormLambdas = new Map<A.Lambda, { runNodes: (A.Call | A.Pipe)[]; formVar: TVar }>();
  private readonly formCallSites: { node: A.Call | A.Pipe; lambda: A.Lambda; report: Type }[] = [];
  /** `Events.kind(app, kind)` calls queued for manifest validation once types settle. */
  private readonly eventKindCalls: { app: string; kind: string; payload: Type; span: A.Span }[] = [];
  /** `Actions.action(app, name)` calls queued for manifest validation once types settle. */
  private readonly actionCalls: { app: string; name: string; input: Type; output: Type; span: A.Span }[] = [];
  /** `JSON.decode(x)` calls queued for external opaque-type check. */
  private readonly jsonDecodeCalls: { target: Type; span: A.Span }[] = [];
  /** Pure stream/validator callbacks queued for static purity verification (`{}`). */
  private readonly pureCallbacks: { name: string; fn: A.Expression; span: A.Span }[] = [];
  readonly reports: { node: A.Call | A.Pipe; form: ReportForm; defaulted?: boolean }[] = [];
  readonly formEvidence: { lambdas: A.Lambda[]; forwardedRuns: (A.Call | A.Pipe)[]; callSites: { node: A.Call | A.Pipe; form: ReportForm }[] } = {
    lambdas: [], forwardedRuns: [], callSites: [],
  };
  /** Each direct request to a participant whose arguments are all literals, by what it asks of whom (spec §11.2). */
  private readonly literalRequests = new Map<string, A.Call | A.Pipe>();
  /** The program's last expression, if it has one: it must not be a request (§6a). */
  private programValue: { node: A.Expression; type: Type } | null = null;
  /** Errors in patterns so far, to skip the analysis of a match whose patterns are wrong. */
  private patternErrors = 0;
  /** The node being checked, for the `too-deep` diagnostic. */
  private cursor: { span: A.Span } | null = null;
  private stdReported = false;
  /** The names that the lets being read are defining, for the hint to write let rec. */
  private readonly defining: string[] = [];

  constructor(
    host: HostInterface,
    std: Library | null,
    libraries: Readonly<Record<string, Library>> = {},
    libraryName: string | null = null,
    strictVisibility = false,
    manifests: readonly ConnectorManifest[] = [],
    warnDefaultReport = false,
    requireDeadline = false,
  ) {
    this.host = host;
    this.std = std;
    this.libraries = libraries;
    this.manifests = manifests;
    this.warnDefaultReport = warnDefaultReport;
    this.requireDeadline = requireDeadline;
    this.libraryName = libraryName;
    this.strictVisibility = strictVisibility;
    this.table = new TypeTable(host.table, libraryName);
    const rawBuiltins = builtinModuleExports();
    const wrapped: Record<string, ValueBinding[]> = {};
    for (const [mod, items] of Object.entries(rawBuiltins)) {
      wrapped[mod] = items.map((b) => binding({ name: b.name, type: b.type, origin: "builtin", library: mod, family: b.family }));
    }
    this.builtinModules = wrapped;
  }

  private lookupLibrary(name: string): Library | null {
    if (name === "Std") return this.std ?? this.libraries["Std"] ?? null;
    return this.libraries[name] ?? null;
  }

  exportedBindings(): ValueBinding[] {
    const all = [...this.topLevel.values()];
    if (!this.strictVisibility && !this.hasExplicitPub) return all;
    return all.filter((b) => b.visibility === "pub");
  }

  exportedTypes(): TypeInfo[] {
    if (!this.strictVisibility && !this.hasExplicitPub) return this.ownTypes;
    return this.ownTypes.filter((tInfo) => tInfo.visibility === "pub");
  }

  /** Checks a whole program. Running out of stack is reported at the construct being checked, not thrown. */
  run(program: A.Program): void {
    try {
      this.program(program);
    } catch (error) {
      if (!isStackExhausted(error)) throw error;
      this.error("too-deep", STACK_EXHAUSTED, (this.cursor ?? program).span);
    }
  }

  private program(program: A.Program): void {
    this.cursor = program;
    this.hasExplicitPub = program.body.some((item) =>
      (item.kind === "TypeDecl" || item.kind === "Let" || item.kind === "LetRec") && item.visibility === "pub",
    );
    // Adopt types from all supplied libraries by qualified name (`Lib.type`), and unqualified for opened libraries.
    for (const [modName, lib] of Object.entries(this.libraries)) {
      const opened = program.body.some((item) => item.kind === "Open" && item.module === modName && !item.names);
      for (const info of lib.types) this.table.adopt(info, !opened);
    }
    if (this.std !== null && program.body.some((item) => item.kind === "Open" && item.module === "Std")) {
      for (const info of this.std.types) this.table.adopt(info, false);
    }
    const decls = program.body.filter((item): item is A.TypeDecl => item.kind === "TypeDecl");
    const origin = this.libraryName !== null ? "library" : "program";
    this.ownTypes = declareTypes(
      this.table,
      decls,
      origin,
      (diagnostic) => this.diagnostics.push(diagnostic),
      false,
      this.libraryName ?? undefined,
    );
    for (const value of this.host.values.values()) this.scope.bind(value.name, value);
    this.statements(program.body, true);
    this.finish();
    if (this.libraryName !== null) this.checkLibraryInvariants(program);
  }

  // Reporting --------------------------------------------------------------------

  private error(code: Code, message: string, span: A.Span, extra: Partial<CheckDiagnostic> = {}): void {
    this.diagnostics.push({ severity: "error", code, message, span, ...extra });
  }

  private warning(code: Code, message: string, span: A.Span): void {
    this.diagnostics.push({ severity: "warning", code, message, span });
  }

  /**
   * Requires `found`, what the program has, to unify with `expected`, what
   * the context needs. On a clash, reports it at `span` and returns false.
   */
  private expect(found: Type, expected: Type, span: A.Span, context: Context): boolean {
    try {
      unify(expected, found, this.table);
      return true;
    } catch (error) {
      if (!(error instanceof UnifyError)) throw error;
      this.clash(error.clash, expected, found, span, context);
      return false;
    }
  }

  private clash(clash: Clash, expected: Type, found: Type, span: A.Span, context: Context): void {
    const namer = new Namer();
    const where = context.where === "" || context.where.startsWith(",") ? context.where : ` ${context.where}`;
    switch (clash.kind) {
      case "class": {
        const offending = printType(clash.type, namer);
        let { code } = CLASSES[clash.cls];
        const { members } = CLASSES[clash.cls];
        let { hint } = CLASSES[clash.cls];
        const holder = resolve(clash.inner);
        let inner = "";
        if (clash.cls === "equality") {
          const opaqueInfo = holder.tag === "con" ? this.table.lookupType(holder.name) : undefined;
          if (opaqueInfo && this.table.isSealedOpaque(opaqueInfo)) {
            code = "opaque-equality";
            hint = `: ${opaqueInfo.library}.${opaqueInfo.name} is an opaque type from ${opaqueInfo.library} and does not expose == outside its library`;
          } else if (holder.tag === "con" && holder.name === SOURCE) {
            inner = holder === resolve(clash.type) ? "" : `, which contains ${printType(holder, namer)}`;
            hint = ": events and streams cannot be compared, since they may hold functions, as map and filter do";
          } else if (holder.tag === "con") {
            inner = holder === resolve(clash.type) ? ", which holds a function" : `, which contains ${printType(holder, namer)}, which holds a function`;
          } else if (holder !== resolve(clash.type)) {
            inner = `, which contains the function type ${printType(holder, namer)}`;
          }
        }
        if (clash.cls === "discardable" && clash.dropped !== undefined) {
          const kind = isRequest(clash.type) ? "request" : "reply";
          code = `dropped-${kind}`;
          hint = `: a value of this type is dropped at ${position(clash.dropped)} without being looked at; ${DROP_ADVICE[kind]}`;
        }
        if (clash.cls === "handled" && isRequest(clash.type)) {
          hint = ": nothing waits for a request a handler returns; wait for it with ->wait";
        }
        // A part of a larger type, such as the result of a function passed as an argument: name the whole too.
        const whole = resolve(found) !== resolve(clash.type) && resolve(expected) !== resolve(clash.type) ? `, in ${printType(found, namer)}` : "";
        this.error(code, `expected ${members}${where}, found ${offending}${inner}${whole}${hint}`, span, { expected: members, found: offending });
        return;
      }
      case "classes": {
        const first = CLASSES[clash.first].name;
        const second = CLASSES[clash.second].name;
        this.error("class-conflict", `expected a type that is both ${first} and ${second}${where}, and no type is both`, span, { expected: `${first} and ${second}` });
        return;
      }
      case "occurs": {
        const e = printType(expected, namer);
        const f = printType(found, namer);
        this.error("infinite-type", `expected ${e}${where}, found ${f}: the two can be equal only if a type contains itself`, span, { expected: e, found: f });
        return;
      }
      case "missing-field": {
        const f = printType(clash.type, namer);
        const msg = clash.opaque
          ? `expected a record with the field ${clash.field}${where}, found opaque type ${f}`
          : `the type ${f} has no field ${clash.field}`;
        this.error("missing-row-field", msg, span, { expected: `{${clash.field}: _, ..}`, found: f });
        return;
      }
      case "types": {
        const e = printType(expected, namer);
        const f = printType(found, namer);
        const detail = clash.left.tag === "fun" && clash.right.tag === "fun" ? functionDifference(clash.left, clash.right) : "";
        const hint = (context.hint?.(expected, found) ?? "") || unwrapHint(expected, found);
        this.error(context.code ?? "type-mismatch", `expected ${e}${where}, found ${f}${detail}${hint}`, span, { expected: e, found: f });
        return;
      }
    }
  }

  // Statements -------------------------------------------------------------------

  /** The statements of a block or of the program, in order. Their value is the last one's when it is an expression, otherwise (). */
  private statements(items: readonly A.TopLevelItem[], program: boolean): Type {
    let last: A.TopLevelItem | undefined;
    for (const item of items) if (item.kind !== "TypeDecl" && item.kind !== "External" && item.kind !== "Open" && item.kind !== "Needs") last = item;
    let value: Type = t.unit;
    for (const item of items) {
      this.cursor = item;
      switch (item.kind) {
        case "TypeDecl":
          break;
        case "External": {
          this.error("interface-only", `external declarations are only allowed in a host interface file: a program cannot declare what the host supplies`, item.span);
          // Bound anyway, so that its uses are not errors too.
          const type = externalType(item, new TypeReader(this.table, () => {}));
          this.scope.bind(item.name, binding({ name: item.name, type, origin: "program", node: item }));
          break;
        }
        case "Open":
          this.open(item);
          break;
        case "Needs":
          this.needsDecl(item);
          break;
        case "Let":
          this.let(item, program);
          value = t.unit;
          break;
        case "LetRec":
          this.letRec(item, program);
          value = t.unit;
          break;
        default: {
          if (program && this.libraryName !== null) {
            this.error("library-item", `a library may hold only type, let, let rec, open and needs declarations at the top level`, item.span);
          }
          const type = this.infer(item);
          if (item === last) {
            value = type;
            if (program) this.programValue = { node: item, type };
          }
          else this.statementsBeforeLast.push({ node: item, type });
        }
      }
    }
    return value;
  }

  private needsDecl(node: A.Needs): void {
    if (!this.needs.includes(node.module)) this.needs.push(node.module);
    const lib = this.lookupLibrary(node.module);
    if (lib === null) {
      this.error(
        "missing-needs",
        `this ${this.libraryName ? `library (${this.libraryName})` : "program"} needs module ${node.module}, which was not supplied`,
        node.span,
        { candidates: Object.keys(this.libraries) },
      );
      return;
    }
    for (const info of lib.types) this.table.adopt(info, true);
  }

  private open(node: A.Open): void {
    const lib = this.lookupLibrary(node.module);
    if (lib === null) {
      if (node.module === "Std") {
        this.error("no-std", "open Std needs the standard library, and this check was not given one", node.span);
      } else {
        const candidates = [...(this.std ? ["Std"] : []), ...Object.keys(this.libraries)];
        const near = closest(node.module, candidates);
        this.error(
          "unknown-module",
          `unknown module ${node.module}${near ? `; did you mean ${near}?` : ""}`,
          node.span,
          { candidates },
        );
      }
      return;
    }
    if (!lib.ok && (node.module !== "Std" || !this.stdReported)) {
      if (node.module === "Std") this.stdReported = true;
      const first = lib.diagnostics.find((diagnostic) => diagnostic.severity === "error");
      if (first) {
        const { line, column } = first.span.start;
        this.error(
          "std-error",
          `${node.module === "Std" ? "the standard library" : `library ${node.module}`} does not type-check with this host: ${first.message} at ${lib.file}:${line}:${column}`,
          node.span,
        );
      }
    }
    const toImport: ValueBinding[] = [];
    if (node.names) {
      const exportNames = lib.exports.map((b) => b.name);
      for (const wanted of node.names) {
        const found = lib.exports.find((b) => b.name === wanted);
        if (!found) {
          const near = closest(wanted, exportNames);
          this.error(
            "unknown-export",
            `${node.module} does not export ${wanted}${near ? `; did you mean ${near}?` : ""}`,
            node.span,
            { candidates: exportNames },
          );
          continue;
        }
        toImport.push(found);
      }
    } else {
      toImport.push(...lib.exports);
    }
    for (const value of toImport) {
      // Never shadow a local top-level binding with an `open` (unless legacy repeated `open Std`).
      if (this.localTopLevel.has(value.name)) {
        if (node.module !== "Std" || node.names) {
          this.error("shadowed-open", `open ${node.module} cannot shadow local binding ${value.name}; qualify it as ${node.module}.${value.name}`, node.span);
          continue;
        }
      }
      const existing = this.openedBy.get(value.name);
      if (existing && !existing.some((entry) => entry.module === node.module && entry.binding === value)) {
        existing.push({ module: node.module, binding: value });
        this.scope.bind(value.name, { ambiguous: { name: value.name, modules: existing.map((e) => e.module) } });
      } else {
        if (!existing) this.openedBy.set(value.name, [{ module: node.module, binding: value }]);
        this.scope.bind(value.name, value);
      }
    }
  }

  private readAnnotation(expr: A.TypeExpression, vars: Map<string, Type> = new Map()): Type {
    const reader = new TypeReader(this.table, (diagnostic) => this.diagnostics.push(diagnostic));
    const raw = reader.read(expr, {
      lookup: (variable) => {
        let found = vars.get(variable.name);
        if (found === undefined) {
          found = newVar(this.level);
          vars.set(variable.name, found);
        }
        return found;
      },
    });
    return rebuild(raw, (leaf) => (leaf.tag === "param" ? newVar(this.level) : leaf));
  }

  private let(node: A.Let, topLevel: boolean): void {
    const drops = this.dropCount();
    this.level += 1;
    const defining = node.pattern.kind === "VarPattern" && node.value.kind === "Lambda" ? node.pattern.name : null;
    if (defining !== null) this.defining.push(defining);
    const annotated = node.annotation ? this.readAnnotation(node.annotation) : null;
    let type: Type;
    if (annotated !== null) {
      const shape = resolve(annotated);
      if (node.value.kind === "Lambda" && shape.tag === "fun") {
        type = this.lambda(node.value, shape);
      } else if (node.value.kind === "RecordLiteral") {
        type = this.record(node.value, annotated);
      } else {
        type = this.infer(node.value);
      }
      this.expect(type, annotated, valueSpan(node.value), { where: "for this annotated let binding" });
      type = annotated;
    } else {
      type = this.infer(node.value);
    }
    if (defining !== null) this.defining.pop();
    const binder: Binder = { names: new Map(), parameter: null, within: "pattern" };
    const before = this.patternErrors;
    this.pattern(node.pattern, type, binder);
    this.level -= 1;
    const bindings = [...binder.names.values()];
    // After checking a `let`, apply Haskell Rule 1 (value restriction): non-function bindings
    // (such as `let r = run(...)->wait?`) do NOT generalize `form`-constrained type variables.
    const isFunctionBinding = node.value.kind === "Lambda";
    for (const value of bindings) {
      if (isFunctionBinding || !hasFormVar(value.type)) generalize(value.type, this.level);
      if (node.pattern.kind === "VarPattern") value.lambda = this.functionOf(node.value);
      if (value.lambda) {
        const innerRuns = this.runs.filter((r) => r.enclosingLambda === value.lambda);
        const genericRun = innerRuns.find((r) => {
          const rv = resolve(r.report);
          return rv.tag === "var" && rv.level === GENERIC;
        });
        if (genericRun) {
          this.genericFormLambdas.set(value.lambda, {
            runNodes: innerRuns.map((r) => r.node),
            formVar: resolve(genericRun.report) as TVar,
          });
        }
      }
      const boundValue: ValueBinding = this.libraryName !== null && topLevel
        ? { ...value, library: this.libraryName, visibility: node.visibility === "pub" ? "pub" : "private" }
        : value;
      this.scope.bind(boundValue.name, boundValue);
      if (topLevel) {
        this.localTopLevel.add(boundValue.name);
        this.topLevel.set(boundValue.name, boundValue);
      }
    }
    this.markDropped(drops);
    this.lets.push({ pattern: node.pattern, bindings });
    this.matches.push({ kind: "let", node: node.pattern, type, rows: [{ pattern: node.pattern, guarded: false }], broken: this.patternErrors !== before });
  }

  private letRec(node: A.LetRec, topLevel: boolean): void {
    const drops = this.dropCount();
    this.level += 1;
    const bindings: ValueBinding[] = [];
    for (const rec of node.bindings) {
      if (bindings.some((other) => other.name === rec.name)) {
        this.error("duplicate-binding", `${rec.name} is bound twice in this let rec`, rec.span);
        continue;
      }
      // Each function's shape is known from its parameters, so a recursive call may leave out a label with a default.
      const shapeType = rec.annotation ? this.readAnnotation(rec.annotation) : this.shapeOf(rec.value);
      const value = binding({
        name: rec.name,
        type: shapeType,
        origin: this.libraryName !== null && topLevel ? "library" : "program",
        ...(this.libraryName !== null && topLevel ? { library: this.libraryName, visibility: node.visibility === "pub" ? "pub" : "private" } : {}),
        lambda: rec.value,
        node: rec,
      });
      bindings.push(value);
      this.scope.bind(rec.name, value);
    }
    for (const rec of node.bindings) {
      const value = bindings.find((b) => b.node === rec);
      const shape = value === undefined ? null : resolve(value.type);
      const type = this.lambda(rec.value, shape?.tag === "fun" ? shape : null);
      if (value !== undefined) {
        this.expect(type, value.type, rec.span, { where: `for ${rec.name}, as its uses inside the let rec need` });
      }
    }
    this.level -= 1;
    for (const value of bindings) {
      generalize(value.type, this.level);
      if (topLevel) {
        this.localTopLevel.add(value.name);
        this.topLevel.set(value.name, value);
      }
    }
    this.markDropped(drops);
  }

  /** Library-only invariants: pure top-level initializers and private-in-public check. */
  private checkLibraryInvariants(program: A.Program): void {
    // 1. Top-level purity: non-lambda initializers in a library cannot perform effects.
    for (const item of program.body) {
      if (item.kind !== "Let" || item.value.kind === "Lambda") continue;
      const synthetic: A.Program = { kind: "Program", body: [item.value], span: item.span };
      const initEffects = effectsSummary(synthetic, this.resolutions, this.std, this.libraries);
      if (initEffects.length > 0) {
        this.error(
          "library-effect",
          `library top-level binding performs effects (${initEffects.map((e) => e.family).join(", ")}); wrap effectful work in a function`,
          item.span,
        );
      }
    }
    // 2. Private-in-public: exported `pub` bindings and non-opaque `pub` types may not reference private types of this library.
    if (!this.hasExplicitPub && !this.strictVisibility) return;
    const privateTypes = new Set(this.ownTypes.filter((info) => info.visibility !== "pub"));
    if (privateTypes.size === 0) return;
    const findPrivate = (root: Type): TypeInfo | null => {
      const seen = new Set<Type>();
      const stack: Type[] = [root];
      while (stack.length > 0) {
        const cur = resolve(stack.pop()!);
        if (seen.has(cur)) continue;
        seen.add(cur);
        if (cur.tag === "con") {
          const info = this.table.lookupType(cur.name);
          if (info && privateTypes.has(info)) return info;
          stack.push(...cur.args);
        } else if (cur.tag === "tuple") {
          stack.push(...cur.elements);
        } else if (cur.tag === "fun") {
          stack.push(...cur.params, ...cur.labels.map((l) => l.type), cur.result);
        }
      }
      return null;
    };
    for (const value of this.exportedBindings()) {
      const leaked = findPrivate(value.type);
      if (leaked) {
        this.error(
          "private-in-public",
          `pub binding ${value.name} exposes private type ${leaked.name} in its signature; mark ${leaked.name} as pub or pub opaque`,
          value.node?.span ?? program.span,
        );
      }
    }
    for (const info of this.exportedTypes()) {
      if (info.opaque) continue;
      const parts = [
        ...info.fields.map((f) => f.type),
        ...info.constructors.flatMap((c) => c.args),
        ...(info.alias ? [info.alias] : []),
      ];
      for (const part of parts) {
        const leaked = findPrivate(part);
        if (leaked) {
          this.error(
            "private-in-public",
            `pub type ${info.name} exposes private type ${leaked.name}; mark ${leaked.name} as pub or pub opaque`,
            info.decl?.span ?? program.span,
          );
          break;
        }
      }
    }
  }

  /** The type a function literal has before its body is read: its parameters' shape, with fresh types. */
  private shapeOf(lambda: A.Lambda): TFun {
    const params: Type[] = [];
    const labels: TLabel[] = [];
    for (const param of lambda.params) {
      if (param.kind !== "LabelledParam") params.push(newVar(this.level));
      else if (!labels.some((label) => label.label === param.label)) labels.push({ label: param.label, type: newVar(this.level), optional: param.defaultValue !== null });
    }
    return fun(params, labels, newVar(this.level));
  }

  /** The named function a let binds, for the effects summary: a function literal, or another name for one. */
  private functionOf(value: A.Expression): A.Lambda | null {
    if (value.kind === "Lambda") return value;
    if (value.kind === "Identifier") return this.resolutions.get(value)?.lambda ?? null;
    return null;
  }

  /** How many places that drop a value have been seen so far. */
  private dropCount(): { statements: number; lets: number } {
    return { statements: this.statementsBeforeLast.length, lets: this.lets.length };
  }

  /**
   * After a let generalizes: a value dropped inside it whose type is now
   * generic must not become a request or a reply where the binding is used (§6a), as in
   * a helper that calls a callback and drops its result. Its type variable
   * remembers where the value is dropped.
   */
  private markDropped(since: { statements: number; lets: number }): void {
    const mark = (type: Type, span: A.Span) => {
      const shape = resolve(type);
      if (shape.tag === "var" && shape.level === GENERIC && shape.dropped === null) shape.dropped = span;
    };
    for (const { node, type } of this.statementsBeforeLast.slice(since.statements)) mark(type, node.span);
    for (const { pattern, bindings } of this.lets.slice(since.lets)) {
      for (const node of patternNodes(pattern)) {
        const type = this.patternTypes.get(node);
        if (node.kind === "WildcardPattern" && type !== undefined) mark(type, node.span);
      }
      for (const value of bindings) if (!value.used && value.node !== null) mark(value.type, value.node.span);
    }
  }

  // Expressions ------------------------------------------------------------------

  /** The type of an expression. A chain is walked from its innermost link out, in a loop. */
  infer(expression: A.Expression): Type {
    const spine: A.Expression[] = [];
    let base = expression;
    for (let inner = spineChild(base); inner !== null; inner = spineChild(base)) {
      spine.push(base);
      base = inner;
    }
    let type = this.base(base);
    for (let index = spine.length - 1; index >= 0; index -= 1) type = this.step(spine[index]!, type);
    return type;
  }

  /** An expression that is not a link of a chain. */
  private base(node: A.Expression): Type {
    this.cursor = node;
    switch (node.kind) {
      case "IntLiteral":
        return t.int;
      case "FloatLiteral":
        return t.float;
      case "StringLiteral":
        return t.string;
      case "BoolLiteral":
        return t.bool;
      case "UnitLiteral":
        return t.unit;
      case "TimeLiteral":
        return t.time;
      case "DurationLiteral":
        return t.duration;
      case "RefLiteral":
        return t.ref;
      case "TemplateLiteral":
        for (const part of node.expressions) {
          this.argument(part, t.string, { where: "in a template interpolation", hint: () => "; turn a value into text with ${x->show}" });
        }
        return t.string;
      case "ParticipantLiteral":
        // Participants are compared with their arguments, so these hold no function.
        for (const arg of node.args) this.argument(arg.value, newVar(this.level, null, true), { where: `for ~${arg.label} of a participant` });
        return t.participant;
      case "Identifier": {
        const type = this.identifier(node);
        // Passed around as a value, `run` has no place of its own to read a form from.
        const binding = this.resolutions.get(node);
        if (binding?.origin === "builtin" && node.name === "run") unify(this.reportOf(type), con("report"), this.table);
        return type;
      }
      case "QualifiedIdentifier":
        return this.qualifiedIdentifier(node);
      case "Constructor":
        return this.constructor_(node);
      case "TupleLiteral":
        return tuple(node.elements.map((element) => this.infer(element)));
      case "ListLiteral":
        return this.list(node);
      case "RecordLiteral":
        return this.record(node);
      case "Call":
        return this.call(node, this.callee(node.callee), null, node.args);
      case "Lambda":
        return this.lambda(node, null);
      case "Block":
        return this.block(node);
      case "If":
        return this.ifExpression(node);
      case "Switch":
        return this.switchExpression(node);
      case "FieldAccess":
      case "Pipe":
      case "Try":
      case "Unary":
      case "Binary":
        throw new Error(`a ${node.kind} is a link of a chain`);
    }
  }

  /** One link of a chain, given the type of what it applies to. */
  private step(node: A.Expression, inner: Type): Type {
    this.cursor = node;
    switch (node.kind) {
      case "Pipe":
        return this.call(node, this.callee(node.callee), { expression: node.left, type: inner }, node.args);
      case "Call":
        return this.call(node, { type: inner, name: null }, null, node.args);
      case "FieldAccess":
        return this.field(node, inner);
      case "Try":
        return this.tryExpression(node, inner);
      case "Unary":
        return this.unary(node, inner);
      case "Binary":
        return this.binary(node, inner);
      default:
        throw new Error(`a ${node.kind} is not a link of a chain`);
    }
  }

  /** Checks an expression against the type its context needs. A function literal or record literal is checked against it from the start. */
  private argument(node: A.Expression, expected: Type, context: Context): void {
    const shape = resolve(expected);
    if (node.kind === "Lambda" && shape.tag === "fun") {
      const type = this.lambda(node, shape);
      this.expect(type, expected, node.span, context);
      return;
    }
    if (node.kind === "RecordLiteral") {
      const type = this.record(node, expected);
      this.expect(type, expected, node.span, context);
      return;
    }
    const type = this.infer(node);
    this.expect(type, expected, valueSpan(node), context);
  }

  private identifier(node: A.Identifier): Type {
    const entry = this.scope.lookup(node.name);
    if (entry === undefined) {
      this.error("unknown-name", `unknown name ${node.name}${this.nameHint(node.name)}`, node.span);
      return newVar(this.level);
    }
    if ("ambiguous" in entry) {
      const qualified = entry.ambiguous.modules.map((m) => `${m}.${entry.ambiguous.name}`);
      this.error(
        "ambiguous-open",
        `${entry.ambiguous.name} is exported by ${both(entry.ambiguous.modules)}; qualify it as ${either(qualified)}`,
        node.span,
        { candidates: qualified },
      );
      return newVar(this.level);
    }
    if ("pending" in entry) {
      this.error(
        "later-parameter",
        `this default value cannot use ${node.name}: it is the labelled parameter ~${entry.pending.label}, declared later, which is bound only when a caller passes it`,
        node.span,
      );
      return newVar(this.level);
    }
    entry.used = true;
    this.resolutions.set(node, entry);
    return instantiate(entry.type, this.level);
  }

  private qualifiedIdentifier(node: A.QualifiedIdentifier): Type {
    const builtinMod = this.builtinModules[node.module];
    const lib = this.lookupLibrary(node.module);
    if (lib === null && !builtinMod) {
      const candidates = [...(this.std ? ["Std"] : []), ...Object.keys(this.builtinModules), ...Object.keys(this.libraries)];
      const near = closest(node.module, candidates);
      this.error(
        "unknown-module",
        `unknown module ${node.module}${near ? `; did you mean ${near}?` : ""}`,
        node.span,
        { candidates },
      );
      return newVar(this.level);
    }
    const exportsList = lib ? lib.exports : builtinMod!;
    const found = exportsList.find((b) => b.name === node.name);
    if (!found) {
      const exportNames = exportsList.map((b) => b.name);
      const near = closest(node.name, exportNames);
      this.error(
        "unknown-export",
        `${node.module} does not export ${node.name}${near ? `; did you mean ${near}?` : ""}`,
        node.span,
        { candidates: exportNames },
      );
      return newVar(this.level);
    }
    this.resolutions.set(node, found);
    return instantiate(found.type, this.level);
  }

  /**
   * Two requests that ask the same participant for the same thing are told
   * apart only by their order of evaluation. An edit that moved one would
   * give it the other's answer, so the program must tell them apart itself.
   * Only calls written entirely with literals can be compared here.
   */
  private sameRequest(node: A.Call | A.Pipe, name: string, first: A.Expression | null, args: readonly A.Argument[]): void {
    const asked = [...(first === null ? [] : [first]), ...args.filter((arg) => !(arg.kind === "LabelledArg" && arg.label === "by"))];
    const pending: unknown[] = [...asked];
    for (let part = pending.pop(); part !== undefined; part = pending.pop()) {
      if (Array.isArray(part)) pending.push(...part);
      else if (typeof part === "object" && part !== null) {
        if ("kind" in part && !LITERAL_KINDS.has(part.kind as string)) return;
        for (const [key, child] of Object.entries(part)) if (key !== "span") pending.push(child);
      }
    }
    const key = JSON.stringify([name, asked], (field, value: unknown) => (field === "span" ? undefined : value));
    const earlier = this.literalRequests.get(key);
    if (earlier === undefined) { this.literalRequests.set(key, node); return; }
    this.error(
      "same-request",
      `this ${name} asks the same participant for the same thing as the one at ${position(earlier.span)}; identical requests are told apart only by their order, so an edit that moved one would give it the other's answer: say what each is about with ~about, or word them differently`,
      node.span,
    );
  }

  /** The report type of `run`, given the type of one use of it. */
  private reportOf(run: Type): Type {
    const request = resolve((resolve(run) as TFun).result) as TCon;
    return (resolve(request.args[1]!) as TCon).args[0]!;
  }

  private nameHint(name: string): string {
    if (this.defining.includes(name)) {
      return `; a let is not recursive: write let rec ${name} = … to use ${name} in its own definition`;
    }
    if (this.std !== null && this.std.exports.some((value) => value.name === name)) {
      return `; ${name} is in the standard library: add open Std at the top of the program`;
    }
    const removed = REMOVED_NAMES.get(name);
    if (removed !== undefined) return `; ${removed}`;
    const near = closest(name, this.scope.visible());
    return near === null ? "" : `; did you mean ${near}?`;
  }

  private callee(node: A.Expression): Callee {
    if (node.kind === "Identifier") {
      const type = this.identifier(node);
      return { type, name: node.name, binding: this.resolutions.get(node) };
    }
    if (node.kind === "QualifiedIdentifier") {
      const type = this.qualifiedIdentifier(node);
      return { type, name: `${node.module}.${node.name}`, binding: this.resolutions.get(node) };
    }
    return { type: this.infer(node), name: null };
  }

  /**
   * A call: `f(args)`, or `first->f(args)`, where `first` is the first
   * positional argument. Every positional argument and every required label
   * must be given; a label with a default may be left out.
   */
  private call(node: A.Call | A.Pipe, callee: Callee, first: { expression: A.Expression; type: Type } | null, args: readonly A.Argument[]): Type {
    const calleeNode = node.callee;
    const shape = resolve(callee.type);
    const name = callee.name;
    if (shape.tag === "var") return this.callUnknown(node, shape, first, args);
    if (shape.tag !== "fun") {
      const namer = new Namer();
      const found = printType(shape, namer);
      this.error("not-a-function", `expected a function${name === null ? "" : ` for ${name}`}, found ${found}`, calleeNode.span, { expected: "a function", found });
      for (const arg of args) this.infer(arg.kind === "LabelledArg" ? arg.value : arg);
      return newVar(this.level);
    }
    if (name !== null && callee.binding?.origin === "builtin" && ["ask", "confirm", "choose", "run"].includes(name)) {
      this.sameRequest(node, name, first?.expression ?? null, args);
      if (this.requireDeadline && !args.some((a) => a.kind === "LabelledArg" && a.label === "by")) {
        this.error("missing-deadline", `${name} requires an explicit ~by deadline in edition 1 (for example ~by=8h)`, node.span);
      }
    }
    if (name !== null && callee.binding?.origin === "builtin" && ["map", "filter", "filterMap", "scan", "accepting", "mapRequest"].includes(name)) {
      const positionalArgs = [...(first ? [first.expression] : []), ...args.filter((a): a is A.Expression => a.kind !== "LabelledArg")];
      const cb = name === "scan" ? positionalArgs[2] : positionalArgs[1];
      if (cb) this.pureCallbacks.push({ name, fn: cb, span: cb.span });
    }
    if (isBuiltin(callee, "run")) {
      const report = this.reportOf(shape);
      const reportVar = resolve(report);
      if (reportVar.tag === "var") reportVar.form = true;
      const enclosingLambda = this.lambdaStack.at(-1) ?? null;
      // Haskell Rule 1: non-function value bindings do not generalize `run`'s report type;
      // functions wrapping `run` keep their report variable polymorphic (`'a: form`) for evidence passing.
      if (enclosingLambda === null) unify(report, newVar(0), this.table);
      this.runs.push({ node, report, enclosingLambda });
    }
    // Wadler-Blott call-site tracking for generic helpers wrapping `run`.
    if (callee.binding?.lambda && this.genericFormLambdas.has(callee.binding.lambda)) {
      const resultType = shape.result;
      const resolvedRes = resolve(resultType);
      const reportAtCall = resolvedRes.tag === "con" && resolvedRes.name === "reply"
        ? resolvedRes.args[0]!
        : isRequest(resolvedRes) && resolvedRes.tag === "con"
          ? (resolve(resolvedRes.args[1]!) as TCon).args[0]!
          : resolvedRes;
      this.formCallSites.push({ node, lambda: callee.binding.lambda, report: reportAtCall });
    }
    const positional = args.filter((arg): arg is A.Expression => arg.kind !== "LabelledArg");
    const given = positional.length + (first === null ? 0 : 1);
    if (given !== shape.params.length) {
      const what = name === null ? "this function" : name;
      const piped = first === null ? "" : " (the value before -> is the first)";
      this.error(
        "argument-count",
        `expected ${count(shape.params.length, "positional argument")} for ${what}, found ${given}${piped}; its type is ${printType(shape)}`,
        node.span,
        { expected: String(shape.params.length), found: String(given) },
      );
    }
    let index = 0;
    if (first !== null) {
      const param = shape.params[index];
      if (param !== undefined) this.expect(first.type, param, valueSpan(first.expression), { where: `for the ${ordinal(0)} argument of ${name ?? "this function"} (the value before ->)` });
      index += 1;
    }
    const labels = new Set<string>();
    const unknown: string[] = [];
    for (const arg of args) {
      if (arg.kind !== "LabelledArg") {
        const param = shape.params[index];
        if (param === undefined) this.infer(arg);
        else {
          this.argument(arg, param, { where: `for the ${ordinal(index)} argument of ${name ?? "this function"}` });
          if (index === 2 && isBuiltin(callee, "choose")) this.options(arg, param);
        }
        index += 1;
        continue;
      }
      if (labels.has(arg.label)) {
        this.error("duplicate-label", `~${arg.label} is passed twice`, arg.span);
        this.infer(arg.value);
        continue;
      }
      labels.add(arg.label);
      const param = shape.labels.find((label) => label.label === arg.label);
      if (param === undefined) {
        const removed = callee.binding?.origin === "builtin" && name !== null ? removedLabel(name, arg.label) : null;
        this.error("unknown-label", removed ?? unknownLabel(name, arg.label, shape), arg.span);
        unknown.push(arg.label);
        this.infer(arg.value);
        continue;
      }
      this.argument(arg.value, param.type, { where: `for ~${arg.label} of ${name ?? "this function"}` });
      if (arg.label === "about" && callee.binding?.origin === "builtin" && name !== null && ["ask", "confirm", "choose", "run", "judge"].includes(name)) {
        const leakedOpaque = this.findSealedOpaque(param.type);
        if (leakedOpaque) {
          this.error(
            "opaque-about",
            `cannot pass opaque type ${leakedOpaque.library}.${leakedOpaque.name} directly to ~about outside ${leakedOpaque.library}; ask ${leakedOpaque.library} for a public view or identifier`,
            arg.value.span,
          );
        }
      }
    }
    // A required label that an unknown one nearly spells is reported with the unknown one.
    const misspelt = new Set(unknown.map((label) => closest(label, shape.labels.map((l) => l.label))));
    const missing = shape.labels.filter((label) => !label.optional && !labels.has(label.label) && !misspelt.has(label.label));
    if (missing.length > 0) {
      const list = both(missing.map((label) => `~${label.label}`));
      this.error(
        "missing-label",
        `expected ${list} for ${name ?? "this function"}, which ${missing.length === 1 ? "requires it" : "requires them"}; its type is ${printType(shape)}`,
        node.span,
        { expected: list },
      );
    }
    if (callee.binding?.library === "Events" && callee.binding.name === "kind" && first === null) {
      const [appArg, kindArg] = positional;
      if (appArg?.kind === "StringLiteral" && kindArg?.kind === "StringLiteral") {
        const res = resolve(shape.result);
        const payload = res.tag === "con" && res.args[0] ? res.args[0] : newVar(this.level);
        this.eventKindCalls.push({ app: appArg.value, kind: kindArg.value, payload, span: node.span });
      }
    }
    if (callee.binding?.library === "Holds" && callee.binding.name === "kind" && first === null) {
      // The second argument names the type of what holds: the checker reads it as written in a type annotation.
      const [, typeArg] = positional;
      if (typeArg?.kind === "StringLiteral") {
        const info = this.table.lookupType(typeArg.value);
        if (info === undefined) {
          const near = closest(typeArg.value, [...this.table.types.keys(), ...this.table.qualifiedTypes.keys()]);
          this.error("unknown-hold-type", `unknown type ${typeArg.value} in Holds.kind${near ? `; did you mean ${near}?` : ""}`, typeArg.span);
        } else if (info.params.length === 0 && info.kind !== "alias" && info.kind !== "source") {
          const res = resolve(shape.result);
          if (res.tag === "con" && res.args[0]) unify(res.args[0], con(canonicalTypeName(info)), this.table);
        }
      }
    }
    if (callee.binding?.library === "Actions" && callee.binding.name === "action" && first === null) {
      const [appArg, nameArg] = positional;
      if (appArg?.kind === "StringLiteral" && nameArg?.kind === "StringLiteral") {
        const res = resolve(shape.result);
        const [input, output] = res.tag === "con" ? res.args : [];
        this.actionCalls.push({ app: appArg.value, name: nameArg.value, input: input ?? newVar(this.level), output: output ?? newVar(this.level), span: node.span });
      }
    }
    if (callee.binding?.library === "JSON" && callee.binding.name === "decode") {
      const res = resolve(shape.result);
      if (res.tag === "con" && res.name === "result" && res.args[0]) {
        this.jsonDecodeCalls.push({ target: res.args[0], span: node.span });
      }
    }
    return shape.result;
  }

  /** A call of a value whose type is not known yet: the call decides it, with every label it passes required. */
  private callUnknown(node: A.Call | A.Pipe, callee: Type, first: { expression: A.Expression; type: Type } | null, args: readonly A.Argument[]): Type {
    const params: Type[] = first === null ? [] : [first.type];
    const labels: TLabel[] = [];
    for (const arg of args) {
      if (arg.kind !== "LabelledArg") {
        params.push(this.infer(arg));
      } else if (labels.some((label) => label.label === arg.label)) {
        this.error("duplicate-label", `~${arg.label} is passed twice`, arg.span);
        this.infer(arg.value);
      } else {
        labels.push({ label: arg.label, type: this.infer(arg.value), optional: false });
      }
    }
    const result = newVar(this.level);
    this.expect(fun(params, labels, result), callee, node.callee.span, { where: "for the function called here" });
    return result;
  }

  /** `choose`'s options: a nonempty list of constructors of one variant type (§5). */
  private options(arg: A.Expression, type: Type): void {
    const list = resolve(type);
    const element = list.tag === "con" && list.name === "list" ? list.args[0]! : newVar(this.level);
    if (arg.kind === "ListLiteral" && arg.elements.length === 0 && arg.rest === null) {
      this.error("choose-options", "expected at least one option for choose, found an empty list", arg.span);
    }
    this.chooseOptions.push({ arg, element });
  }

  private constructor_(node: A.Constructor): Type {
    const ctor = this.table.constructors.get(node.name);
    if (ctor === undefined) {
      this.error("unknown-constructor", `unknown constructor ${node.name}${constructorHint(node.name, this.table)}`, node.span);
      for (const arg of node.args) this.infer(arg);
      return newVar(this.level);
    }
    const params = ctor.owner.params.map(() => newVar(this.level));
    const type = con(canonicalTypeName(ctor.owner), ...params);
    if (node.args.length !== ctor.args.length) {
      this.error("constructor-arity", constructorArity(ctor, node.args.length), node.span, { expected: String(ctor.args.length), found: String(node.args.length) });
      for (const arg of node.args) this.infer(arg);
      return newVar(this.level);
    }
    node.args.forEach((arg, index) => {
      const where = ctor.args.length === 1 ? `for the argument of ${ctor.name}` : `for the ${ordinal(index)} argument of ${ctor.name}`;
      this.argument(arg, substitute(ctor.args[index]!, params, this.level), { where });
    });
    return type;
  }

  private list(node: A.ListLiteral): Type {
    const element = newVar(this.level);
    node.elements.forEach((item, index) => {
      this.argument(item, element, index === 0 ? { where: "" } : { where: ", like the elements before it", hint: () => ": a list holds values of one type" });
    });
    if (node.rest !== null) this.argument(node.rest, t.list(element), { where: "for the list after ..." });
    return t.list(element);
  }

  /** Finds any sealed opaque type inside `type`, for `~about` anti-leakage checking. */
  private findSealedOpaque(type: Type): TypeInfo | null {
    const seen = new Set<Type>();
    const stack: Type[] = [type];
    while (stack.length > 0) {
      const cur = resolve(stack.pop()!);
      if (seen.has(cur)) continue;
      seen.add(cur);
      if (cur.tag === "con") {
        const info = this.table.lookupType(cur.name);
        if (info && this.table.isSealedOpaque(info)) return info;
        stack.push(...cur.args);
      } else if (cur.tag === "tuple") {
        stack.push(...cur.elements);
      } else if (cur.tag === "fun") {
        stack.push(...cur.params, ...cur.labels.map((l) => l.type), cur.result);
      }
    }
    return null;
  }

  /** A record literal has the type of the expected record (when inside its defining library or matching), or the latest declared record type with its fields. */
  private record(node: A.RecordLiteral, expected: Type | null = null): Type {
    const names: string[] = [];
    const fields: A.RecordField[] = [];
    for (const field of node.fields) {
      if (names.includes(field.name)) {
        this.error("duplicate-field", `the field ${field.name} is given twice`, field.span);
        this.infer(field.value);
        continue;
      }
      names.push(field.name);
      fields.push(field);
    }
    let info: TypeInfo | null = null;
    let args: Type[] = [];
    let type: Type;
    if (node.spread !== null) {
      type = this.infer(node.spread);
      const shape = resolve(type);
      const known = shape.tag === "con" ? this.table.lookupType(shape.name) : undefined;
      if (known?.kind === "record" && !this.table.isSealedOpaque(known)) {
        info = known;
        args = [...(shape as { args: readonly Type[] }).args];
      } else if (shape.tag === "var") {
        info = this.table.recordWith(names);
        if (info !== null) {
          args = info.params.map(() => newVar(this.level));
          const canonical = canonicalTypeName(info);
          this.expect(type, con(canonical, ...args), node.spread.span, { where: "for the record before the fields" });
        } else {
          this.unknownFields(names, fields, node);
        }
      } else {
        const found = printType(shape);
        this.error("type-mismatch", `expected a record after ..., found ${found}`, node.spread.span, { expected: "a record", found });
      }
    } else {
      const expShape = expected !== null ? resolve(expected) : null;
      const expInfo = expShape?.tag === "con" ? this.table.lookupType(expShape.name) : undefined;
      if (
        expInfo?.kind === "record" &&
        !this.table.isSealedOpaque(expInfo) &&
        expInfo.fields.length === names.length &&
        names.every((n) => expInfo.fields.some((f) => f.name === n))
      ) {
        info = expInfo;
      } else {
        info = this.table.recordExactly(names);
      }
      if (info === null) {
        const candidate = this.table.recordWith(names);
        if (candidate === null) {
          this.unknownFields(names, fields, node);
        } else {
          info = candidate;
          const missing = candidate.fields.filter((field) => !names.includes(field.name));
          const shown = missing.map((field) => `${field.name}: ${printType(field.type)}`);
          const plural = candidate.fields.length === 1 ? "field" : "fields";
          this.error(
            "missing-field",
            `expected the ${plural} ${both(candidate.fields.map((field) => field.name))} of ${candidate.name}, found only ${both(names)}: a record literal gives every field of its type, so add ${both(shown)}`,
            node.span,
            { expected: `{${candidate.fields.map((field) => `${field.name}: ${printType(field.type)}`).join(", ")}}`, found: `{${names.join(", ")}}`, missing: shown },
          );
        }
      }
      args = info === null ? [] : info.params.map(() => newVar(this.level));
      const canonical = info === null ? null : (canonicalTypeName(info));
      type = canonical === null ? newVar(this.level) : con(canonical, ...args);
    }
    for (const field of fields) {
      const declared = info?.fields.find((candidate) => candidate.name === field.name);
      if (info !== null && declared === undefined) {
        this.error("unknown-field", `the type ${info.name} has no field ${field.name}; its fields are ${both(info.fields.map((f) => f.name))}`, field.span);
      }
      if (declared === undefined) this.infer(field.value);
      else this.argument(field.value, substitute(declared.type, args, this.level), { where: `for the field ${field.name} of ${info!.name}` });
    }
    return type;
  }

  private unknownFields(names: string[], fields: A.RecordField[], node: A.RecordLiteral): void {
    const unknown = fields.find((field) => !this.table.hasField(field.name));
    if (unknown !== undefined) {
      const near = closest(unknown.name, this.table.records.flatMap((record) => record.fields.map((field) => field.name)));
      this.error("unknown-field", `unknown field ${unknown.name}: no record type has it${near === null ? "" : `; did you mean ${near}?`}`, unknown.span);
      return;
    }
    const owners = names.map((name) => `${name} is a field of ${this.table.records.filter((r) => r.fields.some((f) => f.name === name)).map((r) => r.name).join(" and ")}`);
    this.error("unknown-field", `no record type has all of the fields ${both(names)}: ${owners.join("; ")}`, node.span);
  }

  /** `x.f`: reads field `f` via row presence constraint `'r: {f: 'a, ..}` when `x`'s record type is not yet known (order-independent). */
  private field(node: A.FieldAccess, recordType: Type): Type {
    const span = fieldSpan(node);
    const shape = resolve(recordType);
    let info = shape.tag === "con" ? this.table.lookupType(shape.name) ?? null : null;
    let args: readonly Type[] = shape.tag === "con" ? shape.args : [];
    if (shape.tag === "var") {
      const matching = this.table.recordsWithAll([node.field]);
      if (matching.length === 0) {
        const near = closest(node.field, this.table.records.filter((r) => !this.table.isSealedOpaque(r)).flatMap((record) => record.fields.map((field) => field.name)));
        this.error("unknown-field", `unknown field ${node.field}: no record type has it${near === null ? "" : `; did you mean ${near}?`}`, span);
        return newVar(this.level);
      }
      // If a unique accessible record declares this field, unify directly (order-independent);
      // if multiple records share the field, attach a row presence constraint `'r: {f: 'a, ..}`.
      if (matching.length === 1 && !shape.fields?.size) {
        const only = matching[0]!;
        info = only;
        args = only.params.map(() => newVar(this.level));
        const canonical = canonicalTypeName(only);
        this.expect(recordType, con(canonical, ...args), node.record.span, { where: `for the record whose field ${node.field} is read` });
      } else {
        const existing = shape.fields?.get(node.field);
        if (existing !== undefined) return existing;
        const fieldType = newVar(Math.min(this.level, shape.level));
        shape.fields ??= new Map();
        shape.fields.set(node.field, fieldType);
        return fieldType;
      }
    } else if (info?.kind !== "record" || this.table.isSealedOpaque(info)) {
      const found = printType(shape);
      const hint = info && this.table.isSealedOpaque(info)
        ? `; ${info.library}.${info.name} is an opaque type from ${info.library}`
        : shape.tag === "con" && (shape.name === "reply" || shape.name === "option" || shape.name === "result")
          ? "; take the value out first, with ? or switch"
          : isRequest(shape) ? "; wait for the request first, with ->wait" : "";
      this.error("type-mismatch", `expected a record with the field ${node.field}, found ${found}${hint}`, node.record.span, { expected: `a record with the field ${node.field}`, found });
      return newVar(this.level);
    }
    const declared = info.fields.find((field) => field.name === node.field);
    if (declared === undefined) {
      const near = closest(node.field, info.fields.map((field) => field.name));
      this.error("unknown-field", `the type ${info.name} has no field ${node.field}; its fields are ${both(info.fields.map((field) => field.name))}${near === null ? "" : `; did you mean ${near}?`}`, span);
      return newVar(this.level);
    }
    return substitute(declared.type, args, this.level);
  }

  /**
   * `e?` (§4): on `reply<'a>`, `option<'a>` or `result<'a, 'e>` it is `'a`,
   * and the enclosing function must return the same family, with the same
   * error type for a result. At the top of a program it adds no constraint.
   * While the family of `e` is unknown, it is taken to be `reply`.
   */
  private tryExpression(node: A.Try, operand: Type): Type {
    const shape = resolve(operand);
    let family: TryFamily;
    let value: Type;
    let error: Type | null = null;
    if (shape.tag === "con" && shape.name === "reply") {
      family = "reply";
      value = shape.args[0]!;
    } else if (shape.tag === "con" && shape.name === "option") {
      family = "option";
      value = shape.args[0]!;
    } else if (shape.tag === "con" && shape.name === "result") {
      family = "result";
      value = shape.args[0]!;
      error = shape.args[1]!;
    } else if (shape.tag === "var") {
      family = "reply";
      value = newVar(this.level);
      if (!this.expect(operand, t.reply(value), node.operand.span, { where: "before ?" })) return value;
    } else {
      const found = printType(shape);
      const hint = isRequest(shape) ? ": ? does not wait; wait for the request first, with ->wait?" : "";
      this.error("try-operand", `expected a reply, option or result before ?, found ${found}${hint}`, node.span, { expected: "reply<'a>, option<'a> or result<'a, 'e>", found });
      return newVar(this.level);
    }
    const context = this.functions.at(-1);
    if (context === undefined) return value;
    const returned = family === "reply" ? t.reply(newVar(this.level))
      : family === "option" ? t.option(newVar(this.level))
      : t.result(newVar(this.level), error!);
    try {
      unify(context.returnType, returned, this.table);
      context.firstTry ??= { span: node.span, family };
    } catch (failure) {
      if (!(failure instanceof UnifyError)) throw failure;
      const namer = new Namer();
      const expected = printType(returned, namer);
      const found = printType(context.returnType, namer);
      const clash = failure.clash;
      const why = context.firstTry !== null && context.firstTry.family !== family
        ? `, but the ? at ${position(context.firstTry.span)} returns ${article(context.firstTry.family)} from it`
        : clash.kind === "class"
          ? `, but it must return ${CLASSES[clash.cls].members}${clash.cls === "handled" ? ", as a forEach handler does" : ""}`
          : `, but it returns ${found}`;
      this.error(
        "try-return",
        `? on ${article(family)} returns its other cases from the enclosing function, so the function must return ${expected}${why}`,
        node.span,
        { expected, found },
      );
    }
    return value;
  }

  private unary(node: A.Unary, operand: Type): Type {
    const type = node.op === "!" ? t.bool : node.op === "-" ? t.int : t.float;
    this.expect(operand, type, valueSpan(node.operand), { where: `for the operand of ${node.op}`, hint: arithmeticHint(node.op) });
    return type;
  }

  private binary(node: A.Binary, left: Type): Type {
    const op = node.op;
    const leftContext = { where: `for the left operand of ${op}`, hint: arithmeticHint(op) };
    const rightContext = { where: `for the right operand of ${op}`, hint: arithmeticHint(op) };
    switch (op) {
      case "||":
      case "&&":
        this.expect(left, t.bool, valueSpan(node.left), leftContext);
        this.argument(node.right, t.bool, rightContext);
        return t.bool;
      case "==":
      case "!=":
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const operand = op === "==" || op === "!=" ? newVar(this.level, null, true) : newVar(this.level, "ordered");
        // When the left operand cannot be compared, the right one would only repeat the error.
        if (this.expect(left, operand, valueSpan(node.left), leftContext)) {
          this.argument(node.right, operand, { where: `for the right operand of ${op}`, hint: () => `: both sides of ${op} have one type` });
        } else {
          this.infer(node.right);
        }
        return t.bool;
      }
      case "++":
        this.expect(left, t.string, valueSpan(node.left), leftContext);
        this.argument(node.right, t.string, rightContext);
        return t.string;
      case "+.":
      case "-.":
      case "*.":
      case "/.":
        this.expect(left, t.float, valueSpan(node.left), leftContext);
        this.argument(node.right, t.float, rightContext);
        return t.float;
      default:
        this.expect(left, t.int, valueSpan(node.left), leftContext);
        this.argument(node.right, t.int, rightContext);
        return t.int;
    }
  }

  /**
   * A function literal. Given the function type its context needs, it takes
   * its parameters' types from it, so that they are known in its body.
   */
  private lambda(node: A.Lambda, expected: TFun | null): TFun {
    this.cursor = node;
    const positional = node.params.filter((param): param is A.Pattern | A.AnnotatedParam => param.kind !== "LabelledParam");
    const labelled = node.params.filter((param): param is A.LabelledParam => param.kind === "LabelledParam");
    const fits = expected !== null && expected.params.length === positional.length && expected.labels.length === labelled.length &&
      labelled.every((param) => expected.labels.some((label) => label.label === param.label && label.optional === (param.defaultValue !== null)));
    const annotationVars = new Map<string, Type>();
    const annotatedReturn = node.returnType ? this.readAnnotation(node.returnType, annotationVars) : null;
    const initialReturn = annotatedReturn ?? (fits ? expected.result : newVar(this.level));
    if (annotatedReturn && fits) {
      this.expect(annotatedReturn, expected.result, node.returnType!.span, { where: "for the return type of this function" });
    }
    const context: FunctionContext = { returnType: initialReturn, firstTry: null };
    const mark = this.scope.mark();
    const names = new Map<string, ValueBinding>();
    const bound: ValueBinding[] = [];
    // Positional parameters are bound first: they are bound before any default is read.
    const params = positional.map((param, index) => {
      const pat = param.kind === "AnnotatedParam" ? param.pattern : param;
      const annotated = param.kind === "AnnotatedParam" ? this.readAnnotation(param.type, annotationVars) : null;
      const type = annotated ?? (fits ? expected.params[index]! : newVar(this.level));
      if (annotated && fits) {
        this.expect(annotated, expected.params[index]!, param.span, { where: `for the ${ordinal(index)} parameter` });
      }
      bound.push(...this.parameter(pat, type, names, { lambda: node, index }));
      return type;
    });
    for (const value of bound) this.scope.bind(value.name, value);
    const labels: TLabel[] = [];
    labelled.forEach((param, index) => {
      if (labels.some((label) => label.label === param.label)) {
        this.error("duplicate-label", `the label ~${param.label} appears twice in these parameters`, param.span);
        if (param.defaultValue !== null) this.infer(param.defaultValue);
        return;
      }
      const annotated = param.annotation ? this.readAnnotation(param.annotation, annotationVars) : null;
      const type = annotated ?? (fits ? expected.labels.find((label) => label.label === param.label)!.type : newVar(this.level));
      if (annotated && fits) {
        this.expect(annotated, expected.labels.find((label) => label.label === param.label)!.type, param.annotation!.span, { where: `for ~${param.label}` });
      }
      if (param.defaultValue !== null) {
        // The default is read when a call leaves the label out, inside the function: the labelled parameters after it are not bound yet.
        const pending = this.scope.mark();
        for (const later of labelled.slice(index + 1)) for (const name of patternNames(later.pattern)) this.scope.bind(name, { pending: later });
        this.functions.push(context);
        this.argument(param.defaultValue, type, { where: `for the default of ~${param.label}` });
        this.functions.pop();
        this.scope.reset(pending);
      }
      for (const value of this.parameter(param.pattern, type, names, { lambda: node, label: param.label })) this.scope.bind(value.name, value);
      labels.push({ label: param.label, type, optional: param.defaultValue !== null });
    });
    this.functions.push(context);
    this.lambdaStack.push(node);
    const body = node.body.kind === "RecordLiteral"
      ? this.record(node.body, context.returnType)
      : this.infer(node.body);
    this.lambdaStack.pop();
    this.functions.pop();
    this.expect(body, context.returnType, valueSpan(node.body), {
      where: "as the result of this function",
      hint: (expected, found) => {
        const first = context.firstTry;
        const wanted = resolve(expected);
        const got = resolve(found);
        if (first === null || wanted.tag !== "con" || (got.tag === "con" && got.name === wanted.name)) return "";
        return `; the ? at ${position(first.span)} returns ${article(first.family)} from this function early, so it must return ${article(first.family)} at its end too`;
      },
    });
    this.scope.reset(mark);
    return fun(params, labels, context.returnType);
  }

  /** A parameter's pattern, which must match every value. */
  private parameter(pattern: A.Pattern, type: Type, names: Map<string, ValueBinding>, parameter: NonNullable<ValueBinding["parameter"]>): ValueBinding[] {
    const binder: Binder = { names: new Map(), parameter, within: "parameters" };
    const before = this.patternErrors;
    this.pattern(pattern, type, binder);
    const bound: ValueBinding[] = [];
    for (const [name, value] of binder.names) {
      if (names.has(name)) {
        this.error("duplicate-binding", `${name} is bound twice in these parameters`, value.node?.span ?? pattern.span);
        continue;
      }
      names.set(name, value);
      bound.push(value);
    }
    this.matches.push({ kind: "parameter", node: pattern, type, rows: [{ pattern, guarded: false }], broken: this.patternErrors !== before });
    return bound;
  }

  private block(node: A.Block): Type {
    this.cursor = node;
    const mark = this.scope.mark();
    const type = this.statements(node.body, false);
    this.scope.reset(mark);
    return type;
  }

  /** `if … else if … else …`, in a loop. Without a final `else`, the value is () when no condition holds, so every branch must be (). */
  private ifExpression(node: A.If): Type {
    const branches: A.If[] = [];
    let last: A.Block | null = null;
    for (let at: A.If | null = node; at !== null;) {
      branches.push(at);
      const next: A.Block | A.If | null = at.elseBranch;
      if (next !== null && next.kind === "Block") last = next;
      at = next !== null && next.kind === "If" ? next : null;
    }
    const result = last === null ? t.unit : newVar(this.level);
    let first = true;
    for (const branch of branches) {
      this.cursor = branch;
      const condition = this.infer(branch.condition);
      this.expect(condition, t.bool, valueSpan(branch.condition), { where: "for the condition of if" });
      this.branch(branch.thenBranch, result, last === null, first);
      first = false;
    }
    if (last !== null) this.branch(last, result, false, false);
    return result;
  }

  private branch(block: A.Block, result: Type, withoutElse: boolean, first: boolean): void {
    const type = this.block(block);
    const span = valueSpan(block);
    if (withoutElse) {
      this.expect(type, result, span, { where: "from a branch of an if without else", hint: () => ": such an if is () when its condition is false; add an else branch" });
    } else if (first) {
      unify(result, type, this.table);
    } else {
      this.expect(type, result, span, { where: ", like the first branch of this if", hint: () => ": every branch of an if returns one type" });
    }
  }

  private switchExpression(node: A.Switch): Type {
    const scrutinee = this.infer(node.scrutinee);
    const result = newVar(this.level);
    const rows: Row[] = [];
    const before = this.patternErrors;
    node.cases.forEach((kase, index) => {
      this.cursor = kase;
      const mark = this.scope.mark();
      const binder: Binder = { names: new Map(), parameter: null, within: "pattern" };
      this.pattern(kase.pattern, scrutinee, binder);
      for (const value of binder.names.values()) this.scope.bind(value.name, value);
      if (kase.guard !== null) this.argument(kase.guard, t.bool, { where: "for the guard of this case" });
      const type = this.infer(kase.body);
      if (index === 0) unify(result, type, this.table);
      else this.expect(type, result, valueSpan(kase.body), { where: ", like the cases before it", hint: () => ": every case of a switch returns one type" });
      this.scope.reset(mark);
      rows.push({ pattern: kase.pattern, guarded: kase.guard !== null });
    });
    this.matches.push({ kind: "switch", node, type: scrutinee, rows, broken: this.patternErrors !== before });
    return result;
  }

  // Patterns ---------------------------------------------------------------------

  /** Checks a pattern against the type of the value it matches, and collects the names it binds. */
  private pattern(node: A.Pattern, type: Type, binder: Binder): void {
    this.cursor = node;
    this.patternTypes.set(node, type);
    switch (node.kind) {
      case "WildcardPattern":
        return;
      case "VarPattern": {
        if (binder.names.has(node.name)) {
          this.patternErrors += 1;
          this.error("duplicate-binding", `${node.name} is bound twice in this ${binder.within === "pattern" ? "pattern" : "parameter"}`, node.span);
          return;
        }
        binder.names.set(node.name, binding({ name: node.name, type, origin: "program", node, parameter: binder.parameter }));
        return;
      }
      case "LiteralPattern": {
        const literal = node.literal;
        const literalType = literal.kind === "IntLiteral" ? t.int
          : literal.kind === "FloatLiteral" ? t.float
          : literal.kind === "StringLiteral" ? t.string
          : literal.kind === "BoolLiteral" ? t.bool
          : t.unit;
        this.patternType(type, literalType, node);
        return;
      }
      case "ConstructorPattern": {
        const ctor = this.table.constructors.get(node.name);
        const inner: Binder = { ...binder, parameter: null };
        if (ctor === undefined) {
          this.patternErrors += 1;
          this.error("unknown-constructor", `unknown constructor ${node.name}${constructorHint(node.name, this.table)}`, node.span);
          for (const arg of node.args) this.pattern(arg, newVar(this.level), inner);
          return;
        }
        const params = ctor.owner.params.map(() => newVar(this.level));
        this.patternType(type, con(canonicalTypeName(ctor.owner), ...params), node);
        if (node.args.length !== ctor.args.length) {
          this.patternErrors += 1;
          this.error("constructor-arity", constructorArity(ctor, node.args.length), node.span, { expected: String(ctor.args.length), found: String(node.args.length) });
          for (const arg of node.args) this.pattern(arg, newVar(this.level), inner);
          return;
        }
        node.args.forEach((arg, index) => this.pattern(arg, substitute(ctor.args[index]!, params, this.level), inner));
        return;
      }
      case "TuplePattern": {
        const elements = node.elements.map(() => newVar(this.level));
        this.patternType(type, tuple(elements), node);
        node.elements.forEach((element, index) => this.pattern(element, elements[index]!, { ...binder, parameter: null }));
        return;
      }
      case "ListPattern": {
        const element = newVar(this.level);
        this.patternType(type, t.list(element), node);
        for (const item of node.elements) this.pattern(item, element, { ...binder, parameter: null });
        if (node.rest !== null) this.pattern(node.rest, t.list(element), { ...binder, parameter: null });
        return;
      }
      case "RecordPattern":
        this.recordPattern(node, type, { ...binder, parameter: null });
        return;
      case "OrPattern":
        this.orPattern(node, type, binder);
        return;
    }
  }

  private patternType(type: Type, patternType: Type, node: A.Pattern): void {
    try {
      unify(type, patternType, this.table);
    } catch (error) {
      if (!(error instanceof UnifyError)) throw error;
      this.patternErrors += 1;
      const namer = new Namer();
      const expected = printType(type, namer);
      const found = printType(patternType, namer);
      const hint = isRequest(type) && isReply(patternType) ? "; this is a request: wait for its reply with ->wait" : "";
      this.error("type-mismatch", `expected a pattern of type ${expected}, found one of type ${found}${hint}`, node.span, { expected, found });
    }
  }

  private recordPattern(node: A.RecordPattern, type: Type, binder: Binder): void {
    const names: string[] = [];
    for (const field of node.fields) {
      if (names.includes(field.name)) {
        this.patternErrors += 1;
        this.error("duplicate-field", `the field ${field.name} appears twice in this pattern`, field.span);
      }
      names.push(field.name);
    }
    const shape = resolve(type);
    let info = shape.tag === "con" ? this.table.types.get(shape.name) ?? null : null;
    let args: readonly Type[] = shape.tag === "con" ? shape.args : [];
    if (info?.kind !== "record") {
      info = this.table.recordWith(names);
      if (info === null) {
        this.patternErrors += 1;
        const unknown = node.fields.find((field) => !this.table.hasField(field.name));
        if (unknown !== undefined) this.error("unknown-field", `unknown field ${unknown.name}: no record type has it`, unknown.span);
        else this.error("unknown-field", `no record type has all of the fields ${both(names)}`, node.span);
        for (const field of node.fields) this.pattern(field.pattern, newVar(this.level), binder);
        return;
      }
      args = info.params.map(() => newVar(this.level));
      this.patternType(type, con(canonicalTypeName(info), ...args), node);
    }
    for (const field of node.fields) {
      const declared = info.fields.find((candidate) => candidate.name === field.name);
      if (declared === undefined) {
        this.patternErrors += 1;
        this.error("unknown-field", `the type ${info.name} has no field ${field.name}; its fields are ${both(info.fields.map((f) => f.name))}`, field.span);
        this.pattern(field.pattern, newVar(this.level), binder);
        continue;
      }
      this.pattern(field.pattern, substitute(declared.type, args, this.level), binder);
    }
  }

  /** Every alternative matches the same type and binds the same names, with the same types. */
  private orPattern(node: A.OrPattern, type: Type, binder: Binder): void {
    let first: Map<string, ValueBinding> | null = null;
    for (const alternative of node.alternatives) {
      const names = new Map<string, ValueBinding>();
      this.pattern(alternative, type, { names, parameter: null, within: binder.within });
      if (first === null) {
        first = names;
        continue;
      }
      const missing = [...first.keys()].filter((name) => !names.has(name));
      const extra = [...names.keys()].filter((name) => !first!.has(name));
      if (missing.length > 0 || extra.length > 0) {
        this.patternErrors += 1;
        const parts = [
          ...(missing.length > 0 ? [`the first alternative binds ${both(missing)}, and this one does not`] : []),
          ...(extra.length > 0 ? [`this alternative binds ${both(extra)}, and the first does not`] : []),
        ];
        this.error("or-pattern-bindings", `every alternative of a pattern binds the same names: ${parts.join("; ")}`, alternative.span);
      }
      for (const [name, value] of names) {
        const original = first.get(name);
        if (original === undefined) continue;
        try {
          unify(original.type, value.type, this.table);
        } catch (error) {
          if (!(error instanceof UnifyError)) throw error;
          this.patternErrors += 1;
          const namer = new Namer();
          const expected = printType(original.type, namer);
          const found = printType(value.type, namer);
          this.error("type-mismatch", `expected ${name} to have type ${expected}, as in the first alternative, found ${found}`, value.node!.span, { expected, found });
        }
      }
    }
    for (const [name, value] of first ?? []) {
      if (binder.names.has(name)) {
        this.patternErrors += 1;
        this.error("duplicate-binding", `${name} is bound twice in this pattern`, value.node!.span);
        continue;
      }
      binder.names.set(name, value);
    }
  }

  // After inference --------------------------------------------------------------

  private finish(): void {
    for (const { arg, element } of this.chooseOptions) {
      const shape = resolve(element);
      if (shape.tag === "var") continue;
      const info = shape.tag === "con" ? this.table.types.get(shape.name) : undefined;
      if (info?.kind === "variant") continue;
      const found = printType(t.list(shape));
      this.error(
        "choose-options",
        `expected constructors of one variant type for the options of choose, found ${found}; declare the choices as a type, as in type choice = Ship | Drop`,
        arg.span,
        { expected: "list<'a> where 'a is a variant type", found },
      );
    }
    for (const { node, report, enclosingLambda } of this.runs) {
      const resolved = resolve(report);
      // Skip `run` calls inside a generic form-evidence helper: their forms are passed from call sites via `~__form`.
      if (enclosingLambda && this.genericFormLambdas.has(enclosingLambda) && resolved.tag === "var" && resolved.level === GENERIC) {
        if (!this.formEvidence.lambdas.includes(enclosingLambda)) this.formEvidence.lambdas.push(enclosingLambda);
        this.formEvidence.forwardedRuns.push(node);
        continue;
      }
      let defaulted = false;
      if (resolved.tag === "var") {
        // Resolve row-constrained `run` reports to a matching record if unambiguous, else default host `report`.
        if (resolved.fields && resolved.fields.size > 0) {
          const matching = this.table.recordsWithAll([...resolved.fields.keys()]);
          if (matching.length > 0) {
            const picked = matching.at(-1)!;
            const args = picked.params.map(() => newVar(0));
            const canonical = canonicalTypeName(picked);
            this.expect(report, con(canonical, ...args), node.span, { where: "for the report of this run" });
          } else {
            defaulted = true;
            unify(report, con("report"), this.table);
          }
        } else {
          defaulted = true;
          unify(report, con("report"), this.table);
          if (this.warnDefaultReport) {
            this.warning("default-report-form", "this run's report type was not constrained and defaults to the host report", node.span);
          }
        }
      }
      const form = formOf(report, this.table);
      if (typeof form === "object" && "opaque" in form) {
        const found = printType(resolve(report));
        this.error(
          "opaque-form",
          `this run cannot report opaque type ${form.library}.${form.name}: only ${form.library} can construct ${form.name}`,
          node.span,
          { found },
        );
        continue;
      }
      if (typeof form !== "string") { this.reports.push({ node, form, ...(defaulted ? { defaulted: true } : {}) }); continue; }
      const found = printType(resolve(report));
      this.error(
        "report-form",
        form === "a reply"
          ? `this run would report ${found}: a participant reports a value, never a reply; a function that uses ? on this run must end with Answered(value), not with the bare value`
          : `this run would report ${found}, which holds ${form}; a report is made of text, numbers, times, participants, lists, tuples, records and variants`,
        node.span,
        { found },
      );
    }
    // Resolve concrete ReportForm at each call site of a generic form helper.
    for (const site of this.formCallSites) {
      const resolved = resolve(site.report);
      if (resolved.tag === "var") {
        if (resolved.fields && resolved.fields.size > 0) {
          const matching = this.table.recordsWithAll([...resolved.fields.keys()]);
          if (matching.length > 0) {
            const picked = matching.at(-1)!;
            const args = picked.params.map(() => newVar(0));
            const canonical = canonicalTypeName(picked);
            this.expect(site.report, con(canonical, ...args), site.node.span, { where: "for the report at this call site" });
          } else {
            unify(site.report, con("report"), this.table);
          }
        } else {
          unify(site.report, con("report"), this.table);
        }
      }
      const form = formOf(site.report, this.table);
      if (typeof form === "object" && "opaque" in form) {
        this.error(
          "opaque-form",
          `this call cannot report opaque type ${form.library}.${form.name}: only ${form.library} can construct ${form.name}`,
          site.node.span,
        );
      } else if (typeof form === "string") {
        this.error("report-form", `this call would report ${printType(resolve(site.report))}, which holds ${form}`, site.node.span);
      } else {
        this.formEvidence.callSites.push({ node: site.node, form });
      }
    }
    // Validate `Events.kind(app, kind)` calls against connector manifests.
    for (const ev of this.eventKindCalls) {
      for (const d of validateEventKindAgainstManifests(ev.app, ev.kind, ev.payload, ev.span, this.table, this.manifests)) {
        this.diagnostics.push(d);
      }
    }
    // Validate `Actions.action(app, name)` calls against connector manifests.
    for (const action of this.actionCalls) {
      for (const d of validateActionAgainstManifests(action.app, action.name, action.input, action.output, action.span, this.table, this.manifests)) {
        this.diagnostics.push(d);
      }
    }
    // Anti-leakage rule 1 for `JSON.decode`: cannot decode into an external opaque type.
    for (const dec of this.jsonDecodeCalls) {
      const form = formOf(dec.target, this.table);
      if (typeof form === "object" && "opaque" in form) {
        this.error(
          "opaque-form",
          `JSON.decode cannot construct opaque type ${form.library}.${form.name}: only ${form.library} can construct ${form.name}`,
          dec.span,
        );
      }
    }
    // Static purity enforcement (`{}`) on stream combinators & accepting callbacks.
    for (const cb of this.pureCallbacks) {
      const targetBody: A.TopLevelItem[] = cb.fn.kind === "Lambda" ? [cb.fn.body] : [cb.fn];
      const synthetic: A.Program = { kind: "Program", body: targetBody, span: cb.span };
      const cbEffects = effectsSummary(synthetic, this.resolutions, this.std, this.libraries);
      if (cbEffects.length > 0) {
        this.error(
          "impure-callback",
          `${cb.name} callback must be pure and cannot perform effects (${cbEffects.map((e) => e.family).join(", ")})`,
          cb.span,
        );
      }
    }
    for (const match of this.matches) if (!match.broken) this.analyze(match);
    this.drops();
  }

  private analyze(match: Match): void {
    this.cursor = match.node;
    const report = analyzeMatch(match.type, match.rows, this.table);
    if (report.missing.length > 0) {
      const missing = report.missing;
      if (match.kind === "switch") {
        const node = match.node as A.Switch;
        const keyword = keywordSpan(node.span, "switch");
        // A missing case made of wildcards only, such as (_, _), is any value: the switch needs a catch-all.
        const catchAll = missing.length === 1 && /^[_(), ]+$/.test(missing[0]!);
        const message = match.rows.every((row) => row.guarded)
          ? `this switch has a guard on every case, and a guard can be false: add a case without one, such as ${missing.join(" or ")} => …`
          : catchAll
            ? `this switch does not handle every value of type ${printType(match.type)}: add a catch-all case, such as _ => …`
            : `this switch does not handle ${either(missing)}`;
        this.error("non-exhaustive", message, keyword, { missing });
      } else {
        const node = match.node as A.Pattern;
        const what = match.kind === "let"
          ? "a let takes apart only a value that always matches, such as a tuple or a record; use switch, or ? on a reply, option or result"
          : "a parameter takes apart only a value that always matches; switch on the value inside the function instead";
        this.error("refutable-pattern", `this pattern does not match every value: it misses ${either(missing)}; ${what}`, node.span, { missing });
      }
    }
    for (const unreachable of report.unreachable) {
      this.warning(
        "unreachable-case",
        unreachable.alternative
          ? "this alternative can never match: the patterns before it cover every value it matches"
          : "this case can never match: the cases before it cover every value it matches",
        unreachable.pattern.span,
      );
    }
  }

  /**
   * §6a: a request is waited on, handed over, returned or cancelled, and a
   * reply is handled, propagated, ended with `fail`, returned or set aside
   * with `ignore`. Neither is dropped.
   */
  private drops(): void {
    const kindOf = (type: Type): "request" | "reply" | null => (isRequest(type) ? "request" : isReply(type) ? "reply" : null);
    for (const { node, type } of this.statementsBeforeLast) {
      const kind = kindOf(type);
      if (kind === null) continue;
      this.cursor = node;
      this.error(`dropped-${kind}`, `this ${printType(type)} is dropped: only the last statement of a block gives its value; ${DROP_ADVICE[kind]}`, node.span, { found: printType(type) });
    }
    for (const { pattern, bindings } of this.lets) {
      for (const node of patternNodes(pattern)) {
        const type = this.patternTypes.get(node);
        const kind = node.kind === "WildcardPattern" && type !== undefined ? kindOf(type) : null;
        if (kind === null) continue;
        const what = node === pattern ? "let _ = … drops this" : "this _ drops a";
        this.error(`dropped-${kind}`, `${what} ${printType(type!)}; ${DROP_ADVICE[kind]}`, node.span, { found: printType(type!) });
      }
      for (const value of bindings) {
        const kind = value.used ? null : kindOf(value.type);
        if (kind === null) continue;
        const advice = kind === "request"
          ? `wait for it with ${value.name}->wait, hand it over, return it, or cancel(${value.name})`
          : `handle it with switch, ? or fail, or write ignore(${value.name}) to drop it on purpose`;
        this.error(`unused-${kind}`, `${value.name} holds a ${printType(value.type)} that is never used; ${advice}`, value.node!.span, { found: printType(value.type) });
      }
    }
    const last = this.programValue;
    if (last !== null && isRequest(last.type)) {
      this.cursor = last.node;
      this.error(
        "dropped-request",
        `this ${printType(last.type)} is the program's last value, so nothing waits for it, and it is cancelled when the program ends; ${DROP_ADVICE.request}`,
        last.node.span,
        { found: printType(last.type) },
      );
    }
  }
}

/** What to do instead of dropping a request or a reply (§6a). */
const DROP_ADVICE = {
  request: "wait for it with ->wait, hand it over with handOver, return it, or call it off with cancel(…)",
  reply: "handle it with switch, ? or fail, or write ignore(…) to drop it on purpose",
} as const;

// Helpers ------------------------------------------------------------------------

/** The class constraints of §3: what a message calls their members, and its code. */
const CLASSES: { readonly [C in ClassName]: { code: Code; name: string; members: string; hint: string } } = {
  ordered: { code: "not-ordered", name: "ordered (int, float, string, time or duration)", members: "int, float, string, time or duration", hint: ": only those have an order" },
  deadline: { code: "not-a-deadline", name: "a deadline (time or duration)", members: "time or duration", hint: ": a deadline is a time, or a duration from now" },
  addressee: { code: "not-an-addressee", name: "an addressee (participant or ref)", members: "participant or ref", hint: "" },
  handled: {
    code: "not-handled",
    name: "what a forEach handler returns (() or a reply)",
    members: "() or a reply",
    hint: ": a forEach handler returns one of them; wrap a value that does not matter in ignore(…)",
  },
  equality: { code: "not-comparable", name: "comparable with ==", members: "a type without functions", hint: ": functions cannot be compared" },
  discardable: { code: "dropped-reply", name: "neither a request nor a reply", members: "a value that is neither a request nor a reply", hint: "" },
  ignorable: {
    code: "dropped-request",
    name: "not a request",
    members: "a value that is not a request",
    hint: ": ignore cannot set a request aside, since nothing would wait for it; wait for it with ->wait, hand it over, return it, or cancel(…) it",
  },
};

/** Calls, pipes, field accesses, `?`, prefix and binary operators: the inner link of each, or null. */
/** The node kinds of an expression that is the same value wherever it is written. */
const LITERAL_KINDS = new Set([
  "StringLiteral", "IntLiteral", "FloatLiteral", "BoolLiteral", "UnitLiteral", "TimeLiteral", "DurationLiteral", "RefLiteral",
  "ParticipantLiteral", "Constructor", "TupleLiteral", "ListLiteral", "RecordLiteral", "RecordField", "LabelledArg",
]);

function spineChild(node: A.Expression): A.Expression | null {
  switch (node.kind) {
    case "Pipe":
      return node.left;
    case "Call":
      // A call of a name or qualified module name is a chain's base.
      return node.callee.kind === "Identifier" || node.callee.kind === "QualifiedIdentifier" ? null : node.callee;
    case "FieldAccess":
      return node.record;
    case "Try":
      return node.operand;
    case "Unary":
      return node.operand;
    case "Binary":
      return node.left;
    default:
      return null;
  }
}

/** Where an expression's value comes from, for an error about its type: the last expression of a block. */
function valueSpan(node: A.Expression): A.Span {
  let at: A.Expression = node;
  for (;;) {
    if (at.kind !== "Block") return at.span;
    const last = at.body.at(-1);
    if (last === undefined || last.kind === "Let" || last.kind === "LetRec") return at.span;
    at = last;
  }
}

/** The span of a field access's field name. */
function fieldSpan(node: A.FieldAccess): A.Span {
  const end = node.span.end;
  const length = node.field.length;
  return { start: { line: end.line, column: end.column - length, offset: end.offset - length }, end: { ...end } };
}

/** The span of a keyword at the start of a node: `switch`. */
function keywordSpan(span: A.Span, keyword: string): A.Span {
  const start = span.start;
  return { start: { ...start }, end: { line: start.line, column: start.column + keyword.length, offset: start.offset + keyword.length } };
}

function position(span: A.Span): string {
  return `${span.start.line}:${span.start.column}`;
}

function article(family: TryFamily): string {
  return family === "reply" ? "a reply" : family === "option" ? "an option" : "a result";
}

function arithmeticHint(op: string): (expected: Type, found: Type) => string {
  return (expected, found) => {
    const e = resolve(expected);
    const f = resolve(found);
    if (e.tag !== "con" || f.tag !== "con") return "";
    if (e.name === "int" && f.name === "float") return `; ${op} takes ints: use ${op === "-" && op.length === 1 ? "-." : `${op}.`} for floats`;
    if (e.name === "float" && f.name === "int") return `; ${op} takes floats: write a float literal such as 1.0, or use ${op.slice(0, -1)} for ints`;
    if (e.name === "int" && f.name === "string" && op === "+") return "; use ++ to join strings";
    if (e.name === "string" && op === "++") return "; turn a value into text with show(x)";
    return "";
  };
}

/**
 * Advice when a request is found where its reply or value is expected, a
 * `->wait` may be missing; when a reply, option or result is, a `?`.
 */
function unwrapHint(expected: Type, found: Type): string {
  const e = resolve(expected);
  const f = resolve(found);
  if (e.tag === "var" || f.tag !== "con") return "";
  if (isRequest(f) && !(e.tag === "con" && e.name === SOURCE)) return "; this is a request: wait for its reply with ->wait";
  const families = ["reply", "option", "result"];
  if (!families.includes(f.name)) return "";
  if (e.tag === "con" && families.includes(e.name)) return "";
  return `; take the value out of the ${f.name} with ? or switch`;
}

/** Whether a type contains an ungeneralized `form`-constrained type variable (Haskell Rule 1 value restriction). */
function hasFormVar(root: Type): boolean {
  const seen = new Set<Type>();
  const stack: Type[] = [root];
  while (stack.length > 0) {
    const cur = resolve(stack.pop()!);
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cur.tag === "var") {
      if (cur.form) return true;
      if (cur.fields) for (const ft of cur.fields.values()) stack.push(ft);
    } else if (cur.tag === "con") {
      stack.push(...cur.args);
    } else if (cur.tag === "tuple") {
      stack.push(...cur.elements);
    } else if (cur.tag === "fun") {
      stack.push(...cur.params, ...cur.labels.map((l) => l.type), cur.result);
    }
  }
  return false;
}

/** Whether a call's callee is the built-in of this name. */
function isBuiltin(callee: Callee, name: string): boolean {
  return callee.binding?.origin === "builtin" && callee.name === name;
}

/** The hint for an unknown constructor: what replaced a removed one, or the nearest one declared. */
function constructorHint(name: string, table: TypeTable): string {
  const removed = REMOVED_CONSTRUCTORS.get(name);
  if (removed !== undefined) return `; ${removed}`;
  const near = closest(name, table.constructors.keys());
  return near === null ? "" : `; did you mean ${near}?`;
}

function unknownLabel(name: string | null, label: string, shape: TFun): string {
  const what = name ?? "this function";
  if (shape.labels.length === 0) return `${what} has no labelled argument ~${label}; it takes no labelled arguments`;
  const near = closest(label, shape.labels.map((l) => l.label));
  return `${what} has no labelled argument ~${label}; it takes ${both(shape.labels.map((l) => `~${l.label}`))}${near === null ? "" : `; did you mean ~${near}?`}`;
}

function constructorArity(ctor: CtorInfo, found: number): string {
  const takes = ctor.args.length;
  const example = takes === 0 ? ctor.name : `${ctor.name}(${ctor.args.map((arg) => printType(arg)).join(", ")})`;
  return `expected ${takes === 0 ? "no arguments" : count(takes, "argument")} for ${ctor.name}, found ${found}: it is written ${example}`;
}

/** How two function types of different shapes differ: arity, or a label. */
function functionDifference(a: TFun, b: TFun): string {
  if (sameShape(a, b)) return "";
  if (a.params.length !== b.params.length) return `: one takes ${count(a.params.length, "positional argument")} and the other ${b.params.length}`;
  for (const label of a.labels) {
    const other = b.labels.find((candidate) => candidate.label === label.label);
    if (other === undefined) return `: only one of them takes ~${label.label}`;
    if (other.optional !== label.optional) return `: ~${label.label} is optional in one and required in the other`;
  }
  const extra = b.labels.find((label) => !a.labels.some((other) => other.label === label.label));
  return extra === undefined ? "" : `: only one of them takes ~${extra.label}`;
}

/** The names a pattern binds, without checking it. */
function patternNames(pattern: A.Pattern): string[] {
  return patternNodes(pattern).flatMap((node) => (node.kind === "VarPattern" ? [node.name] : []));
}

/** Every pattern node inside a pattern, itself included. */
function patternNodes(pattern: A.Pattern): A.Pattern[] {
  const nodes: A.Pattern[] = [];
  const stack: A.Pattern[] = [pattern];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    nodes.push(node);
    switch (node.kind) {
      case "ConstructorPattern":
        stack.push(...node.args);
        break;
      case "TuplePattern":
        stack.push(...node.elements);
        break;
      case "ListPattern":
        stack.push(...node.elements, ...(node.rest === null ? [] : [node.rest]));
        break;
      case "RecordPattern":
        stack.push(...node.fields.map((field) => field.pattern));
        break;
      case "OrPattern":
        stack.push(...node.alternatives);
        break;
      default:
        break;
    }
  }
  return nodes;
}

