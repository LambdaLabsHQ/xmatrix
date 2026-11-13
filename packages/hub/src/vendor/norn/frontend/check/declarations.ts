// Vendored from norn-lang/norn@4ea1312845432b288450bcf42411efe29d421882; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Type declarations: the table of the types a program sees, built in, from
 * its host interface, from the standard library and its own (docs/types.md
 * §2). Type and constructor names are global to a program and the interfaces
 * it sees, so a name declared twice is an error, and declarations are read
 * before anything else: a type may refer to itself and to types declared
 * after it.
 */
import type * as A from "../ast.js";
import { closest, type CheckDiagnostic } from "./diagnostics.js";
import { REMOVED_TYPES } from "./removed.js";
import {
  FACT, GENERIC, OCCURRENCE, REQUEST, SOURCE, con, fun, newVar, rebuild, requestOf, source, tuple, type EqualityRule, type TLabel, type TParam, type Type,
  type TypeFacts,
} from "./types.js";

export type Origin = "builtin" | "host" | "std" | "program";

export interface TypeInfo {
  readonly name: string;
  readonly params: readonly string[];
  /** `source` is one of `event`, `stream` and `request`: names of the internal source type. */
  readonly kind: "base" | "list" | "variant" | "record" | "alias" | "abstract" | "source";
  readonly origin: Origin;
  readonly decl: A.TypeDecl | null;
  constructors: CtorInfo[];
  fields: FieldInfo[];
  /** What an alias stands for, once read; its parameters are TParams. */
  alias: Type | null;
  /** For a source name: the kind of source it names. */
  readonly sourceKind: Type | null;
  equality: { never: boolean; params: Set<number> };
}

export interface CtorInfo {
  readonly name: string;
  readonly owner: TypeInfo;
  /** The payload types, in terms of the owner's parameters. */
  args: Type[];
  /** The position among the owner's constructors. */
  readonly index: number;
  readonly decl: A.ConstructorDecl | null;
}

export interface FieldInfo {
  readonly name: string;
  type: Type;
  readonly decl: A.FieldDecl | null;
}

/** The types, constructors and record fields that a program sees. */
export class TypeTable implements TypeFacts {
  readonly types: Map<string, TypeInfo>;
  readonly constructors: Map<string, CtorInfo>;
  /** Record types in declaration order, for field-directed resolution. */
  readonly records: TypeInfo[];

  constructor(parent?: TypeTable) {
    this.types = new Map(parent?.types);
    this.constructors = new Map(parent?.constructors);
    this.records = [...(parent?.records ?? [])];
  }

  equalityRule(name: string): EqualityRule {
    const info = this.types.get(name);
    if (info === undefined) return { never: false, params: [] };
    return { never: info.equality.never, params: [...info.equality.params] };
  }

  /** The latest declared record type with all of these fields, or null. */
  recordWith(fields: readonly string[]): TypeInfo | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (fields.every((field) => record.fields.some((declared) => declared.name === field))) return record;
    }
    return null;
  }

  /** The latest declared record type whose fields are exactly these, or null. */
  recordExactly(fields: readonly string[]): TypeInfo | null {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]!;
      if (record.fields.length === fields.length && fields.every((field) => record.fields.some((declared) => declared.name === field))) return record;
    }
    return null;
  }

  /** Whether any record type has a field of this name. */
  hasField(field: string): boolean {
    return this.records.some((record) => record.fields.some((declared) => declared.name === field));
  }

  /** Adds a type that was read elsewhere, such as one of the standard library's. */
  adopt(info: TypeInfo): void {
    this.types.set(info.name, info);
    for (const ctor of info.constructors) this.constructors.set(ctor.name, ctor);
    if (info.kind === "record") this.records.push(info);
  }
}

/** A part of a type that the checker could not read; each use of it is a fresh variable, so one mistake gives one error. */
export const UNREADABLE: TParam = { tag: "param", index: -1, name: "_" };

export function typeInfo(fields: Partial<TypeInfo> & Pick<TypeInfo, "name" | "kind" | "origin">): TypeInfo {
  return {
    params: [],
    decl: null,
    constructors: [],
    fields: [],
    alias: null,
    sourceKind: null,
    equality: { never: false, params: new Set() },
    ...fields,
  };
}

/** How type variables in a type expression are read. */
interface TypeVariables {
  lookup(node: A.TypeVar): Type;
}

type Report = (diagnostic: CheckDiagnostic) => void;

/** Reads type expressions against a table, reporting unknown names and wrong arities. */
export class TypeReader {
  private readonly table: TypeTable;
  private readonly report: Report;
  /** Aliases being read, to find cycles. */
  private readonly reading = new Set<TypeInfo>();

  constructor(table: TypeTable, report: Report) {
    this.table = table;
    this.report = report;
  }

