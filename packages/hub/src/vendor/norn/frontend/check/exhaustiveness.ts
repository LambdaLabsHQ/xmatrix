// Vendored from norn-lang/norn@96c71706b2dd17ca23bd39d62d9e373b7cc20f14; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Exhaustiveness and unreachable cases (docs/types.md §6), by Maranget's
 * usefulness algorithm ("Warnings for pattern matching", 2007).
 *
 * - **Missing cases.** The value vectors that no unguarded case matches,
 *   written as patterns such as `Declined(_)`. Where a type has no finite set
 *   of values (int, float, string, and types with no constructor patterns),
 *   `_` stands for the values that no literal covers.
 * - **Unreachable cases.** A case, or an alternative of a case's top-level
 *   or-pattern, that no value reaches past the unguarded cases before it.
 *
 * Guarded cases are left out of the matrix: a guard may be false. The
 * witnesses are all of them, not a sample: where a signature is incomplete,
 * the constructors that do appear are explored too.
 */
import type * as A from "../ast.js";
import type { TypeTable } from "./declarations.js";
import { resolve, substitute, type Type } from "./types.js";

export interface Row {
  readonly pattern: A.Pattern;
  readonly guarded: boolean;
}

export interface MatchReport {
  /** Example patterns that no case matches, in the order of the type's constructors. */
  missing: string[];
  /** Cases, or alternatives of a case's top-level or-pattern, that can never match. */
  unreachable: { pattern: A.Pattern; alternative: boolean }[];
}

/** A constructor of a column's type, as the algorithm sees it. */
interface Ctor {
  /** Distinguishes constructors: a variant constructor's name, or `#true`, `#nil`, `#int:5`, … */
  readonly key: string;
  readonly arity: number;
  /** How a witness built from it prints, given its arguments. */
  readonly kind: "variant" | "tuple" | "record" | "nil" | "cons" | "literal";
  /** The name or the literal's text; for a record, its field names. */
  readonly text: string;
  readonly fields: readonly string[];
}

type Pat = { readonly tag: "any" } | { readonly tag: "ctor"; readonly ctor: Ctor; readonly args: readonly Pat[] } | { readonly tag: "or"; readonly alternatives: readonly Pat[] };

const ANY: Pat = { tag: "any" };

export function analyzeMatch(type: Type, rows: readonly Row[], table: TypeTable): MatchReport {
  const space = new Space(table);
  const converted = rows.map((row) => ({ row, pat: space.pattern(row.pattern, type) }));
  const unreachable: MatchReport["unreachable"] = [];
  const before: Pat[][] = [];
  for (const { row, pat } of converted) {
    const node = row.pattern;
    if (pat.tag === "or" && node.kind === "OrPattern") {
      // Each alternative, against the cases before and the alternatives before it.
      const local = [...before];
      const useless = pat.alternatives.map((alternative) => {
        const reached = space.useful(local, [alternative], [type]);
        local.push([alternative]);
        return !reached;
      });
      if (useless.every(Boolean)) unreachable.push({ pattern: node, alternative: false });
      else useless.forEach((dead, index) => dead && unreachable.push({ pattern: node.alternatives[index]!, alternative: true }));
    } else if (!space.useful(before, [pat], [type])) {
      unreachable.push({ pattern: row.pattern, alternative: false });
    }
    if (!row.guarded) before.push([pat]);
  }
  const missing = space.missing(before, [type]).map((witness) => show(witness!.head));
  return { missing, unreachable };
}

/** Constructors and the types of their arguments, for the types of one table. */
class Space {
  private readonly table: TypeTable;

  constructor(table: TypeTable) {
    this.table = table;
  }

  /** The constructors of a type, in declaration order, or null if it has no finite set of them. */
  signature(type: Type): Ctor[] | null {
    const shape = resolve(type);
    if (shape.tag === "tuple") return [this.tupleCtor(shape.elements.length)];
    if (shape.tag !== "con") return null;
    switch (shape.name) {
      case "bool":
        return [literal("#true", "true"), literal("#false", "false")];
      case "unit":
        return [literal("#unit", "()")];
      case "list":
        return [NIL, CONS];
      default: {
        const info = this.table.types.get(shape.name);
        if (info?.kind === "variant") {
          return info.constructors.map((ctor) => ({ key: ctor.name, arity: ctor.args.length, kind: "variant", text: ctor.name, fields: [] }));
        }
        if (info?.kind === "record") return [this.recordCtor(info.fields.map((field) => field.name))];
        return null;
      }
    }
  }

