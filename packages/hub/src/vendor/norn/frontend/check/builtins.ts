// Vendored from norn-lang/norn@9333fe512bf5af158f5f0695e27fbeb27218243b; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * What every program sees without declaring it: the base types, `list`,
 * `option`, `result`, `reply`, `yesno`, `either`, the three source types, and
 * the built-in functions with the signatures of docs/types.md §5.
 *
 * In a signature, `'d` is a `deadline` variable, `'t` an `addressee` variable
 * and `'h` a `handled` variable (§3).
 */
import { TypeTable, typeInfo, type CtorInfo, type TypeInfo } from "./declarations.js";
import {
  FACT, GENERIC, OCCURRENCE, REQUEST, con, fun, newVar, requestOf, source, tuple, type FiniteClass, type TLabel, type TParam, type Type,
} from "./types.js";

/** The effect families of docs/types.md §8, in the order the effects summary lists them. */
export const FAMILIES = ["ask", "confirm", "choose", "run", "wait", "handOver", "cancel", "say", "judge"] as const;
export type Family = (typeof FAMILIES)[number];

export const BASE_TYPES = ["string", "int", "float", "bool", "unit", "time", "duration", "participant", "ref"] as const;

export const t = {
  string: con("string"),
  int: con("int"),
  float: con("float"),
  bool: con("bool"),
  unit: con("unit"),
  time: con("time"),
  duration: con("duration"),
  participant: con("participant"),
  ref: con("ref"),
  yesno: con("yesno"),
  list: (element: Type) => con("list", element),
  option: (element: Type) => con("option", element),
  result: (value: Type, error: Type) => con("result", value, error),
  reply: (answer: Type) => con("reply", answer),
  either: (first: Type, second: Type) => con("either", first, second),
  event: (element: Type) => source(FACT, element),
  stream: (element: Type) => source(OCCURRENCE, element),
  request: (answer: Type) => requestOf(answer),
};

const param = (index: number, name: string): TParam => ({ tag: "param", index, name });

/** The table every host interface starts from. */
export function builtinTable(): TypeTable {
  const table = new TypeTable();
  for (const name of BASE_TYPES) table.types.set(name, typeInfo({ name, kind: "base", origin: "builtin" }));
  table.types.set("list", typeInfo({ name: "list", kind: "list", origin: "builtin", params: ["a"], equality: { never: false, params: new Set([0]) } }));
  const variant = (name: string, params: string[], constructors: [string, Type[]][]) => {
    const info = typeInfo({ name, kind: "variant", origin: "builtin", params, equality: { never: false, params: new Set(params.map((_, index) => index)) } });
    info.constructors = constructors.map(([ctor, args], index): CtorInfo => ({ name: ctor, owner: info, args, index, decl: null }));
    table.adopt(info);
  };
  const a = param(0, "a");
  variant("option", ["a"], [["None", []], ["Some", [a]]]);
  variant("result", ["a", "e"], [["Ok", [a]], ["Error", [param(1, "e")]]]);
  variant("reply", ["a"], [["Answered", [a]], ["Refused", [t.string]], ["NoReply", []], ["Broke", [t.string]], ["Cancelled", []], ["Revoked", []]]);
  variant("yesno", [], [["Yes", []], ["No", []]]);
  variant("either", ["a", "b"], [["First", [a]], ["Second", [param(1, "b")]]]);
  const sourceName = (name: string, kind: Type): TypeInfo =>
    typeInfo({ name, kind: "source", origin: "builtin", params: ["a"], sourceKind: kind, equality: { never: false, params: new Set([0]) } });
  table.types.set("event", sourceName("event", FACT));
  table.types.set("stream", sourceName("stream", OCCURRENCE));
  table.types.set("request", sourceName("request", REQUEST));
  return table;
}

/** A built-in value: its generalized type, and the effect family it performs. */
export interface Builtin {
  readonly name: string;
  readonly type: Type;
  readonly family: Family | null;
}

const g = (cls: FiniteClass | null = null) => newVar(GENERIC, cls);
const optional = (label: string, type: Type): TLabel => ({ label, type, optional: true });

/** The built-in functions. */
export function builtinValues(): Builtin[] {
  const by = () => optional("by", g("deadline"));
  // What a request is about: the thing, and through its value the version.
  const about = () => optional("about", g());
  const values: [string, Family | null, () => Type][] = [
    ["ask", "ask", () => fun([t.participant, t.string], [by(), about()], t.request(t.string))],
    ["confirm", "confirm", () => fun([t.participant, t.string], [by(), about()], t.request(t.yesno))],
    ["choose", "choose", () => {
      const a = g();
      return fun([t.participant, t.string, t.list(a)], [by(), about()], t.request(a));
    }],
    // A run reports what the program uses its report as (§5a); `report` when nothing decides it.
    ["run", "run", () => fun([t.participant, t.string], [optional("context", g()), by(), about()], t.request(g()))],
    ["judge", "judge", () => fun([t.string], [optional("about", g())], t.request(t.bool))],
    // Waiting on a source gives what it holds: a reply for a request, the value for a fact or a stream.
    ["wait", "wait", () => {
      const w = g();
      return fun([source(g(), w)], [], w);
    }],
    ["waitUntil", "wait", () => {
      const w = g();
      return fun([source(g(), w), g("deadline")], [], t.option(w));
    }],
    ["handOver", "handOver", () => {
      const a = g();
      return fun([t.request(a), t.participant], [], t.request(a));
    }],
    // The first of several requests to end, with its reply.
    ["first", "wait", () => {
      const a = g();
      return fun([t.list(t.request(a))], [], tuple([t.request(a), t.reply(a)]));
    }],
    // Offered to all of them; whoever takes it first holds it, and nobody else does.
    ["anyOf", null, () => fun([t.list(t.participant)], [optional("except", t.participant)], t.participant)],
    ["cancel", "cancel", () => fun([t.request(g())], [], t.unit)],
    ["status", null, () => {
      const a = g();
      return fun([t.request(a)], [], t.option(t.reply(a)));
    }],
    ["say", "say", () => fun([g("addressee"), t.string], [], t.unit)],
    ["now", null, () => fun([], [], t.time)],
    ["show", null, () => fun([g()], [], t.string)],
    // A reply may be set aside on purpose; a request may not (§6a).
    ["ignore", null, () => fun([newVar(GENERIC, null, false, null, true)], [], t.unit)],
    ["fail", null, () => fun([t.reply(g())], [], g())],
    ["every", null, () => fun([t.duration], [], t.stream(t.time))],
    ["after", null, () => fun([g("deadline")], [], t.stream(t.time))],
    ["never", null, () => fun([], [], t.stream(g()))],
    ["or", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), t.stream(b)], [], t.stream(t.either(a, b)));
    }],
    ["map", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), fun([a], [], b)], [], t.stream(b));
    }],
    ["filter", null, () => {
      const a = g();
      return fun([t.stream(a), fun([a], [], t.bool)], [], t.stream(a));
    }],
    // forEach waits for each occurrence, so it counts as the wait family.
    ["forEach", "wait", () => {
      const a = g();
      return fun([t.stream(a), fun([a], [], g("handled"))], [], g());
    }],
  ];
  return values.map(([name, family, type]) => ({ name, family, type: type() }));
}