  /** A type expression as a type. A part that cannot be read is reported, and is UNREADABLE in the result. */
  read(node: A.TypeExpression, variables: TypeVariables): Type {
    switch (node.kind) {
      case "TypeVar":
        return variables.lookup(node);
      case "TupleType":
        return tuple(node.elements.map((element) => this.read(element, variables)));
      case "FunctionType": {
        const params: Type[] = [];
        const labels: TLabel[] = [];
        for (const param of node.params) {
          if (param.kind !== "LabelledType") {
            params.push(this.read(param, variables));
            continue;
          }
          if (labels.some((label) => label.label === param.label)) {
            this.report({ severity: "error", code: "duplicate-label", message: `the label ~${param.label} appears twice in this function type`, span: param.span });
            continue;
          }
          labels.push({ label: param.label, type: this.read(param.type, variables), optional: param.optional });
        }
        return fun(params, labels, this.read(node.result, variables));
      }
      case "TypeName":
        return this.readName(node, variables);
    }
  }

  private readName(node: A.TypeName, variables: TypeVariables): Type {
    const info = this.table.types.get(node.name);
    const args = node.args.map((arg) => this.read(arg, variables));
    if (info === undefined) {
      const removed = REMOVED_TYPES.get(node.name);
      const hint = node.name === "source"
        ? "; write event<…>, stream<…> or request<…>"
        : removed !== undefined ? `; ${removed}` : suggestion(closest(node.name, this.table.types.keys()));
      this.report({ severity: "error", code: "unknown-type", message: `unknown type ${node.name}${hint}`, span: node.span });
      return UNREADABLE;
    }
    if (args.length !== info.params.length) {
      const expected = info.params.length === 0 ? "no type arguments" : `${info.params.length} type argument${info.params.length === 1 ? "" : "s"}`;
      const example = info.params.length === 0 ? "" : `, as in ${info.name}<${info.params.map((param) => `'${param}`).join(", ")}>`;
      this.report({
        severity: "error",
        code: "type-arity",
        message: `expected ${expected} for ${info.name}, found ${args.length}${example}`,
        span: node.span,
      });
      return UNREADABLE;
    }
    switch (info.kind) {
      case "source":
        // A request<'a> is waited on for a reply<'a>.
        return info.sourceKind === REQUEST ? requestOf(args[0]!) : source(info.sourceKind!, args[0]!);
      case "alias":
        return rebuild(this.aliasOf(info), (leaf) => (leaf.tag === "param" && leaf.index >= 0 ? args[leaf.index]! : leaf));
      default:
        return con(info.name, ...args);
    }
  }

  /** What an alias stands for, reading it the first time; an alias that refers to itself is an error. */
  aliasOf(info: TypeInfo): Type {
    if (info.alias !== null) return info.alias;
    const decl = info.decl!;
    if (this.reading.has(info)) {
      this.report({
        severity: "error",
        code: "cyclic-type",
        message: `the type alias ${info.name} refers to itself; declare a variant instead, as in type ${info.name} = ${capitalize(info.name)}(…)`,
        span: decl.span,
      });
      info.alias = UNREADABLE;
      return info.alias;
    }
    this.reading.add(info);
    const alias = this.read(decl.definition as A.TypeExpression, parameterScope(info, this.report));
    this.reading.delete(info);
    if (info.alias === null) info.alias = alias;
    return info.alias;
  }
}

/** The parameters of a declaration, as TParams; any other type variable is an error. */
function parameterScope(info: TypeInfo, report: Report): TypeVariables {
  return {
    lookup(node) {
      const index = info.params.indexOf(node.name);
      if (index >= 0) return { tag: "param", index, name: node.name };
      report({
        severity: "error",
        code: "unknown-type-variable",
        message: `the type variable '${node.name} is not a parameter of ${info.name}; declare it, as in type ${info.name}<${[...info.params, node.name].map((p) => `'${p}`).join(", ")}>`,
        span: node.span,
      });
      return UNREADABLE;
    },
  };
}

/**
 * Declares a batch of type declarations, which may refer to each other in any
 * order. Abstract types are allowed only where `abstract` says so: in host
 * interface files.
 */
