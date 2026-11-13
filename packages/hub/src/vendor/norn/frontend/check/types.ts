// Vendored from norn-lang/norn@96c71706b2dd17ca23bd39d62d9e373b7cc20f14; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The checker's types and their unification (docs/types.md §1–§3).
 *
 * - Type variables carry a level, for let-generalization, and the class
 *   constraints of §3.
 * - Nominal types, built in or declared, are `TCon`s named like their type.
 *   `event<'a>`, `stream<'a>` and `request<'a>` are the internal
 *   `source<'kind, 'a>`.
 * - Functions are uncurried: positional parameters, then labelled ones, which
 *   unify by name.
 *
 * Every walk over a type uses an explicit stack. A 10,000-link pipe chain can
 * build a type 10,000 levels deep, and the checker must not run out of stack
 * on it. Types share parts, and every walk visits a shared part once, so a
 * chain that doubles a type at each link stays linear.
 */
import type { Span } from "../ast.js";

export type Type = TVar | TCon | TTuple | TFun | TParam;

/** A finite class of §3. `equality` is kept apart, as a flag: it is the only class that combines with `handled`. */
export type FiniteClass = "ordered" | "deadline" | "addressee" | "handled";
/**
 * `discardable`, "neither a request nor a reply", is the type of a value that
 * a generic function drops; `ignorable`, "not a request", the type of what
 * `ignore` takes (§6a).
 */
export type ClassName = FiniteClass | "equality" | "discardable" | "ignorable";

export interface TVar {
  readonly tag: "var";
  readonly id: number;
  /** The let-nesting depth where the variable was made; GENERIC once it is generalized. */
  level: number;
  /** What the variable stands for, once unification has decided. */
  link: Type | null;
  cls: FiniteClass | null;
  /** The variable must be an equality type: one with no function inside. */
  equality: boolean;
  /**
   * Where a value of this type is dropped, if it is: then the type must be
   * neither a request nor a reply (§6a). Set when a generic function drops a
   * value of a generalized type, so that each use of the function checks it.
   */
  dropped: Span | null;
  /** The type is what `ignore` takes: it must not be a request (§6a). */
  ignored: boolean;
}

/** A nominal type: `int`, `list<'a>`, `reply<'a>`, `release`, `#source<#fact, pr>`. */
export interface TCon {
  readonly tag: "con";
  readonly name: string;
  readonly args: readonly Type[];
}

export interface TTuple {
  readonly tag: "tuple";
  readonly elements: readonly Type[];
}

export interface TFun {
  readonly tag: "fun";
  readonly params: readonly Type[];
  /** Labelled parameters in declaration order; they unify by name, whatever their order. */
  readonly labels: readonly TLabel[];
  readonly result: Type;
}

export interface TLabel {
  readonly label: string;
  readonly type: Type;
  /** A caller may leave the argument out: `~by: 'd=?`. */
  readonly optional: boolean;
}

/** A parameter of a type declaration, such as the `'a` of `type box<'a>`, replaced by an argument when the type is used. */
export interface TParam {
  readonly tag: "param";
  /** The position among the declaration's parameters; -1 stands for a type the checker could not read, and becomes a fresh variable. */
  readonly index: number;
  readonly name: string;
}

/** The level of a generalized variable: one that each use of its binding copies. */
export const GENERIC = Number.MAX_SAFE_INTEGER;

let nextId = 0;

export function newVar(level: number, cls: FiniteClass | null = null, equality = false, dropped: Span | null = null, ignored = false): TVar {
  return { tag: "var", id: nextId++, level, link: null, cls, equality, dropped, ignored };
}

export function con(name: string, ...args: Type[]): TCon {
  return { tag: "con", name, args };
}

export function tuple(elements: Type[]): TTuple {
  return { tag: "tuple", elements };
}

export function fun(params: Type[], labels: TLabel[], result: Type): TFun {
  return { tag: "fun", params, labels, result };
}

/**
 * The kinds of the internal source type: facts are events, occurrences are
 * streams, and requests. Its name and theirs start with `#`, which no type
 * name in a program can, so a program may declare its own `source`.
 *
 * `#source<'kind, 'w>` holds what waiting on it gives: the value of an
 * `event<'a>` or a `stream<'a>`, and the `reply<'a>` of a `request<'a>`.
 */
