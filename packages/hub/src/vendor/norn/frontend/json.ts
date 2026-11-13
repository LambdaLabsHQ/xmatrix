// Vendored from norn-lang/norn@4ea1312845432b288450bcf42411efe29d421882; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The stable JSON form of a Norn syntax tree, as printed by `norn parse --json`.
 *
 * A document is `{"format":"norn-ast","version":1,"program":…}` on one line.
 * Each node is `kind`, then its fields in `NODE_FIELDS` order, then `span`.
 * Writing and reading both check every node against `NODE_SCHEMA`. Neither
 * recurses, so trees of any depth, such as those of long `->` chains, can be
 * written and read. See docs/ast.md.
 *
 * A tree is written with the lowest version that can express it: version 2
 * only when it has a node of `VERSION_2_KINDS` or an abstract type. So the
 * bytes of a version-1 tree, which pin a running program's code, never change.
 */
import {
  NODE_FIELDS, NODE_GROUPS, NODE_SCHEMA, VERSION_2_KINDS, type FieldSchema, type NodeGroup, type NodeKind, type Pos, type Program,
  type Span,
} from "./ast.js";

export const AST_FORMAT = "norn-ast";
/** The newest version this front-end reads and writes. */
export const AST_VERSION = 2;
/** The versions this front-end reads. */
export type AstVersion = 1 | 2;

export interface AstDocument {
  format: typeof AST_FORMAT;
  /** The lowest version that can express the tree. */
  version: AstVersion;
  program: Program;
}

/** A document or tree that does not match the schema. `path` says where, as in `program.body[2].value`. */
export class AstJsonError extends Error {
  readonly path: string;
  constructor(path: string, problem: string) {
    super(path === "" ? problem : `${path}: ${problem}`);
    this.name = "AstJsonError";
    this.path = path;
  }
}

/**
 * Serializes a program as a norn-ast JSON document on one line, with the
 * lowest version that can express it. A tree that breaks the schema is an
 * AstJsonError.
 */
export function astToJson(program: Program): string {
  return write(program, validate(program, AST_VERSION));
}

/**
 * Reads a norn-ast document of version 1 or 2, checking every node against
 * the schema. A version-1 document may not hold what version 2 added. A
 * problem is an AstJsonError that names its path.
 */
