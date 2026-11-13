// Vendored from norn-lang/norn@b082e26527d15f8d5e316326da0d613c6c031405; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
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
  | { kind: "variant"; constructors: { name: string; args: Form[] }[] }
  | { kind: "record"; fields: { name: string; form: Form }[] }
  /** A type only the host can make and check, such as a pull request. */
  | { kind: "host" };

export interface ReportForm {
  form: Form;
  definitions: Record<string, FormDefinition>;
  /** As a message shows it: `verdict`, `list<string>`. */
  text: string;
}

/** The form of a type, or the reason a report cannot have that type. */
export function formOf(type: Type, table: TypeTable): ReportForm | string {
  const definitions: Record<string, FormDefinition> = {};
  let refusal: string | null = null;
  const read = (part: Type): Form => {
    const shape = resolve(part);
    if (shape.tag === "tuple") return { kind: "tuple", elements: shape.elements.map(read) };
    if (shape.tag === "fun") { refusal ??= "a function"; return { kind: "base", name: "unit" }; }
    if (shape.tag !== "con") return { kind: "any" };
    if (shape.name === SOURCE) { refusal ??= "a request, a fact or a stream"; return { kind: "base", name: "unit" }; }
    // Nobody reports a reply: the type comes from a function that uses ? and then returns the bare value.
    if (shape.name === "reply") { refusal ??= "a reply"; return { kind: "base", name: "unit" }; }
    const info = table.types.get(shape.name);
    if (info === undefined || info.kind === "base") return { kind: "base", name: shape.name };
    if (info.kind === "list") return { kind: "list", element: read(shape.args[0]!) };
    if (info.kind === "alias") return read(substitute(info.alias!, shape.args, 0));
    const name = printType(shape);
    if (!Object.hasOwn(definitions, name)) {
      definitions[name] = { kind: "host" }; // Holds the place while a type that mentions itself is read.
      if (info.kind === "variant") {
        definitions[name] = { kind: "variant", constructors: info.constructors.map((ctor) => ({ name: ctor.name, args: ctor.args.map((arg) => read(substitute(arg, shape.args, 0))) })) };
      } else if (info.kind === "record") {
        definitions[name] = { kind: "record", fields: info.fields.map((field) => ({ name: field.name, form: read(substitute(field.type, shape.args, 0)) })) };
      }
    }
    return { kind: "named", name };
  };
  const form = read(type);
  return refusal ?? { form, definitions, text: printType(resolve(type)) };
}
