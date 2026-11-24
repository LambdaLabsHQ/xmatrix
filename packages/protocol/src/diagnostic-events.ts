/**
 * The one contract every diagnostic event obeys before it leaves a client or
 * the Hub writes it (docs/guide/privacy.md). An event is a declared set of
 * fields, and a field may only hold one of a fixed list of values, a number,
 * true/false, an opaque identifier, a code, an error's class, a version, or a
 * stack of code locations. A key the event
 * does not declare, or a value outside its field, refuses the whole event:
 * nothing is truncated into shape, so text a person wrote cannot ride along.
 *
 * The one free-form kind, `submitted`, is the text a person chose to send
 * from a failure card. It is declared on that event alone, never filled
 * automatically, and arrives already scrubbed on the person's machine.
 */
export type DiagnosticField =
  | { kind: "enum"; values: readonly string[]; optional?: true }
  | { kind: "number"; min: number; max: number; integer?: true; optional?: true }
  | { kind: "boolean"; optional?: true }
  | { kind: "id"; optional?: true }
  | { kind: "code"; optional?: true }
  | { kind: "version"; optional?: true }
  | { kind: "errorClass"; optional?: true }
  | { kind: "stack"; maxFrames: number; optional?: true }
  | { kind: "submitted"; max: number; optional?: true };

export type DiagnosticEventSchema = Readonly<Record<string, DiagnosticField>>;

type FieldValue<F extends DiagnosticField> =
  F extends { kind: "enum"; values: readonly (infer V)[] } ? V
    : F extends { kind: "number" } ? number
      : F extends { kind: "boolean" } ? boolean
        : string;

type OptionalKeys<S extends DiagnosticEventSchema> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];

/** The typed event a schema admits. */
export type DiagnosticEvent<S extends DiagnosticEventSchema> =
  & { -readonly [K in Exclude<keyof S, OptionalKeys<S>>]: FieldValue<S[K]> }
  & { -readonly [K in OptionalKeys<S>]?: FieldValue<S[K]> };

/** A stable machine-readable code: what Raft's analytics also require of every string. */
const CODE = /^[a-z0-9_-]{1,64}$/u;
/** An opaque identifier the system issued: no spaces, no quotes, bounded. */
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@/-]{0,191}$/u;
/** A release version: `1.0.540`, `2.3.0-beta.4`. */
const VERSION = /^\d{1,6}(\.\d{1,6}){0,3}(-[0-9A-Za-z.]{1,32})?$/u;
/** An error's class as code names it: `TypeError`, `ControlError`. */
const ERROR_CLASS = /^[A-Za-z_$][\w$.]{0,79}$/u;
const FRAME_NAME = String.raw`[\w$.<>[\]/*@-]{1,120}(?: [\w$.<>[\]/*@-]{1,120})?`;
const FRAME_LOCATION = String.raw`[a-z][a-z0-9+.-]*:\/\/[^\s"'\x60<>()?#]{1,400}|<unknown>|<anonymous>|native`;
/** One stack frame as a code location: `    at load (https://…/app.js:10:20)`, nothing else. */
const STACK_FRAME = new RegExp(String.raw`^ {4}at ${FRAME_NAME} \((?:${FRAME_LOCATION}):\d{1,9}:\d{1,9}\)$`, "u");

/** Whether a value is a stable code (`^[a-z0-9_-]{1,64}$`). */
export const isDiagnosticCode = (value: unknown): value is string => typeof value === "string" && CODE.test(value);
/** Whether a value is an opaque identifier. */
export const isDiagnosticId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
/** Whether a value is an error's class name. */
export const isErrorClass = (value: unknown): value is string => typeof value === "string" && ERROR_CLASS.test(value);

/**
 * One parsed stack frame as a `stack` field line: a function name that is not
 * a plain name reads `<anonymous>`, a location loses its query, and one that
 * is not a script URL reads `<unknown>`.
 */
export function diagnosticStackFrame(frame: { function?: string; filename?: string; lineno?: number; colno?: number }): string {
  const name = frame.function && new RegExp(`^${FRAME_NAME}$`, "u").test(frame.function) ? frame.function : "<anonymous>";
  const location = frame.filename?.replace(/[?#].*$/su, "");
  const file = location && new RegExp(`^(?:${FRAME_LOCATION})$`, "u").test(location) ? location : "<unknown>";
  const position = (value: number | undefined) => value !== undefined && Number.isSafeInteger(value) && value >= 0 && value < 1e9 ? value : 0;
  return `    at ${name} (${file}:${position(frame.lineno)}:${position(frame.colno)})`;
}

/** Whether a value fits one declared field. */
export function admitsDiagnosticField(field: DiagnosticField, value: unknown): boolean {
  switch (field.kind) {
    case "enum": return (field.values as readonly unknown[]).includes(value);
    case "number": return typeof value === "number" && Number.isFinite(value) && value >= field.min && value <= field.max &&
      (!field.integer || Number.isSafeInteger(value));
    case "boolean": return typeof value === "boolean";
    case "id": return isDiagnosticId(value);
    case "code": return isDiagnosticCode(value);
    case "version": return typeof value === "string" && VERSION.test(value);
    case "errorClass": return isErrorClass(value);
    case "stack": {
      if (typeof value !== "string") return false;
      const frames = value === "" ? [] : value.split("\n");
      return frames.length <= field.maxFrames && frames.every((line) => STACK_FRAME.test(line));
    }
    case "submitted": return typeof value === "string" && value.length <= field.max;
  }
}

/**
 * The event if every key is declared and every value fits its field;
 * otherwise nothing. Absent optional fields stay absent.
 */
export function parseDiagnosticEvent<S extends DiagnosticEventSchema>(schema: S, value: unknown): DiagnosticEvent<S> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(schema, key)) return undefined;
  }
  const event: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    const fieldValue = input[key];
    if (fieldValue === undefined) {
      if (!field.optional) return undefined;
      continue;
    }
    if (!admitsDiagnosticField(field, fieldValue)) return undefined;
    event[key] = fieldValue;
  }
  return event as DiagnosticEvent<S>;
}