  /** The types of a constructor's arguments, given the type it builds. */
  argumentTypes(ctor: Ctor, type: Type): Type[] {
    const shape = resolve(type);
    switch (ctor.kind) {
      case "tuple":
        return shape.tag === "tuple" ? [...shape.elements] : [];
      case "cons":
        return shape.tag === "con" ? [shape.args[0]!, shape] : [];
      case "nil":
      case "literal":
        return [];
      case "record": {
        const info = shape.tag === "con" ? this.table.types.get(shape.name) : undefined;
        if (shape.tag !== "con" || info === undefined) return ctor.fields.map(() => type);
        return info.fields.map((field) => substitute(field.type, shape.args, 0));
      }
      case "variant": {
        const info = shape.tag === "con" ? this.table.types.get(shape.name) : undefined;
        const declared = info?.constructors.find((candidate) => candidate.name === ctor.key);
        if (shape.tag !== "con" || declared === undefined) return Array.from({ length: ctor.arity }, () => type);
        return declared.args.map((arg) => substitute(arg, shape.args, 0));
      }
    }
  }

  private tupleCtor(size: number): Ctor {
    return { key: "#tuple", arity: size, kind: "tuple", text: "", fields: [] };
  }

  private recordCtor(fields: string[]): Ctor {
    return { key: "#record", arity: fields.length, kind: "record", text: "", fields };
  }

  /** A pattern of the syntax tree, for a value of `type`. */
  pattern(node: A.Pattern, type: Type): Pat {
    switch (node.kind) {
      case "WildcardPattern":
      case "VarPattern":
        return ANY;
      case "LiteralPattern":
        return { tag: "ctor", ctor: literalCtor(node.literal), args: [] };
      case "ConstructorPattern": {
        const ctor = this.signature(type)?.find((candidate) => candidate.key === node.name)
          ?? { key: node.name, arity: node.args.length, kind: "variant" as const, text: node.name, fields: [] };
        const types = this.argumentTypes(ctor, type);
        return { tag: "ctor", ctor, args: node.args.map((arg, index) => this.pattern(arg, types[index] ?? type)) };
      }
      case "TuplePattern": {
        const ctor = this.tupleCtor(node.elements.length);
        const types = this.argumentTypes(ctor, type);
        return { tag: "ctor", ctor, args: node.elements.map((element, index) => this.pattern(element, types[index] ?? type)) };
      }
      case "ListPattern": {
        const shape = resolve(type);
        const element = shape.tag === "con" && shape.name === "list" ? shape.args[0]! : type;
        let tail: Pat = node.rest === null ? { tag: "ctor", ctor: NIL, args: [] } : this.pattern(node.rest, type);
        for (let index = node.elements.length - 1; index >= 0; index -= 1) {
          tail = { tag: "ctor", ctor: CONS, args: [this.pattern(node.elements[index]!, element), tail] };
        }
        return tail;
      }
      case "RecordPattern": {
        const ctor = this.signature(type)?.[0];
        if (ctor === undefined || ctor.kind !== "record") return ANY;
        const types = this.argumentTypes(ctor, type);
        return {
          tag: "ctor",
          ctor,
          args: ctor.fields.map((field, index) => {
            const given = node.fields.find((candidate) => candidate.name === field);
            return given === undefined ? ANY : this.pattern(given.pattern, types[index]!);
          }),
        };
      }
      case "OrPattern":
        return { tag: "or", alternatives: node.alternatives.map((alternative) => this.pattern(alternative, type)) };
    }
  }

  /**
   * Whether some value matches `q` and no row of `matrix`. A constructor in
   * `q`, and a column whose constructors do not cover its type, continue in
   * the loop rather than recursing, so a wide tuple or a long list pattern
   * does not use stack for each of its columns.
   */
  useful(matrix: readonly (readonly Pat[])[], q: readonly Pat[], types: readonly Type[]): boolean {
    for (;;) {
      if (matrix.length === 0) return true;
      if (q.length === 0 || matrix.some(coversAll)) return false;
      const [head, ...rest] = q as [Pat, ...Pat[]];
      const [type, ...restTypes] = types as [Type, ...Type[]];
      if (head.tag === "or") return head.alternatives.some((alternative) => this.useful(matrix, [alternative, ...rest], types));
      if (head.tag === "ctor") {
        matrix = specialize(matrix, head.ctor);
        q = [...head.args, ...rest];
        types = [...this.argumentTypes(head.ctor, type), ...restTypes];
        continue;
      }
      const present = headCtors(matrix);
      const signature = this.signature(type);
      if (signature !== null && signature.every((ctor) => present.has(ctor.key))) {
        if (signature.length === 1) {
          const ctor = signature[0]!;
          matrix = specialize(matrix, ctor);
          q = [...anys(ctor.arity), ...rest];
          types = [...this.argumentTypes(ctor, type), ...restTypes];
          continue;
        }
        return signature.some((ctor) =>
          this.useful(specialize(matrix, ctor), [...anys(ctor.arity), ...rest], [...this.argumentTypes(ctor, type), ...restTypes]));
      }
      matrix = defaults(matrix);
      q = rest;
      types = restTypes;
    }
  }

