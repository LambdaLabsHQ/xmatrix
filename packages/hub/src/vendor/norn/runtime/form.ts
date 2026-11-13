// Vendored from norn-lang/norn@4ea1312845432b288450bcf42411efe29d421882; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
// Whether a reported value has the form its request asked for (docs/types.md §5a).
import type { Form, ReportForm } from "../frontend/check/forms.js";
import type { Value } from "./value.js";

/** Null when the value fits; otherwise what does not, in words for whoever answered. */
export function mismatch(value: Value, report: ReportForm): string | null {
  const pending: [Value, Form][] = [[value, report.form]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [found, form] = pair;
    if (form.kind === "any") continue;
    if (form.kind === "base") {
      if (found.type !== form.name) return `expected ${form.name}, found ${found.type}`;
    } else if (form.kind === "list") {
      if (found.type !== "list") return `expected a list, found ${found.type}`;
      for (const item of found.values) pending.push([item, form.element]);
    } else if (form.kind === "tuple") {
      if (found.type !== "tuple" || found.values.length !== form.elements.length) return `expected a tuple of ${form.elements.length}`;
      found.values.forEach((item, index) => pending.push([item, form.elements[index]!]));
    } else {
      const definition = report.definitions[form.name]!;
      if (definition.kind === "host") continue; // Only the host can make or check one of these.
      if (definition.kind === "record") {
        if (found.type !== "record") return `expected ${form.name}, found ${found.type}`;
        const names = Object.keys(found.fields);
        if (names.length !== definition.fields.length) return `expected the fields of ${form.name}: ${definition.fields.map((field) => field.name).join(", ")}`;
        for (const field of definition.fields) {
          const item = found.fields[field.name];
          if (item === undefined) return `${form.name} needs the field ${field.name}`;
          pending.push([item, field.form]);
        }
      } else {
        const constructor = found.type === "variant" ? definition.constructors.find((ctor) => ctor.name === found.name) : undefined;
        if (found.type !== "variant" || constructor === undefined) return `expected one of ${definition.constructors.map((ctor) => ctor.name).join(", ")}`;
        if (found.args.length !== constructor.args.length) return `${constructor.name} takes ${constructor.args.length} value${constructor.args.length === 1 ? "" : "s"}`;
        found.args.forEach((item, index) => pending.push([item, constructor.args[index]!]));
      }
    }
  }
  return null;
}
