// Vendored from norn-lang/norn@3a8adebc52c4e8af22a0b40ddf7a2dfd7ca36f03; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
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
export const FAMILIES = ["ask", "confirm", "choose", "run", "wait", "handOver", "cancel", "say", "judge", "spawn"] as const;
export type Family = (typeof FAMILIES)[number];

export const BASE_TYPES = ["string", "int", "float", "bool", "unit", "time", "duration", "participant", "ref", "json"] as const;

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
  json: con("json"),
  yesno: con("yesno"),
  list: (element: Type) => con("list", element),
  option: (element: Type) => con("option", element),
  result: (value: Type, error: Type) => con("result", value, error),
  reply: (answer: Type) => con("reply", answer),
  either: (first: Type, second: Type) => con("either", first, second),
  event: (element: Type) => source(FACT, element),
  fact: (element: Type) => source(FACT, element),
  once: (element: Type) => source(FACT, element),
  stream: (element: Type) => source(OCCURRENCE, element),
  request: (answer: Type) => requestOf(answer),
  eachStrategy: con("eachStrategy"),
  admission: con("admission"),
  timedValue: (element: Type) => con("timedValue", element),
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
  variant("eachStrategy", [], [["Queue", []], ["Latest", []], ["Restart", []], ["Together", []], ["Batch", []]]);
  variant("admission", [], [["Allow", []], ["Deny", [t.string]], ["AlsoAsk", [t.participant]]]);
  const timedRecord = typeInfo({
    name: "timedValue",
    kind: "record",
    origin: "builtin",
    params: ["a"],
    fields: [
      { name: "at", type: t.time, decl: null },
      { name: "value", type: a, decl: null },
    ],
    equality: { never: false, params: new Set([0]) },
  });
  table.types.set("timedValue", timedRecord);
  table.records.push(timedRecord);
  const sourceName = (name: string, kind: Type): TypeInfo =>
    typeInfo({ name, kind: "source", origin: "builtin", params: ["a"], sourceKind: kind, equality: { never: false, params: new Set([0]) } });
  table.types.set("event", sourceName("event", FACT));
  table.types.set("fact", sourceName("fact", FACT));
  table.types.set("once", sourceName("once", FACT));
  table.types.set("stream", sourceName("stream", OCCURRENCE));
  table.types.set("request", sourceName("request", REQUEST));
  // Standard capability interface `Events` built-in types: `Events.kind<'a>` and `Events.envelope<'a>`.
  const eventsKind = typeInfo({
    name: "Events.kind",
    library: "Events",
    visibility: "pub",
    kind: "abstract",
    origin: "builtin",
    params: ["a"],
    equality: { never: false, params: new Set([0]) },
  });
  table.qualifiedTypes.set("Events.kind", eventsKind);
  const eventsEnvelope = typeInfo({
    name: "Events.envelope",
    library: "Events",
    visibility: "pub",
    kind: "record",
    origin: "builtin",
    params: ["a"],
    fields: [
      { name: "specversion", type: t.string, decl: null },
      { name: "kind", type: t.string, decl: null },
      { name: "source", type: t.string, decl: null },
      { name: "id", type: t.string, decl: null },
      { name: "occurredAt", type: t.option(t.time), decl: null },
      { name: "subject", type: t.option(t.string), decl: null },
      { name: "receivedAt", type: t.time, decl: null },
      { name: "data", type: a, decl: null },
    ],
    equality: { never: false, params: new Set([0]) },
  });
  table.qualifiedTypes.set("Events.envelope", eventsEnvelope);
  table.records.push(eventsEnvelope);
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
    // `~except` accepts either a participant or a request handle (separation of duties).
    ["anyOf", null, () => fun([t.list(t.participant)], [optional("except", g())], t.participant)],
    // Resolves to whoever holds or answered a prior request (continuity of ownership).
    ["sameAs", null, () => fun([t.request(g())], [], t.participant)],
    ["cancel", "cancel", () => fun([t.request(g())], [], t.unit)],
    ["status", null, () => {
      const a = g();
      return fun([t.request(a)], [], t.option(t.reply(a)));
    }],
    // Optional implicit `taken` fact: resolves once a request is taken, started by an Agent, or answered.
    ["taken", null, () => fun([t.request(g())], [], t.once(t.time))],
    // Per-request free-text notes stream (`say(r, text)` appends to `r->notes`).
    ["notes", null, () => fun([t.request(g())], [], t.stream(t.string))],
    ["say", "say", () => fun([g("addressee"), t.string], [], t.unit)],
    ["now", null, () => fun([], [], t.time)],
    ["show", null, () => fun([g()], [], t.string)],
    // A reply may be set aside on purpose; a request may not (§6a).
    ["ignore", null, () => fun([newVar(GENERIC, null, false, null, true)], [], t.unit)],
    ["fail", null, () => fun([t.reply(g())], [], g())],
    ["every", null, () => fun([t.duration], [optional("from", t.time)], t.stream(t.time))],
    ["after", null, () => fun([g("deadline")], [], t.stream(t.time))],
    ["never", null, () => fun([], [], t.stream(g()))],
    ["or", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), t.stream(b)], [], t.stream(t.either(a, b)));
    }],
    // Homogeneous stream merge: satisfies `s->merge(never()) == s` and strict associativity.
    ["merge", null, () => {
      const a = g();
      return fun([t.stream(a), t.stream(a)], [], t.stream(a));
    }],
    ["map", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), fun([a], [], b)], [], t.stream(b));
    }],
    // Maps a request's answer while preserving its cancellable `request<'b>` handle.
    ["mapRequest", null, () => {
      const a = g();
      const b = g();
      return fun([t.request(a), fun([a], [], b)], [], t.request(b));
    }],
    ["filter", null, () => {
      const a = g();
      return fun([t.stream(a), fun([a], [], t.bool)], [], t.stream(a));
    }],
    ["filterMap", null, () => {
      const a = g();
      const b = g();
      return fun([t.stream(a), fun([a], [], t.option(b))], [], t.stream(b));
    }],
    // Pure stateful stream accumulator: may stay silent (`None`) or emit (`Some(b)`).
    ["scan", null, () => {
      const a = g(), s = g(), b = g();
      return fun([t.stream(a), s, fun([s, a], [], tuple([s, t.option(b)]))], [], t.stream(b));
    }],
    // Exposes each occurrence's timestamp alongside its value.
    ["timed", null, () => {
      const a = g();
      return fun([t.stream(a)], [], t.stream(t.timedValue(a)));
    }],
    ["gather", null, () => {
      const a = g();
      return fun([t.stream(a)], [], t.stream(t.list(a)));
    }],
    // Structured concurrency: scoped child task whose open requests cancel automatically when it ends.
    ["spawn", "spawn", () => {
      const a = g();
      return fun([fun([], [], a)], [optional("key", t.string)], t.request(a));
    }],
    // Policy scope: clamps every request's `~by` opened inside `f()` to `min(req.~by, scopeDeadline)`.
    ["within", null, () => {
      const a = g();
      return fun([g("deadline"), fun([], [], a)], [], a);
    }],
    // Request-level pure value validator: keeps request identity, rejects invalid answers with structured path errors.
    ["accepting", null, () => {
      const a = g();
      const b = g();
      return fun([t.request(a), fun([a], [], t.result(b, t.string))], [], t.request(b));
    }],
    // forEach waits for each occurrence, so it counts as the wait family.
    ["forEach", "wait", () => {
      const a = g();
      return fun(
        [t.stream(a), fun([a], [], g("handled"))],
        [optional("key", t.string), optional("each", t.eachStrategy), optional("per", fun([a], [], t.string))],
        g(),
      );
    }],
  ];
  return values.map(([name, family, type]) => ({ name, family, type: type() }));
}