export const FACT = con("#fact");
export const OCCURRENCE = con("#occurrence");
export const REQUEST = con("#request");
export const SOURCE = "#source";

export const source = (kind: Type, waited: Type): TCon => con(SOURCE, kind, waited);

/** `request<'a>`: a source of the request kind, whose wait gives `reply<'a>`. */
export const requestOf = (answer: Type): TCon => source(REQUEST, con("reply", answer));

/** Follows links to what a variable stands for, shortening the chain on the way. */
export function resolve(type: Type): Type {
  let end = type;
  while (end.tag === "var" && end.link !== null) end = end.link;
  for (let at = type; at.tag === "var" && at.link !== null && at.link !== end;) {
    const next: Type = at.link;
    at.link = end;
    at = next;
  }
  return end;
}

/** The type constructor name of a type once resolved, or null. */
export function headName(type: Type): string | null {
  const resolved = resolve(type);
  return resolved.tag === "con" ? resolved.name : null;
}

// Unification -------------------------------------------------------------------

/** Which parameters of a nominal type must be equality types for the type to be one, or `never` if it holds a function. */
export interface EqualityRule {
  readonly never: boolean;
  readonly params: readonly number[];
}

/** What unification needs to know about nominal types. */
export interface TypeFacts {
  equalityRule(name: string): EqualityRule;
}

/** Why two types do not unify. `left` and `right` are the parts that clash, not the whole types. */
export type Clash =
  | { readonly kind: "types"; readonly left: Type; readonly right: Type }
  | { readonly kind: "occurs"; readonly variable: TVar; readonly inside: Type }
  /**
   * `type` is not a member of `cls`. For `equality`, `inner` is the function
   * inside it. For `discardable`, `dropped` is where a value of the type is
   * dropped.
   */
  | { readonly kind: "class"; readonly cls: ClassName; readonly type: Type; readonly inner: Type; readonly dropped?: Span }
  | { readonly kind: "classes"; readonly first: FiniteClass; readonly second: FiniteClass };

export class UnifyError extends Error {
  readonly clash: Clash;
  constructor(clash: Clash) {
    super(`types do not unify: ${clash.kind}`);
    this.clash = clash;
  }
}

/** The members of each finite class that are base types. `handled` also holds every `reply<_>`. */
const MEMBERS: { readonly [C in FiniteClass]: readonly string[] } = {
  ordered: ["int", "float", "string", "time", "duration"],
  deadline: ["time", "duration"],
  addressee: ["participant", "ref"],
  handled: ["unit", "reply"],
};

/** Makes two types equal, or throws a UnifyError. Variables bound before the clash stay bound. */
export function unify(a: Type, b: Type, facts: TypeFacts): void {
  const work: [Type, Type][] = [[a, b]];
  // Pairs of shared parts are unified once.
  const done = new Map<Type, Set<Type>>();
  for (let pair = work.pop(); pair !== undefined; pair = work.pop()) {
    const x = resolve(pair[0]);
    const y = resolve(pair[1]);
    if (x === y) continue;
    if (x.tag === "var") {
      bind(x, y, facts);
      continue;
    }
    if (y.tag === "var") {
      bind(y, x, facts);
      continue;
    }
    let partners = done.get(x);
    if (partners?.has(y)) continue;
    if (partners === undefined) {
      partners = new Set();
      done.set(x, partners);
    }
    partners.add(y);
    if (x.tag === "con" && y.tag === "con") {
      if (x.name !== y.name || x.args.length !== y.args.length) throw new UnifyError({ kind: "types", left: x, right: y });
      for (let index = x.args.length - 1; index >= 0; index -= 1) work.push([x.args[index]!, y.args[index]!]);
    } else if (x.tag === "tuple" && y.tag === "tuple") {
      if (x.elements.length !== y.elements.length) throw new UnifyError({ kind: "types", left: x, right: y });
      for (let index = x.elements.length - 1; index >= 0; index -= 1) work.push([x.elements[index]!, y.elements[index]!]);
    } else if (x.tag === "fun" && y.tag === "fun") {
      if (!sameShape(x, y)) throw new UnifyError({ kind: "types", left: x, right: y });
      work.push([x.result, y.result]);
      for (const label of [...x.labels].reverse()) work.push([label.type, y.labels.find((other) => other.label === label.label)!.type]);
      for (let index = x.params.length - 1; index >= 0; index -= 1) work.push([x.params[index]!, y.params[index]!]);
    } else {
      throw new UnifyError({ kind: "types", left: x, right: y });
    }
  }
}