export function declareTypes(table: TypeTable, decls: readonly A.TypeDecl[], origin: Origin, report: Report, abstract: boolean): TypeInfo[] {
  const declared: TypeInfo[] = [];
  for (const decl of decls) {
    const existing = table.types.get(decl.name);
    if (existing !== undefined) {
      report({
        severity: "error",
        code: "duplicate-type",
        message: existing.origin === "builtin"
          ? `the type ${decl.name} is built in; choose another name`
          : `the type ${decl.name} is already declared${where(existing)}; type names are global, so choose another name`,
        span: decl.span,
      });
      continue;
    }
    const params: string[] = [];
    for (const param of decl.params) {
      if (params.includes(param.name)) {
        report({ severity: "error", code: "duplicate-type-parameter", message: `the type parameter '${param.name} is listed twice`, span: param.span });
      }
      params.push(param.name);
    }
    const definition = decl.definition;
    const kind = definition === null ? "abstract"
      : definition.kind === "VariantType" ? "variant"
      : definition.kind === "RecordType" ? "record"
      : "alias";
    if (definition === null && !abstract) {
      report({
        severity: "error",
        code: "interface-only",
        message: `an abstract type such as 'type ${decl.name}' can only be declared in a host interface file; give it a definition, as in type ${decl.name} = ${capitalize(decl.name)}`,
        span: decl.span,
      });
    }
    const info = typeInfo({ name: decl.name, params, kind, origin, decl });
    if (kind === "abstract") info.equality.params = new Set(params.map((_, index) => index));
    table.types.set(decl.name, info);
    declared.push(info);
  }
  // Constructors and fields, once every name is known.
  for (const info of declared) {
    const definition = info.decl!.definition;
    if (definition?.kind === "VariantType") {
      for (const decl of definition.constructors) {
        const existing = table.constructors.get(decl.name);
        if (existing !== undefined) {
          report({
            severity: "error",
            code: "duplicate-constructor",
            message: `the constructor ${decl.name} is already declared by the type ${existing.owner.name}${where(existing.owner)}; constructors are global, so choose another name`,
            span: spanOfName(decl.span, decl.name),
          });
          continue;
        }
        const ctor: CtorInfo = { name: decl.name, owner: info, args: [], index: info.constructors.length, decl };
        info.constructors.push(ctor);
        table.constructors.set(decl.name, ctor);
      }
    } else if (definition?.kind === "RecordType") {
      for (const decl of definition.fields) {
        if (info.fields.some((field) => field.name === decl.name)) {
          report({ severity: "error", code: "duplicate-field", message: `the field ${decl.name} is declared twice in ${info.name}`, span: decl.span });
          continue;
        }
        info.fields.push({ name: decl.name, type: UNREADABLE, decl });
      }
      table.records.push(info);
    }
  }
  // Payload, field and alias types.
  const reader = new TypeReader(table, report);
  for (const info of declared) {
    const scope = parameterScope(info, report);
    for (const ctor of info.constructors) ctor.args = ctor.decl!.args.map((arg) => reader.read(arg, scope));
    for (const field of info.fields) field.type = reader.read(field.decl!.type, scope);
    if (info.kind === "alias") reader.aliasOf(info);
  }
  computeEquality(declared, table);
  return declared;
}

/**
 * Which parameters of each declared type must be equality types for the type
 * to be one, or whether it never is (it holds a function). A fixpoint, since
 * types may refer to each other.
 */
function computeEquality(infos: readonly TypeInfo[], table: TypeTable): void {
  for (let changed = true; changed;) {
    changed = false;
    for (const info of infos) {
      if (info.kind !== "variant" && info.kind !== "record") continue;
      const parts = [...info.constructors.flatMap((ctor) => ctor.args), ...info.fields.map((field) => field.type)];
      const before = info.equality.params.size;
      const never = info.equality.never;
      for (const part of parts) requirement(part, table, info.equality);
      if (info.equality.never !== never || info.equality.params.size !== before) changed = true;
    }
  }
}

function requirement(type: Type, table: TypeTable, into: { never: boolean; params: Set<number> }): void {
  const stack: Type[] = [type];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    switch (item.tag) {
      case "param":
        if (item.index >= 0) into.params.add(item.index);
        break;
      case "fun":
        into.never = true;
        break;
      case "tuple":
        stack.push(...item.elements);
        break;
      case "con": {
        // A request compares as a handle; an event or a stream may hold a function.
        if (item.name === SOURCE) {
          const kind = item.args[0]!;
          if (!(kind.tag === "con" && kind.name === REQUEST.name)) into.never = true;
          break;
        }
        const rule = table.equalityRule(item.name);
        if (rule.never) into.never = true;
        for (const index of rule.params) stack.push(item.args[index]!);
        break;
      }
      case "var":
        break;
    }
  }
}

/**
 * Reads the type of an external. Its type variables are generalized, so
 * `external id: ('a) => 'a` works at every type, and so is each part that
 * could not be read, so that one mistake gives one error.
 */
export function externalType(node: A.External, reader: TypeReader): Type {
  const variables = new Map<string, Type>();
  const type = reader.read(node.type, {
    lookup(variable) {
      let found = variables.get(variable.name);
      if (found === undefined) {
        found = newVar(GENERIC);
        variables.set(variable.name, found);
      }
      return found;
    },
  });
  return rebuild(type, (leaf) => (leaf.tag === "param" ? newVar(GENERIC) : leaf));
}

function where(info: TypeInfo): string {
  if (info.origin === "host") return " by the host interface";
  if (info.origin === "std") return " by the standard library";
  if (info.origin === "builtin") return " as a built-in";
  const start = info.decl?.span.start;
  return start === undefined ? "" : ` at ${start.line}:${start.column}`;
}

function suggestion(name: string | null): string {
  return name === null ? "" : `; did you mean ${name}?`;
}

function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** The first `length` characters of a span on one line: a constructor declaration's name. */
export function spanOfName(span: A.Span, name: string): A.Span {
  const { start } = span;
  return { start: { ...start }, end: { line: start.line, column: start.column + name.length, offset: start.offset + name.length } };
}

export { FACT, OCCURRENCE, REQUEST };
