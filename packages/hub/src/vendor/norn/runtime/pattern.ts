// Vendored from norn-lang/norn@4ea1312845432b288450bcf42411efe29d421882; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import type { Pattern } from "../frontend/ast.js";
import { equal, number, unit, type Value } from "./value.js";

/** Failed matches leave no bindings behind, including failed or-pattern arms. */
export function match(pattern: Pattern, value: Value): Record<string, Value> | null {
  const bindings: Record<string, Value> = Object.create(null);
  function bind(name: string, v: Value): boolean {
    if (Object.hasOwn(bindings, name)) return equal(bindings[name], v);
    bindings[name] = v; return true;
  }
  function matches(p: Pattern, v: Value): boolean {
    switch (p.kind) {
      case "WildcardPattern": return true;
      case "VarPattern": return bind(p.name, v);
      case "LiteralPattern": {
        const n = p.literal;
        const literal: Value = n.kind === "UnitLiteral" ? unit : n.kind === "IntLiteral" ? { type: "int", value: n.value } :
          n.kind === "FloatLiteral" ? number(n.value) : n.kind === "BoolLiteral" ? { type: "bool", value: n.value } : { type: "string", value: n.value };
        return equal(literal, v);
      }
      case "ConstructorPattern": return v.type === "variant" && v.name === p.name && v.args.length === p.args.length && p.args.every((x, i) => matches(x, v.args[i]));
      case "TuplePattern": return v.type === "tuple" && v.values.length === p.elements.length && p.elements.every((x, i) => matches(x, v.values[i]));
      case "ListPattern": return v.type === "list" && v.values.length >= p.elements.length &&
        (p.rest !== null || v.values.length === p.elements.length) && p.elements.every((x, i) => matches(x, v.values[i])) &&
        (p.rest === null || matches(p.rest, { type: "list", values: v.values.slice(p.elements.length) }));
      case "RecordPattern": return v.type === "record" && p.fields.every(f => Object.hasOwn(v.fields, f.name) && matches(f.pattern, v.fields[f.name]));
      case "OrPattern": {
        for (const alternative of p.alternatives) {
          const found = match(alternative, v);
          if (found !== null) return Object.entries(found).every(([k, x]) => bind(k, x));
        }
        return false;
      }
    }
  }
  return matches(pattern, value) ? bindings : null;
}