/** The same number of positional parameters, and the same labels with the same optionality. */
export function sameShape(x: TFun, y: TFun): boolean {
  if (x.params.length !== y.params.length || x.labels.length !== y.labels.length) return false;
  return x.labels.every((label) => y.labels.some((other) => other.label === label.label && other.optional === label.optional));
}

function bind(variable: TVar, type: Type, facts: TypeFacts): void {
  if (type.tag === "var") {
    type.cls = meet(variable.cls, type.cls);
    type.equality ||= variable.equality;
    type.dropped ??= variable.dropped;
    type.ignored ||= variable.ignored;
    type.level = Math.min(type.level, variable.level);
    variable.link = type;
    return;
  }
  occursAndLevels(variable, type);
  if (variable.cls !== null && !inFiniteClass(variable.cls, type)) {
    throw new UnifyError({ kind: "class", cls: variable.cls, type, inner: type });
  }
  if (variable.dropped !== null && (isReply(type) || isRequest(type))) {
    throw new UnifyError({ kind: "class", cls: "discardable", type, inner: type, dropped: variable.dropped });
  }
  if (variable.ignored && isRequest(type)) {
    throw new UnifyError({ kind: "class", cls: "ignorable", type, inner: type });
  }
  if (variable.equality) requireEquality(type, facts);
  variable.link = type;
}

/** The intersection of two finite classes: `deadline` lies inside `ordered`, and the others are disjoint. */
function meet(first: FiniteClass | null, second: FiniteClass | null): FiniteClass | null {
  if (first === null || first === second) return second;
  if (second === null) return first;
  if ((first === "ordered" && second === "deadline") || (first === "deadline" && second === "ordered")) return "deadline";
  throw new UnifyError({ kind: "classes", first, second });
}

/** Whether a type that is not a variable belongs to a finite class. */
export function inFiniteClass(cls: FiniteClass, type: Type): boolean {
  const resolved = resolve(type);
  if (resolved.tag !== "con") return false;
  if (cls === "handled") return resolved.name === "reply" || resolved.name === "unit";
  return resolved.args.length === 0 && MEMBERS[cls].includes(resolved.name);
}

/**
 * Marks every variable inside a type as an equality variable, or throws if a
 * function is inside. A request compares as a handle. An event or a stream
 * never compares, since it may hold a function, as `map` and `filter` do; a
 * source whose kind is not known yet is taken to be a request.
 */
export function requireEquality(type: Type, facts: TypeFacts): void {
  const seen = new Set<Type>();
  const stack: Type[] = [type];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const resolved = resolve(item);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    switch (resolved.tag) {
      case "var":
        resolved.equality = true;
        break;
      case "fun":
        throw new UnifyError({ kind: "class", cls: "equality", type, inner: resolved });
      case "tuple":
        stack.push(...resolved.elements);
        break;
      case "con": {
        if (resolved.name === SOURCE) {
          const kind = resolve(resolved.args[0]!);
          if (kind.tag === "var") {
            // A source of unknown kind becomes a request when compared, so waiting on it gives a reply.
            unify(kind, REQUEST, facts);
            unify(resolved.args[1]!, con("reply", newVar(GENERIC - 1)), facts);
          } else if (kind !== REQUEST && !(kind.tag === "con" && kind.name === REQUEST.name)) {
            throw new UnifyError({ kind: "class", cls: "equality", type, inner: resolved });
          }
          break;
        }
        const rule = facts.equalityRule(resolved.name);
        if (rule.never) throw new UnifyError({ kind: "class", cls: "equality", type, inner: resolved });
        for (const index of rule.params) stack.push(resolved.args[index]!);
        break;
      }
      case "param":
        break;
    }
  }
}