  /**
   * Every value vector, as patterns, that no row of `matrix` matches.
   *
   * It works on an explicit stack: each step splits a matrix into the
   * matrices of its first column's constructors, and assembles their
   * witnesses once they are known. A vector is a linked list, so putting a
   * constructor in front of many witnesses copies none of them.
   */
  missing(matrix: readonly (readonly Pat[])[], types: readonly Type[]): Vector[] {
    type Deliver = (witnesses: Vector[]) => void;
    type Step =
      | { readonly kind: "split"; readonly matrix: readonly (readonly Pat[])[]; readonly types: readonly Type[]; readonly deliver: Deliver }
      | { readonly kind: "assemble"; readonly parts: Vector[][]; readonly assemble: (parts: Vector[][]) => Vector[]; readonly deliver: Deliver };
    let result: Vector[] = [];
    const stack: Step[] = [{ kind: "split", matrix, types, deliver: (witnesses) => (result = witnesses) }];
    for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
      if (step.kind === "assemble") {
        step.deliver(step.assemble(step.parts));
        continue;
      }
      const { matrix: rows, types: columns, deliver } = step;
      // No row: any value is missing. A row of wildcards: none is.
      if (rows.length === 0) {
        deliver([anyVector(columns.length)]);
        continue;
      }
      if (rows.some(coversAll)) {
        deliver([]);
        continue;
      }
      const [type, ...restTypes] = columns as [Type, ...Type[]];
      const present = headCtors(rows);
      const signature = this.signature(type);
      const complete = signature !== null && signature.every((ctor) => present.has(ctor.key));
      // The constructors to explore: all of a complete signature; otherwise those that appear, and the rows that match anything.
      // Where there is no finite set of constructors, as for int, float and string literals, `_` alone stands for the values
      // that are missing: listing a literal per case would only say "add a catch-all".
      const explored = complete ? signature : signature === null ? [] : signature.filter((ctor) => present.has(ctor.key));
      const children = explored.map((ctor) => ({ matrix: specialize(rows, ctor), types: [...this.argumentTypes(ctor, type), ...restTypes] }));
      if (!complete) children.push({ matrix: defaults(rows), types: restTypes });
      const assemble = (parts: Vector[][]): Vector[] => {
        const witnesses: Vector[] = [];
        const others = complete ? [] : parts[explored.length]!;
        const wrap = (ctor: Ctor) => {
          for (const witness of parts[explored.indexOf(ctor)]!) witnesses.push(applyCtor(ctor, witness));
        };
        if (complete) {
          for (const ctor of explored) wrap(ctor);
        } else if (signature !== null && present.size > 0) {
          // In the order of the type's constructors: those that appear, explored, and the others with any arguments.
          for (const ctor of signature) {
            if (present.has(ctor.key)) wrap(ctor);
            else for (const witness of others) witnesses.push({ head: { tag: "ctor", ctor, args: anys(ctor.arity) }, tail: witness });
          }
        } else {
          // No finite set of constructors, or none appears: any other value.
          for (const witness of others) witnesses.push({ head: ANY, tail: witness });
        }
        return witnesses;
      };
      const parts: Vector[][] = Array.from({ length: children.length }, () => []);
      stack.push({ kind: "assemble", parts, assemble, deliver });
      children.forEach((child, index) => stack.push({ kind: "split", ...child, deliver: (witnesses) => (parts[index] = witnesses) }));
    }
    return result;
  }
}

/** A witness of a constructor's argument columns and the columns after them, as a witness of the constructor and those after. */
function applyCtor(ctor: Ctor, witness: Vector): Vector {
  const args: Pat[] = [];
  let rest = witness;
  for (let index = 0; index < ctor.arity; index += 1) {
    args.push(rest!.head);
    rest = rest!.tail;
  }
  return { head: { tag: "ctor", ctor, args }, tail: rest };
}

