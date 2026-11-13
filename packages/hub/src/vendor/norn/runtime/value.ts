// Vendored from norn-lang/norn@186f2084b147284f08a133ffa7f4987569796f2e; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/** All language values have a lossless JSON representation. */
export type Value =
  | { type: "unit" }
  | { type: "bool"; value: boolean }
  | { type: "string" | "int" | "float" | "time" | "duration"; value: string }
  | { type: "participant"; name: string; instance: string | null; labels: Record<string, Value> }
  | { type: "ref"; kind: "doc" | "channel"; value: string }
  | { type: "variant"; name: string; args: Value[] }
  | { type: "list" | "tuple"; values: Value[] }
  | { type: "record"; fields: Record<string, Value> }
  | { type: "closure"; node: string; environment: string }
  | { type: "builtin"; name: string }
  | { type: "request"; id: string }
  | { type: "source"; kind: "fact" | "stream"; name: string; args: Value[]; labels: Record<string, Value> };

/** Plain data: what a ledger holds and what crosses a restart. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const unit: Value = { type: "unit" };
export const text = (value: string): Value => ({ type: "string", value });
export const variant = (name: string, ...args: Value[]): Value => ({ type: "variant", name, args });
export function number(value: number): Value {
  if (!Number.isFinite(value)) throw new Error("Floating-point result is not finite");
  return { type: "float", value: Object.is(value, -0) ? "-0" : String(value) };
}
export function equal(a: Value, b: Value): boolean {
  if (a.type === "closure" || b.type === "closure" || a.type === "builtin" || b.type === "builtin") {
    throw new Error("Functions cannot be compared");
  }
  if (a.type !== b.type) return false;
  if (a.type === "record" && b.type === "record") {
    const keys = Object.keys(a.fields).sort();
    return keys.length === Object.keys(b.fields).length && keys.every(k => Object.hasOwn(b.fields, k) && equal(a.fields[k], b.fields[k]));
  }
  if (a.type === "variant" && b.type === "variant") return a.name === b.name && equalValues(a.args, b.args);
  if ((a.type === "list" || a.type === "tuple") && (b.type === "list" || b.type === "tuple")) return equalValues(a.values, b.values);
  if (a.type === "float" && b.type === "float") return Number(a.value) === Number(b.value);
  if (a.type === "participant" && b.type === "participant") return a.name === b.name && a.instance === b.instance &&
    equal({ type: "record", fields: a.labels }, { type: "record", fields: b.labels });
  if (a.type === "source" && b.type === "source") return a.name === b.name && a.kind === b.kind && equalValues(a.args, b.args) &&
    equal({ type: "record", fields: a.labels }, { type: "record", fields: b.labels });
  // Other structured values are descriptors with a canonical field order.
  return JSON.stringify(a) === JSON.stringify(b);
}
function equalValues(a: Value[], b: Value[]): boolean { return a.length === b.length && a.every((v, i) => equal(v, b[i])); }
export function show(value: Value): string {
  switch (value.type) {
    case "unit": return "()";
    case "bool": return String(value.value);
    case "string": case "int": case "float": return value.value;
    case "time": return new Date(Number(value.value)).toISOString();
    case "duration": {
      const ms = BigInt(value.value);
      for (const [unit, amount] of [["w", 604_800_000n], ["d", 86_400_000n], ["h", 3_600_000n], ["m", 60_000n]] as const) {
        if (ms !== 0n && ms % amount === 0n) return `${ms / amount}${unit}`;
      }
      return `${ms}ms`;
    }
    case "participant":
      if (value.name === "anyOf") return `anyOf(${show(value.labels.of)}${value.labels.except ? `, ~except=${show(value.labels.except)}` : ""})`;
      return `@${value.name}${value.instance === null ? "" : `:${value.instance}`}`;
    case "ref": return `${value.kind}"${value.value}"`;
    case "variant": return value.name + (value.args.length ? `(${value.args.map(show).join(", ")})` : "");
    case "list": return `[${value.values.map(show).join(", ")}]`;
    case "tuple": return `(${value.values.map(show).join(", ")})`;
    case "record": return `{${Object.entries(value.fields).map(([k, v]) => `${k}: ${show(v)}`).join(", ")}}`;
    case "closure": case "builtin": return "<function>";
    case "request": return `<request ${value.id}>`;
    case "source": return `<${value.kind} ${value.name}>`;
  }
}
/** Stable key for a value, independent of object insertion order: names a fact, a stream or a request's content. */
export function eventKey(value: Value): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v)]));
    return item;
  }
  return JSON.stringify(canonical(value));
}