/**
 * Types known to hold no unbound variable. Binding a variable never unbinds
 * another, so a type stays ground once it is: walks skip it. Without this, a
 * 10,000-link chain that nests a type one level per link would walk the whole
 * type at each link.
 */
const GROUND = new WeakSet<Type>();

/** Fails if the variable occurs in the type, and lowers the levels of the type's variables to the variable's own. */
function occursAndLevels(variable: TVar, type: Type): void {
  const seen = new Set<Type>();
  const stack: Type[] = [type];
  let unbound = false;
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const resolved = resolve(item);
    if (resolved.tag === "var") {
      if (resolved === variable) throw new UnifyError({ kind: "occurs", variable, inside: type });
      if (resolved.level > variable.level) resolved.level = variable.level;
      unbound = true;
      continue;
    }
    if (resolved.tag === "param") unbound = true;
    if (GROUND.has(resolved) || seen.has(resolved)) continue;
    seen.add(resolved);
    pushChildren(resolved, stack);
  }
  // Every part walked is ground when no unbound variable was met.
  if (!unbound) for (const part of seen) GROUND.add(part);
}

function pushChildren(type: Type, stack: Type[]): void {
  switch (type.tag) {
    case "con":
      stack.push(...type.args);
      break;
    case "tuple":
      stack.push(...type.elements);
      break;
    case "fun":
      stack.push(...type.params, ...type.labels.map((label) => label.type), type.result);
      break;
    case "var":
    case "param":
      break;
  }
}

// Generalization and copies -----------------------------------------------------

/** Generalizes the variables of a type made deeper than `level`: each use of the binding will copy them. */
export function generalize(type: Type, level: number): void {
  const seen = new Set<Type>();
  const stack: Type[] = [type];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const resolved = resolve(item);
    if (seen.has(resolved) || GROUND.has(resolved)) continue;
    seen.add(resolved);
    if (resolved.tag === "var") {
      if (resolved.level > level) resolved.level = GENERIC;
    } else {
      pushChildren(resolved, stack);
    }
  }
}

/** A copy of a type in which each generalized variable is a fresh variable at `level`, with the same constraints. */
export function instantiate(type: Type, level: number): Type {
  const copies = new Map<TVar, TVar>();
  return rebuild(type, (leaf) => {
    if (leaf.tag !== "var" || leaf.level !== GENERIC) return leaf;
    let copy = copies.get(leaf);
    if (copy === undefined) {
      copy = newVar(level, leaf.cls, leaf.equality, leaf.dropped, leaf.ignored);
      copies.set(leaf, copy);
    }
    return copy;
  });
}

/** A type declaration's part with its parameters replaced by arguments; an unreadable part (index -1) becomes a fresh variable. */
export function substitute(type: Type, args: readonly Type[], level: number): Type {
  return rebuild(type, (leaf) => {
    if (leaf.tag !== "param") return leaf;
    return leaf.index < 0 ? newVar(level) : args[leaf.index] ?? newVar(level);
  });
}

/**
 * Copies a type, replacing each variable and parameter with `leaf(…)`. A part
 * whose leaves all stay the same is shared, not copied.
 */
export function rebuild(root: Type, leaf: (type: TVar | TParam) => Type): Type {
  type Frame = { type: Type; children: number };
  const results: Type[] = [];
  // Each shared part is copied once.
  const copies = new Map<Type, Type>();
  const stack: (Type | Frame)[] = [root];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if ("children" in item) {
      const parts = results.splice(results.length - item.children, item.children);
      const copy = assemble(item.type, parts);
      copies.set(item.type, copy);
      results.push(copy);
      continue;
    }
    const resolved = resolve(item);
    if (resolved.tag === "var" || resolved.tag === "param") {
      results.push(leaf(resolved));
      continue;
    }
    const copy = copies.get(resolved);
    if (copy !== undefined || GROUND.has(resolved)) {
      results.push(copy ?? resolved);
      continue;
    }
    const children: Type[] = [];
    pushChildren(resolved, children);
    if (children.length === 0) {
      results.push(resolved);
      continue;
    }
    stack.push({ type: resolved, children: children.length });
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return results[0]!;
}