/** A vector of patterns as a linked list; null is the empty vector. */
type Vector = { readonly head: Pat; readonly tail: Vector } | null;

function anyVector(length: number): Vector {
  let vector: Vector = null;
  for (let index = 0; index < length; index += 1) vector = { head: ANY, tail: vector };
  return vector;
}

const NIL: Ctor = { key: "#nil", arity: 0, kind: "nil", text: "[]", fields: [] };
const CONS: Ctor = { key: "#cons", arity: 2, kind: "cons", text: "", fields: [] };

function literal(key: string, text: string): Ctor {
  return { key, arity: 0, kind: "literal", text, fields: [] };
}

function literalCtor(node: A.LiteralPattern["literal"]): Ctor {
  switch (node.kind) {
    case "IntLiteral":
      return literal(`#int:${node.value}`, node.value);
    case "FloatLiteral": {
      // 0.0 and -0.0 are equal values.
      const value = Object.is(node.value, -0) ? 0 : node.value;
      return literal(`#float:${value}`, String(value).includes(".") || String(value).includes("e") ? String(value) : `${value}.0`);
    }
    case "StringLiteral":
      return literal(`#string:${JSON.stringify(node.value)}`, JSON.stringify(node.value));
    case "BoolLiteral":
      return literal(node.value ? "#true" : "#false", String(node.value));
    case "UnitLiteral":
      return literal("#unit", "()");
  }
}

/** A row that matches every value: wildcards only. */
function coversAll(row: readonly Pat[]): boolean {
  return row.every((pat) => pat.tag === "any");
}

function anys(count: number): Pat[] {
  return Array.from({ length: count }, () => ANY);
}

/** The rows whose first pattern is `ctor` or matches anything, with that pattern replaced by its arguments. */
function specialize(matrix: readonly (readonly Pat[])[], ctor: Ctor): Pat[][] {
  const result: Pat[][] = [];
  const add = (head: Pat, row: readonly Pat[]): void => {
    if (head.tag === "any") result.push([...anys(ctor.arity), ...row.slice(1)]);
    else if (head.tag === "ctor") {
      if (head.ctor.key === ctor.key) result.push([...head.args, ...row.slice(1)]);
    } else for (const alternative of head.alternatives) add(alternative, row);
  };
  for (const row of matrix) add(row[0]!, row);
  return result;
}

/** The rows whose first pattern matches anything, without it. */
function defaults(matrix: readonly (readonly Pat[])[]): Pat[][] {
  const result: Pat[][] = [];
  const add = (head: Pat, row: readonly Pat[]): void => {
    if (head.tag === "any") result.push(row.slice(1));
    else if (head.tag === "or") for (const alternative of head.alternatives) add(alternative, row);
  };
  for (const row of matrix) add(row[0]!, row);
  return result;
}

/** The constructors at the head of the rows, by key, in order of appearance. */
function headCtors(matrix: readonly (readonly Pat[])[]): Map<string, Ctor> {
  const found = new Map<string, Ctor>();
  const add = (head: Pat): void => {
    if (head.tag === "ctor") {
      if (!found.has(head.ctor.key)) found.set(head.ctor.key, head.ctor);
    } else if (head.tag === "or") for (const alternative of head.alternatives) add(alternative);
  };
  for (const row of matrix) add(row[0]!);
  return found;
}

/** A witness as Norn pattern syntax. */
function show(pat: Pat): string {
  if (pat.tag === "any") return "_";
  if (pat.tag === "or") return pat.alternatives.map(show).join(" | ");
  const { ctor, args } = pat;
  switch (ctor.kind) {
    case "variant":
      return args.length === 0 ? ctor.text : `${ctor.text}(${args.map(show).join(", ")})`;
    case "tuple":
      return `(${args.map(show).join(", ")})`;
    case "record": {
      const given = ctor.fields.flatMap((field, index) => (args[index]!.tag === "any" ? [] : [`${field}: ${show(args[index]!)}`]));
      return given.length === 0 ? "_" : `{${given.join(", ")}}`;
    }
    case "nil":
      return "[]";
    case "cons": {
      const elements: string[] = [];
      let tail: Pat = pat;
      while (tail.tag === "ctor" && tail.ctor.kind === "cons") {
        elements.push(show(tail.args[0]!));
        tail = tail.args[1]!;
      }
      if (tail.tag === "ctor" && tail.ctor.kind === "nil") return `[${elements.join(", ")}]`;
      return `[${elements.join(", ")}, ...${show(tail)}]`;
    }
    case "literal":
      return ctor.text;
  }
}