export function astFromJson(text: string): Program {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new AstJsonError("", `not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(document) || document["format"] !== AST_FORMAT) throw new AstJsonError("", `not a ${AST_FORMAT} document`);
  const version = document["version"];
  if (version !== 1 && version !== 2) {
    throw new AstJsonError("version", `unsupported ${AST_FORMAT} version ${describe(version)}; expected 1 or 2`);
  }
  for (const key of Object.keys(document)) {
    if (key !== "format" && key !== "version" && key !== "program") throw new AstJsonError("", `unknown field ${JSON.stringify(key)} in the document`);
  }
  if (!Object.hasOwn(document, "program")) throw new AstJsonError("", "the document has no program");
  validate(document["program"], version);
  return document["program"] as Program;
}

/**
 * Checks that a value is a well-formed program tree, as NODE_SCHEMA describes,
 * and returns it. A node or list that appears twice is refused, which also
 * rules out cycles: code that numbers nodes by identity can rely on it.
 */
export function validateProgram(value: unknown): Program {
  validate(value, AST_VERSION);
  return value as Program;
}

/** The lowest norn-ast version that can express a well-formed tree: 2 if it has an external, a function type or an abstract type. */
export function astVersion(program: Program): AstVersion {
  return validate(program, AST_VERSION);
}

/** Checks a tree against the schema of a version, and returns the lowest version that can express it. */
function validate(value: unknown, version: AstVersion): AstVersion {
  const tasks: Task[] = [{ value, schema: { node: ["Program"] }, path: { parent: null, segment: "program" } }];
  const context: Context = { seen: new Set<object>(), version, needed: 1 };
  for (let task = tasks.pop(); task !== undefined; task = tasks.pop()) check(task, tasks, context);
  return context.needed;
}

// Checking --------------------------------------------------------------------

/** A path is built only when a check fails, so deep trees do not pay for long path strings. */
interface Path {
  parent: Path | null;
  segment: string;
}

interface Task {
  value: unknown;
  schema: FieldSchema;
  path: Path;
}

interface Context {
  /** The nodes and lists met so far. */
  seen: Set<object>;
  /** The version of the document being read: what it may hold. */
  version: AstVersion;
  /** The lowest version that can express what was met so far. */
  needed: AstVersion;
}

const VERSION_2: ReadonlySet<string> = new Set(VERSION_2_KINDS);

type JsonObject = { [key: string]: unknown };

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeKind(kind: string): kind is NodeKind {
  return Object.hasOwn(NODE_FIELDS, kind);
}

function child(parent: Path, key: string | number): Path {
  return { parent, segment: typeof key === "number" ? `[${key}]` : `.${key}` };
}

function render(path: Path): string {
  const segments: string[] = [];
  for (let at: Path | null = path; at !== null; at = at.parent) segments.push(at.segment);
  return segments.reverse().join("");
}

function fail(path: Path, problem: string): never {
  throw new AstJsonError(render(path), problem);
}

/** Checks one value; what it contains is pushed onto `tasks` in reverse, so problems are found in document order. */
function check({ value, schema, path }: Task, tasks: Task[], context: Context): void {
  if (typeof schema === "string") return checkScalar(value, schema, path);
  if ("oneOf" in schema) {
    if (typeof value !== "string" || !schema.oneOf.includes(value)) {
      fail(path, `expected one of ${schema.oneOf.map((option) => JSON.stringify(option)).join(", ")}, found ${describe(value)}`);
    }
    return;
  }
  if ("nullable" in schema) {
    if (value !== null) tasks.push({ value, schema: schema.nullable, path });
    return;
  }
  if ("list" in schema) {
    if (!Array.isArray(value)) fail(path, `expected a list, found ${describe(value)}`);
    once(value, path, context.seen);
    if (value.length < schema.min) fail(path, `expected at least ${schema.min} ${schema.min === 1 ? "item" : "items"}, found ${value.length}`);
    for (let index = value.length - 1; index >= 0; index -= 1) tasks.push({ value: value[index], schema: schema.list, path: child(path, index) });
    return;
  }
  checkNode(value, schema.node, path, tasks, context);
  once(value as object, path, context.seen);
}

function needVersion2(context: Context, path: Path, what: string): void {
  if (context.version < 2) fail(path, `${what} needs ${AST_FORMAT} version 2, but this document is version ${context.version}`);
  context.needed = 2;
}

function once(value: object, path: Path, seen: Set<object>): void {
  if (seen.has(value)) fail(path, `this ${Array.isArray(value) ? "list" : "node"} also appears elsewhere in the tree; each must be its own object`);
  seen.add(value);
}

function checkNode(value: unknown, allowed: NodeGroup | readonly NodeKind[], path: Path, tasks: Task[], context: Context): void {
  if (!isObject(value)) fail(path, `expected ${expected(allowed)}, found ${describe(value)}`);
  const kind = value["kind"];
  if (kind === undefined) fail(path, `expected ${expected(allowed)}, found an object without a kind`);
  if (typeof kind !== "string") fail(child(path, "kind"), `expected a string, found ${describe(kind)}`);
  if (!isNodeKind(kind)) fail(child(path, "kind"), `unknown node kind ${JSON.stringify(kind)}`);
  const kinds: readonly NodeKind[] = typeof allowed === "string" ? NODE_GROUPS[allowed] : allowed;
  if (!kinds.includes(kind)) {
    if (kind === "OrPattern" && kinds.includes("VarPattern")) fail(path, "an OrPattern cannot be an alternative of another OrPattern; list its alternatives directly");
    fail(path, `expected ${expected(allowed)}, found ${article(kind)} ${kind} node`);
  }
  const fields = NODE_FIELDS[kind] as readonly string[];
  checkKeys(value, ["kind", ...fields, "span"], path);
  checkSpan(value["span"], child(path, "span"));
  if (VERSION_2.has(kind)) needVersion2(context, path, `${article(kind)} ${kind} node`);
  if (kind === "TypeDecl" && value["definition"] === null) {
    needVersion2(context, child(path, "definition"), "an abstract type, whose definition is null,");
  }
  if (kind === "TemplateLiteral") {
    const { strings, expressions } = value;
    if (Array.isArray(strings) && Array.isArray(expressions) && strings.length !== expressions.length + 1) {
      fail(path, `a template has one more string than expressions, found ${strings.length} and ${expressions.length}`);
    }
  }
  const schema = NODE_SCHEMA[kind] as { readonly [field: string]: FieldSchema };
  for (let index = fields.length - 1; index >= 0; index -= 1) {
    const field = fields[index]!;
    tasks.push({ value: value[field], schema: schema[field]!, path: child(path, field) });
  }
}

/** Exactly these keys: an unknown key is reported before a missing one. */
function checkKeys(object: JsonObject, keys: readonly string[], path: Path): void {
  for (const key of Object.keys(object)) {
    if (!keys.includes(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(object, key)) fail(path, `missing field ${JSON.stringify(key)}`);
  }
}

function checkSpan(value: unknown, path: Path): void {
  if (!isObject(value)) fail(path, `expected a span {start, end}, found ${describe(value)}`);
  checkKeys(value, ["start", "end"], path);
  const start = checkPos(value["start"], child(path, "start"));
  const end = checkPos(value["end"], child(path, "end"));
  if (end.offset < start.offset) fail(path, `the span ends at offset ${end.offset}, before it starts at ${start.offset}`);
}

function checkPos(value: unknown, path: Path): Pos {
  if (!isObject(value)) fail(path, `expected a position {line, column, offset}, found ${describe(value)}`);
  checkKeys(value, ["line", "column", "offset"], path);
  for (const key of ["line", "column", "offset"]) {
    const number = value[key];
    const least = key === "offset" ? 0 : 1;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < least) {
      fail(child(path, key), `expected ${least === 0 ? "a non-negative" : "a positive"} integer, found ${describe(number)}`);
    }
  }
  return value as unknown as Pos;
}

const DECIMAL = /^(0|-?[1-9][0-9]*)$/;
const DIGITS = /^(0|[1-9][0-9]*)$/;

function checkScalar(value: unknown, type: Extract<FieldSchema, string>, path: Path): void {
  const ok =
    type === "string" ? typeof value === "string"
    : type === "boolean" ? typeof value === "boolean"
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "decimal" ? typeof value === "string" && DECIMAL.test(value)
    : typeof value === "string" && DIGITS.test(value);
  if (ok) return;
  const wanted: { readonly [T in Extract<FieldSchema, string>]: string } = {
    string: "a string",
    boolean: "true or false",
    number: "a finite number",
    integer: "an integer",
    decimal: `a decimal integer string such as "42" or "-1"`,
    digits: `a string of digits such as "42"`,
  };
  fail(path, `expected ${wanted[type]}, found ${describe(value)}`);
}

function expected(allowed: NodeGroup | readonly NodeKind[]): string {
  if (typeof allowed === "string") return `${article(allowed)} ${allowed}`;
  const names = allowed.length <= 2 ? allowed.join(" or ") : `${allowed.slice(0, -1).join(", ")} or ${allowed.at(-1)}`;
  return `${article(names)} ${names} node`;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return "a list";
  if (isObject(value)) return typeof value["kind"] === "string" ? `${article(value["kind"])} ${value["kind"]} node` : "an object";
  return `a ${typeof value}`;
}

// Writing ---------------------------------------------------------------------

/** Text to emit as it is, as opposed to a value still to be written. */
class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

const COMMA = new Raw(",");
const CLOSE_LIST = new Raw("]");

/** Writes a checked tree, without recursion. */
function write(program: Program, version: AstVersion): string {
  const out = [`{"format":${JSON.stringify(AST_FORMAT)},"version":${version},"program":`];
  const stack: unknown[] = [new Raw("}"), program];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item instanceof Raw) {
      out.push(item.text);
    } else if (Array.isArray(item)) {
      out.push("[");
      stack.push(CLOSE_LIST);
      for (let index = item.length - 1; index >= 0; index -= 1) {
        stack.push(item[index]);
        if (index > 0) stack.push(COMMA);
      }
    } else if (isObject(item)) {
      const kind = item["kind"] as NodeKind;
      out.push(`{"kind":${JSON.stringify(kind)}`);
      stack.push(new Raw(`,"span":${spanJson(item["span"] as Span)}}`));
      const fields = NODE_FIELDS[kind] as readonly string[];
      for (let index = fields.length - 1; index >= 0; index -= 1) {
        stack.push(item[fields[index]!]);
        stack.push(new Raw(`,${JSON.stringify(fields[index])}:`));
      }
    } else {
      out.push(JSON.stringify(item));
    }
  }
  return out.join("");
}

function spanJson({ start, end }: Span): string {
  return `{"start":${posJson(start)},"end":${posJson(end)}}`;
}

function posJson({ line, column, offset }: Pos): string {
  return `{"line":${line},"column":${column},"offset":${offset}}`;
}