/** A type like `type` with these children, in the order of `pushChildren`; `type` itself when they are the same. */
function assemble(type: Type, parts: Type[]): Type {
  switch (type.tag) {
    case "con":
      return parts.every((part, index) => part === type.args[index]) ? type : con(type.name, ...parts);
    case "tuple":
      return parts.every((part, index) => part === type.elements[index]) ? type : tuple(parts);
    case "fun": {
      const params = parts.slice(0, type.params.length);
      const labels = type.labels.map((label, index) => ({ ...label, type: parts[type.params.length + index]! }));
      const result = parts[parts.length - 1]!;
      const same = params.every((part, index) => part === type.params[index]) &&
        labels.every((label, index) => label.type === type.labels[index]!.type) && result === type.result;
      return same ? type : fun(params, labels, result);
    }
    case "var":
    case "param":
      return type;
  }
}

/** Whether a type is `reply<_>`. */
export function isReply(type: Type): boolean {
  return headName(type) === "reply";
}

/** Whether a type is `request<_>`: a source whose kind is known to be a request. */
export function isRequest(type: Type): boolean {
  const resolved = resolve(type);
  return resolved.tag === "con" && resolved.name === SOURCE && headName(resolved.args[0]!) === REQUEST.name;
}

/** What a request answers: the `'a` of `request<'a>`, whose wait gives `reply<'a>`; null when that is not known to be a reply. */
function answerOf(source: TCon): Type | null {
  const waited = resolve(source.args[1]!);
  return waited.tag === "con" && waited.name === "reply" ? resolve(waited.args[0]!) : null;
}

// Printing ----------------------------------------------------------------------

/**
 * Names type variables `'a`, `'b`, … in the order they are first printed. One
 * namer serves both types of an "expected …, found …" message, so a variable
 * shared by the two has one name.
 */
export class Namer {
  private readonly names = new Map<TVar, string>();

  name(variable: TVar): string {
    let name = this.names.get(variable);
    if (name === undefined) {
      const index = this.names.size;
      name = `'${String.fromCharCode(97 + (index % 26))}${index >= 26 ? Math.floor(index / 26) : ""}`;
      this.names.set(variable, name);
    }
    return name;
  }

  /** The named variables, in the order of their names. */
  variables(): TVar[] {
    return [...this.names.keys()];
  }
}

/**
 * A type as a message shows it: `reply<report>`, `(participant, string,
 * ~by: 'a=?) => request<string>`. A source shows as `event<'a>`,
 * `stream<'a>` or `request<'a>`, and as `(event|stream|request)<'a>` while its
 * kind is unknown.
 *
 * The text is built from the leaves up, once for each part, and a shared part
 * reuses its text: engines concatenate strings without copying them, so this
 * stays linear in the size of the type even when the text is far larger. A
 * type whose text is longer than the engine's longest string says so instead.
 * That limit is the engine's own; nothing here sets one.
 */
export function printType(type: Type, namer: Namer = new Namer()): string {
  const texts = new Map<Type, string>();
  const root = resolve(type);
  // A part is pushed once to visit its children, then again, marked, to join their texts.
  const stack: { type: Type; joined: boolean }[] = [{ type: root, joined: false }];
  try {
    for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
      if (texts.has(item.type)) continue;
      const children = printedChildren(item.type);
      if (!item.joined) {
        stack.push({ type: item.type, joined: true });
        // Children are joined left to right, so variables are named in the order a reader meets them.
        for (let index = children.length - 1; index >= 0; index -= 1) {
          if (!texts.has(children[index]!)) stack.push({ type: children[index]!, joined: false });
        }
        continue;
      }
      texts.set(item.type, typeText(item.type, children.map((child) => texts.get(child)!), namer));
    }
  } catch (error) {
    if (!(error instanceof TextTooLong)) throw error;
    return `a type too large to show (about ${printedSize(type)} characters)`;
  }
  return texts.get(root)!;
}

