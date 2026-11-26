// Vendored from norn-lang/norn@61e8a966a87029f980f965b95a41f63b3017dff5; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
// Whether a reported value has the form its request asked for (docs/types.md §5a).
import type { Form, ReportForm } from "../frontend/check/forms.js";
import { show, type Value } from "./value.js";

/** Structured path error for form/payload validation: reports every mismatch at once. */
export interface FormPathError {
  path: string;
  expected: string;
  found: string;
}

/** Collects ALL path mismatches `(path, expected, found)` in one pass. */
export function mismatchAll(
  value: Value,
  report: ReportForm,
  options: { ignoreExtraFields?: boolean } = {},
): FormPathError[] {
  const errors: FormPathError[] = [];
  const pending: [Value, Form, string][] = [[value, report.form, "$"]];
  while (pending.length > 0) {
    const [found, form, path] = pending.pop()!;
    if (form.kind === "any") continue;
    if (form.kind === "base") {
      if (form.name === "json") continue;
      if (found.type !== form.name) errors.push({ path, expected: form.name, found: found.type });
    } else if (form.kind === "list") {
      if (found.type !== "list") {
        errors.push({ path, expected: "a list", found: found.type });
      } else {
        for (let i = found.values.length - 1; i >= 0; i--) {
          pending.push([found.values[i]!, form.element, `${path}[${i}]`]);
        }
      }
    } else if (form.kind === "tuple") {
      if (found.type !== "tuple" || found.values.length !== form.elements.length) {
        errors.push({ path, expected: `a tuple of ${form.elements.length}`, found: found.type === "tuple" ? `tuple of ${found.values.length}` : found.type });
      } else {
        for (let i = found.values.length - 1; i >= 0; i--) {
          pending.push([found.values[i]!, form.elements[i]!, `${path}[${i}]`]);
        }
      }
    } else {
      const definition = report.definitions[form.name];
      if (!definition || definition.kind === "host") continue;
      if (definition.kind === "record") {
        if (found.type !== "record") {
          errors.push({ path, expected: form.name, found: found.type });
          continue;
        }
        const names = Object.keys(found.fields);
        if (!options.ignoreExtraFields) {
          for (const extra of names) {
            if (!definition.fields.some((f) => f.name === extra)) {
              errors.push({ path: `${path}.${extra}`, expected: `one of ${definition.fields.map((f) => f.name).join(", ")}`, found: `unexpected field ${extra}` });
            }
          }
        }
        for (let i = definition.fields.length - 1; i >= 0; i--) {
          const field = definition.fields[i]!;
          const item = found.fields[field.name];
          if (item === undefined) {
            errors.push({ path: `${path}.${field.name}`, expected: `${form.name} field ${field.name}`, found: "missing" });
          } else {
            pending.push([item, field.form, `${path}.${field.name}`]);
          }
        }
      } else {
        const constructor = found.type === "variant" ? definition.constructors.find((ctor) => ctor.name === found.name) : undefined;
        if (found.type !== "variant" || constructor === undefined) {
          errors.push({ path, expected: `one of ${definition.constructors.map((ctor) => ctor.name).join(", ")}`, found: found.type === "variant" ? found.name : found.type });
        } else if (found.args.length !== constructor.args.length) {
          errors.push({ path, expected: `${constructor.name} with ${constructor.args.length} value${constructor.args.length === 1 ? "" : "s"}`, found: `${found.args.length} (${show(found)})` });
        } else {
          for (let i = found.args.length - 1; i >= 0; i--) {
            pending.push([found.args[i]!, constructor.args[i]!, `${path}.${constructor.name}[${i}]`]);
          }
        }
      }
    }
  }
  return errors;
}

/** Null when the value fits; otherwise what does not, in words for whoever answered. */
export function mismatch(value: Value, report: ReportForm): string | null {
  const pending: [Value, Form][] = [[value, report.form]];
  for (let pair = pending.pop(); pair !== undefined; pair = pending.pop()) {
    const [found, form] = pair;
    if (form.kind === "any") continue;
    if (form.kind === "base") {
      if (form.name === "json") continue;
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
