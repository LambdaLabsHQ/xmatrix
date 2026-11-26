// Vendored from norn-lang/norn@a667dd5a0243281efd075834e7d42a8f371a30d5; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The form of a `run`'s report (docs/types.md §5a): the type the program uses
 * the report as, written as plain data so that a host can show it to whoever
 * holds the request and refuse an answer that does not fit.
 */
import type { TypeTable } from "./declarations.js";
import { SOURCE, printType, resolve, substitute, type Type } from "./types.js";

export type Form =
  | { kind: "base"; name: string }
  | { kind: "list"; element: Form }
  | { kind: "tuple"; elements: Form[] }
  /** A part the program never looks at, such as the elements of a list it only passes on. */
  | { kind: "any" }
  /** A declared type, by its printed name with arguments, as in `option<string>`. */
  | { kind: "named"; name: string };

export type FormDefinition =
  | { kind: "variant"; doc?: string; constructors: { name: string; args: Form[]; doc?: string }[] }
  | { kind: "record"; doc?: string; fields: { name: string; form: Form; doc?: string }[] }
  /** A type only the host can make and check, such as a pull request. */
  | { kind: "host"; doc?: string };

export interface ReportForm {
  form: Form;
  definitions: Record<string, FormDefinition>;
  /** As a message shows it: `verdict`, `list<string>`. */
  text: string;
}

export type FormRefusal = string | { opaque: true; library: string; name: string };

/** The form of a type, or the reason a report cannot have that type. */
export function formOf(type: Type, table: TypeTable): ReportForm | FormRefusal {
  const definitions: Record<string, FormDefinition> = {};
  let refusal: FormRefusal | null = null;
  const read = (part: Type): Form => {
    const shape = resolve(part);
    if (shape.tag === "tuple") return { kind: "tuple", elements: shape.elements.map(read) };
    if (shape.tag === "fun") { refusal ??= "a function"; return { kind: "base", name: "unit" }; }
    if (shape.tag !== "con") return { kind: "any" };
    if (shape.name === SOURCE) { refusal ??= "a request, a fact or a stream"; return { kind: "base", name: "unit" }; }
    // Nobody reports a reply: the type comes from a function that uses ? and then returns the bare value.
    if (shape.name === "reply") { refusal ??= "a reply"; return { kind: "base", name: "unit" }; }
    const info = table.lookupType(shape.name);
    if (info && table.isSealedOpaque(info)) {
      refusal ??= { opaque: true, library: info.library!, name: info.name };
      return { kind: "base", name: "unit" };
    }
    if (info === undefined || info.kind === "base") return { kind: "base", name: shape.name };
    if (info.kind === "list") return { kind: "list", element: read(shape.args[0]!) };
    if (info.kind === "alias") return read(substitute(info.alias!, shape.args, 0));
    const name = printType(shape);
    if (!Object.hasOwn(definitions, name)) {
      definitions[name] = { kind: "host", ...(info.doc ? { doc: info.doc } : {}) }; // Holds the place while a type that mentions itself is read.
      if (info.kind === "variant") {
        definitions[name] = {
          kind: "variant",
          ...(info.doc ? { doc: info.doc } : {}),
          constructors: info.constructors.map((ctor) => ({
            name: ctor.name,
            args: ctor.args.map((arg) => read(substitute(arg, shape.args, 0))),
            ...(ctor.doc ? { doc: ctor.doc } : {}),
          })),
        };
      } else if (info.kind === "record") {
        definitions[name] = {
          kind: "record",
          ...(info.doc ? { doc: info.doc } : {}),
          fields: info.fields.map((field) => ({
            name: field.name,
            form: read(substitute(field.type, shape.args, 0)),
            ...(field.doc ? { doc: field.doc } : {}),
          })),
        };
      }
    }
    return { kind: "named", name };
  };
  const form = read(type);
  return refusal ?? { form, definitions, text: printType(resolve(type)) };
}