/**
 * Built-in data and capability modules (`String`, `List`, `Option`, `Result`,
 * `JSON`, `Events`), available via qualified access (`String.toLowerCase`,
 * `List.map`, `Events.events`, etc.). Pure functions except `Events.events`
 * which constructs a stream source.
 */
export function builtinModuleExports(): Readonly<Record<string, readonly Builtin[]>> {
  const eq = () => newVar(GENERIC, null, true);
  const wrap = (entries: [string, () => Type][]): Builtin[] =>
    entries.map(([name, type]) => ({ name, family: null, type: type() }));
  return {
    String: wrap([
      ["toLowerCase", () => fun([t.string], [], t.string)],
      ["toUpperCase", () => fun([t.string], [], t.string)],
      ["includes", () => fun([t.string, t.string], [], t.bool)],
      ["startsWith", () => fun([t.string, t.string], [], t.bool)],
      ["endsWith", () => fun([t.string, t.string], [], t.bool)],
      ["trim", () => fun([t.string], [], t.string)],
      ["split", () => fun([t.string, t.string], [], t.list(t.string))],
      ["length", () => fun([t.string], [], t.int)],
      ["slice", () => fun([t.string, t.int, t.int], [], t.string)],
    ]),
    List: wrap([
      ["map", () => { const a = g(), b = g(); return fun([t.list(a), fun([a], [], b)], [], t.list(b)); }],
      ["filter", () => { const a = g(); return fun([t.list(a), fun([a], [], t.bool)], [], t.list(a)); }],
      ["filterMap", () => { const a = g(), b = g(); return fun([t.list(a), fun([a], [], t.option(b))], [], t.list(b)); }],
      ["some", () => { const a = g(); return fun([t.list(a), fun([a], [], t.bool)], [], t.bool); }],
      ["every", () => { const a = g(); return fun([t.list(a), fun([a], [], t.bool)], [], t.bool); }],
      ["includes", () => { const a = eq(); return fun([t.list(a), a], [], t.bool); }],
      ["find", () => { const a = g(); return fun([t.list(a), fun([a], [], t.bool)], [], t.option(a)); }],
      ["fold", () => { const a = g(), b = g(); return fun([t.list(a), b, fun([b, a], [], b)], [], b); }],
      ["length", () => { const a = g(); return fun([t.list(a)], [], t.int); }],
      ["concat", () => { const a = g(); return fun([t.list(a), t.list(a)], [], t.list(a)); }],
      ["flatten", () => { const a = g(); return fun([t.list(t.list(a))], [], t.list(a)); }],
    ]),
    Option: wrap([
      ["map", () => { const a = g(), b = g(); return fun([t.option(a), fun([a], [], b)], [], t.option(b)); }],
      ["flatMap", () => { const a = g(), b = g(); return fun([t.option(a), fun([a], [], t.option(b))], [], t.option(b)); }],
      ["withDefault", () => { const a = g(); return fun([t.option(a), a], [], a); }],
      ["isSome", () => { const a = g(); return fun([t.option(a)], [], t.bool); }],
      ["isNone", () => { const a = g(); return fun([t.option(a)], [], t.bool); }],
    ]),
    Result: wrap([
      ["map", () => { const a = g(), b = g(), e = g(); return fun([t.result(a, e), fun([a], [], b)], [], t.result(b, e)); }],
      ["flatMap", () => { const a = g(), b = g(), e = g(); return fun([t.result(a, e), fun([a], [], t.result(b, e))], [], t.result(b, e)); }],
      ["mapError", () => { const a = g(), e1 = g(), e2 = g(); return fun([t.result(a, e1), fun([e1], [], e2)], [], t.result(a, e2)); }],
      ["withDefault", () => { const a = g(), e = g(); return fun([t.result(a, e), a], [], a); }],
      ["isOk", () => { const a = g(), e = g(); return fun([t.result(a, e)], [], t.bool); }],
      ["isError", () => { const a = g(), e = g(); return fun([t.result(a, e)], [], t.bool); }],
    ]),
    JSON: wrap([
      ["decode", () => { const a = g(); return fun([t.json], [], t.result(a, t.string)); }],
      ["encode", () => { const a = g(); return fun([a], [], t.json); }],
      ["get", () => fun([t.json, t.string], [], t.option(t.json))],
      ["asString", () => fun([t.json], [], t.option(t.string))],
      ["asInt", () => fun([t.json], [], t.option(t.int))],
      ["asFloat", () => fun([t.json], [], t.option(t.float))],
      ["asBool", () => fun([t.json], [], t.option(t.bool))],
      ["asList", () => fun([t.json], [], t.option(t.list(t.json)))],
    ]),
    Events: wrap([
      ["kind", () => { const a = g(); return fun([t.string, t.string], [], con("Events.kind", a)); }],
      ["events", () => {
        const a = g();
        return fun(
          [con("Events.kind", a)],
          [optional("source", t.string), optional("subject", t.string)],
          t.stream(con("Events.envelope", a)),
        );
      }],
    ]),
  };
}