/** The parts of a type that its text shows, resolved, in the order it shows them. A source shows its kind by name only. */
function printedChildren(type: Type): Type[] {
  switch (type.tag) {
    case "con": {
      if (type.name !== SOURCE) return type.args.map(resolve);
      // A request shows what it answers, request<'a>, not what waiting on it gives, reply<'a>.
      const answer = headName(type.args[0]!) === REQUEST.name ? answerOf(type) : null;
      return [answer ?? resolve(type.args[1]!)];
    }
    case "tuple":
      return type.elements.map(resolve);
    case "fun":
      return [...type.params, ...type.labels.map((label) => label.type), type.result].map(resolve);
    case "var":
    case "param":
      return [];
  }
}

/** The text of a type, given the texts of its printed children. */
function typeText(type: Type, children: string[], namer: Namer): string {
  switch (type.tag) {
    case "var":
      return namer.name(type);
    case "param":
      return type.index < 0 ? "_" : `'${type.name}`;
    case "con":
      if (type.name === SOURCE) return concat([sourceName(type.args[0]!), "<", children[0]!, ">"]);
      return children.length === 0 ? type.name : concat([type.name, "<", ...commas(children), ">"]);
    case "tuple":
      return concat(["(", ...commas(children), ")"]);
    case "fun": {
      const params = children.slice(0, type.params.length);
      const labels = type.labels.map((label, index) =>
        concat([`~${label.label}: `, children[type.params.length + index]!, label.optional ? "=?" : ""]));
      return concat(["(", ...commas([...params, ...labels]), ") => ", children[children.length - 1]!]);
    }
  }
}

function commas(texts: string[]): string[] {
  return texts.flatMap((text, index) => (index > 0 ? [", ", text] : [text]));
}

/** The engine refused to build a string: it would be longer than the longest string the engine can hold. */
class TextTooLong extends Error {}

/**
 * Joins texts. Joining strings fails only when the result would be longer
 * than the engine allows, and each engine says so its own way: V8 and
 * JavaScriptCore throw a RangeError, SpiderMonkey an InternalError.
 */
function concat(parts: string[]): string {
  let text = "";
  try {
    for (const part of parts) text += part;
  } catch {
    throw new TextTooLong();
  }
  return text;
}

/**
 * At most how many characters a type prints as, for the message about a type
 * too large to show. A type that shares its parts prints each share in full,
 * so its text can be far larger than the type.
 */
function printedSize(root: Type): number {
  const sizes = new Map<Type, number>();
  type Frame = { type: Type; children: Type[] };
  const stack: (Type | Frame)[] = [root];
  const result = (type: Type): number => sizes.get(resolve(type)) ?? 0;
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if ("children" in item) {
      // Names, brackets and separators: 32 characters is more than any of them takes around one child.
      sizes.set(item.type, item.children.reduce((total, child) => total + result(child) + 32, 32 + (item.type.tag === "con" ? item.type.name.length : 0)));
      continue;
    }
    const resolved = resolve(item);
    if (sizes.has(resolved)) continue;
    if (resolved.tag === "var" || resolved.tag === "param") {
      sizes.set(resolved, 24);
      continue;
    }
    const children: Type[] = [];
    pushChildren(resolved, children);
    stack.push({ type: resolved, children });
    for (const child of children) stack.push(child);
  }
  return result(root);
}

/** The familiar name of a source of this kind. */
export function sourceName(kind: Type): string {
  switch (headName(kind)) {
    case "#fact":
      return "event";
    case "#occurrence":
      return "stream";
    case "#request":
      return "request";
    default:
      return "(event|stream|request)";
  }
}

/**
 * A generalized type with the classes of its variables, as in
 * `('a, 'a) => bool where 'a: ordered`.
 */
export function printScheme(type: Type): string {
  const namer = new Namer();
  const text = printType(type, namer);
  const constraints = namer.variables().flatMap((variable) => {
    const classes = [
      ...(variable.cls === null ? [] : [variable.cls]),
      ...(variable.equality && (variable.cls === null || variable.cls === "handled") ? ["equality"] : []),
      ...(variable.dropped === null ? [] : ["discardable"]),
      ...(variable.ignored && variable.dropped === null ? ["ignorable"] : []),
    ];
    return classes.length === 0 ? [] : [`${namer.name(variable)}: ${classes.join(", ")}`];
  });
  return constraints.length === 0 ? text : `${text} where ${constraints.join(", ")}`;
}
