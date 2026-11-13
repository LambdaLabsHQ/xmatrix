// Vendored from norn-lang/norn@b082e26527d15f8d5e316326da0d613c6c031405; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The Norn abstract syntax tree.
 *
 * Every node is a plain, JSON-serializable object with a `kind` discriminant
 * and a `span`. Optional children are `null`, never missing; lists are always
 * present, possibly empty. docs/ast.md documents each node with examples, and
 * the JSON form (`norn parse --json`) is exactly these objects.
 */

/** A position in the source. */
export interface Pos {
  /** 1-based line number. Lines end at "\n". */
  line: number;
  /** 1-based column, counted in Unicode code points from the start of the line. A tab is one column. */
  column: number;
  /** 0-based offset in UTF-16 code units, so `source.slice(start.offset, end.offset)` is the node's text. */
  offset: number;
}

/** A source range. `end` is exclusive: it is the position just after the last character. */
export interface Span {
  start: Pos;
  end: Pos;
}

// ---------------------------------------------------------------------------
// Program and top level

/** A whole source file. Items run in order. */
export interface Program {
  kind: "Program";
  body: TopLevelItem[];
  span: Span;
}

/** Type declarations, externals and `open` appear only at the top level of a program. */
export type TopLevelItem = TypeDecl | External | Open | Statement;

/** `type name<'a> = definition`, or `type name<'a>` for an abstract type. */
export interface TypeDecl {
  kind: "TypeDecl";
  /** Lowercase type name, e.g. `probe`. */
  name: string;
  /** Type parameters, e.g. `'a` in `type box<'a> = Box('a)`. */
  params: TypeVar[];
  /**
   * A variant (`A | B(t)`), a record type (`{field: t}`) or an alias to
   * another type. Null for an abstract type such as `type pr`, whose values
   * only the host makes; only a host interface file declares one.
   */
  definition: VariantType | RecordType | TypeExpression | null;
  span: Span;
}

/**
 * `external merged: (string) => event<pr>`: a value that the host supplies,
 * with its type. Only a host interface file declares one.
 */
export interface External {
  kind: "External";
  name: string;
  type: TypeExpression;
  span: Span;
}

/** `open Std`. In v0 the only module is `Std`. */
export interface Open {
  kind: "Open";
  module: "Std";
  span: Span;
}

// ---------------------------------------------------------------------------
// Statements: the contents of a program or a block

export type Statement = Let | LetRec | Expression;

/** `let pattern = value` */
export interface Let {
  kind: "Let";
  pattern: Pattern;
  value: Expression;
  span: Span;
}

/** `let rec f = (…) => … and g = (…) => …`: mutually recursive functions. */
export interface LetRec {
  kind: "LetRec";
  bindings: RecBinding[];
  span: Span;
}

/** One `name = (…) => …` of a `let rec`. The value is always a function literal. */
export interface RecBinding {
  kind: "RecBinding";
  name: string;
  value: Lambda;
  span: Span;
}

// ---------------------------------------------------------------------------
// Expressions

export type Expression =
  | IntLiteral
  | FloatLiteral
  | StringLiteral
  | TemplateLiteral
  | BoolLiteral
  | UnitLiteral
  | TimeLiteral
  | DurationLiteral
  | ParticipantLiteral
  | RefLiteral
  | Identifier
  | Constructor
  | TupleLiteral
  | ListLiteral
  | RecordLiteral
  | FieldAccess
  | Call
  | Pipe
  | Try
  | Unary
  | Binary
  | Lambda
  | Block
  | If
  | Switch;

/** `42`. The value is the canonical decimal string: arbitrary precision, no leading zeros. */
export interface IntLiteral {
  kind: "IntLiteral";
  /** Decimal digits. A leading "-" appears only in a negative literal pattern such as `| -1 =>`. */
  value: string;
  span: Span;
}

/** `1.5`, `2e-3`. Always finite. */
export interface FloatLiteral {
  kind: "FloatLiteral";
  value: number;
  span: Span;
}

/** `"text"`. The value has its escapes decoded. */
export interface StringLiteral {
  kind: "StringLiteral";
  value: string;
  span: Span;
}

/**
 * `` `Verify ${release.version} today` ``. The text pieces and the interpolated
 * expressions alternate: `strings.length === expressions.length + 1`, so the
 * example has strings `["Verify ", " today"]` and one expression.
 */
export interface TemplateLiteral {
  kind: "TemplateLiteral";
  /** Text between interpolations, escapes decoded. */
  strings: string[];
  expressions: Expression[];
  span: Span;
}

/** `true`, `false` */
export interface BoolLiteral {
  kind: "BoolLiteral";
  value: boolean;
  span: Span;
}

/** `()` */
export interface UnitLiteral {
  kind: "UnitLiteral";
  span: Span;
}

/** `2026-11-07T12:00Z`, `2026-11-07T12:00:00+08:00`. Always carries its offset. */
export interface TimeLiteral {
  kind: "TimeLiteral";
  /** The literal as written: an ISO 8601 date-time with offset. */
  value: string;
  /** The instant, in milliseconds since 1970-01-01T00:00Z. */
  epochMs: number;
  /** The written offset from UTC in minutes: `Z` is 0, `+08:00` is 480, `-05:00` is -300. */
  offsetMinutes: number;
  span: Span;
}

/** `30m`, `2h`, `1d`, `1w` */
export interface DurationLiteral {
  kind: "DurationLiteral";
  /** Whole number as a canonical decimal string, like `IntLiteral.value`. */
  amount: string;
  /** Minutes, hours, days or weeks. */
  unit: DurationUnit;
  span: Span;
}

export type DurationUnit = "m" | "h" | "d" | "w";

/** `@alice`, `@codex:2`, `@auto`, `@auto(~repo="acme/api")` */
export interface ParticipantLiteral {
  kind: "ParticipantLiteral";
  /** The name after `@`, e.g. `alice` or `auto`. */
  name: string;
  /** The instance after `:` as a decimal string (`"2"` in `@codex:2`), or null. */
  instance: string | null;
  /** Labelled arguments in parentheses, e.g. `~repo="acme/api"`. Their meaning is host-defined. */
  args: LabelledArg[];
  span: Span;
}

/** `doc"<id>#<section>"`, `channel"<id>"`: a reference to a host document or conversation. */
export interface RefLiteral {
  kind: "RefLiteral";
  refKind: RefKind;
  /** The quoted text, escapes decoded. Its format is host-defined. */
  value: string;
  span: Span;
}

export type RefKind = "doc" | "channel";

/** A lowercase name used as a value: `pr`, `ask`, `push`. */
export interface Identifier {
  kind: "Identifier";
  name: string;
  span: Span;
}

/** A variant constructor: `Ship`, `Done(release)`, `Pair(a, b)`. `args` is empty for `Ship`. */
export interface Constructor {
  kind: "Constructor";
  name: string;
  args: Expression[];
  span: Span;
}

/** `(a, b)`, with at least two elements. */
export interface TupleLiteral {
  kind: "TupleLiteral";
  elements: Expression[];
  span: Span;
}

/**
 * An immutable list: `[a, b]`, `[a, ...rest]`. The spread is only allowed in
 * the last position, so `[a, b, ...rest]` is `a` and `b` in front of `rest`.
 */
export interface ListLiteral {
  kind: "ListLiteral";
  elements: Expression[];
  rest: Expression | null;
  span: Span;
}

/** `{name: "x", count}`, `{...base, count: 2}`. Fields keep source order. */
export interface RecordLiteral {
  kind: "RecordLiteral";
  /** The record copied by `...base`, or null. */
  spread: Expression | null;
  fields: RecordField[];
  span: Span;
}

/** `name: value` in a record. A punned field `{count}` has an `Identifier` value named like the field. */
export interface RecordField {
  kind: "RecordField";
  name: string;
  value: Expression;
  span: Span;
}

/** `release.version` */
export interface FieldAccess {
  kind: "FieldAccess";
  record: Expression;
  field: string;
  span: Span;
}

/** `f(a, ~label=b)`. Arguments keep source order, which is evaluation order. */
export interface Call {
  kind: "Call";
  callee: Expression;
  args: Argument[];
  span: Span;
}

/**
 * `left->callee(args)` means `callee(left, args)`: `left` becomes the first
 * positional argument. `left->callee` and `left->callee()` both have empty
 * `args`. `callee` is an `Identifier` or a parenthesized expression.
 */
export interface Pipe {
  kind: "Pipe";
  left: Expression;
  callee: Expression;
  args: Argument[];
  span: Span;
}

/**
 * Postfix `?` on an outcome, option or result. On anything but `Done`, `Some`
 * or `Ok`, the enclosing function returns that value at once; at the top of
 * a program it ends the program (spec §5).
 */
export interface Try {
  kind: "Try";
  operand: Expression;
  span: Span;
}

/** `!x`, `-x`, `-.x` */
export interface Unary {
  kind: "Unary";
  op: UnaryOperator;
  operand: Expression;
  span: Span;
}

export type UnaryOperator = "!" | "-" | "-.";

/** `a + b`, `a && b`, … All binary operators are left-associative. */
export interface Binary {
  kind: "Binary";
  op: BinaryOperator;
  left: Expression;
  right: Expression;
  span: Span;
}

/** `+.`, `-.`, `*.`, `/.` are the float operators, `++` concatenates strings, as in ReScript. */
export type BinaryOperator =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "+"
  | "-"
  | "++"
  | "+."
  | "-."
  | "*"
  | "/"
  | "*."
  | "/.";

/** `(a, ~b, ~c=1) => body`, `x => body`, `() => body` */
export interface Lambda {
  kind: "Lambda";
  /** Empty for `() => …`. */
  params: Parameter[];
  body: Expression;
  span: Span;
}

/** `{ statements }`. Its value is the last statement's if that is an expression, otherwise `()`. */
export interface Block {
  kind: "Block";
  body: Statement[];
  span: Span;
}

/** `if c { … } else if d { … } else { … }`. Without `else` the value is `()` when `c` is false. */
export interface If {
  kind: "If";
  condition: Expression;
  thenBranch: Block;
  elseBranch: Block | If | null;
  span: Span;
}

/** `switch scrutinee { | pattern => body … }`. Cases are tried in order. */
export interface Switch {
  kind: "Switch";
  scrutinee: Expression;
  cases: Case[];
  span: Span;
}

/**
 * `| pattern if guard => body`. A body of more than one statement is a
 * `Block` that spans from its first statement to its last.
 */
export interface Case {
  kind: "Case";
  pattern: Pattern;
  guard: Expression | null;
  body: Expression;
  span: Span;
}

// ---------------------------------------------------------------------------
// Arguments and parameters

/** A positional argument is the expression itself. */
export type Argument = Expression | LabelledArg;

/** `~label=value`. The punned form `~label` has an `Identifier` value named like the label. */
export interface LabelledArg {
  kind: "LabelledArg";
  label: string;
  value: Expression;
  span: Span;
}

/** A positional parameter is a pattern, usually a `VarPattern` or `WildcardPattern`. */
export type Parameter = Pattern | LabelledParam;

/**
 * `~label`, `~label=default`, `~label as name`, `~label as name=default`.
 * `pattern` is what the argument binds: a `VarPattern` named like the label
 * when there is no `as`. Without a default the argument is required.
 */
export interface LabelledParam {
  kind: "LabelledParam";
  label: string;
  pattern: Pattern;
  defaultValue: Expression | null;
  span: Span;
}

// ---------------------------------------------------------------------------
// Patterns

export type Pattern =
  | WildcardPattern
  | VarPattern
  | LiteralPattern
  | ConstructorPattern
  | TuplePattern
  | ListPattern
  | RecordPattern
  | OrPattern;

/** `_` */
export interface WildcardPattern {
  kind: "WildcardPattern";
  span: Span;
}

/** A lowercase name that binds the matched value: `other`, `release`. */
export interface VarPattern {
  kind: "VarPattern";
  name: string;
  span: Span;
}

/** `"yes"`, `42`, `-1`, `1.5`, `true`, `()`. Matches an equal value. */
export interface LiteralPattern {
  kind: "LiteralPattern";
  literal: IntLiteral | FloatLiteral | StringLiteral | BoolLiteral | UnitLiteral;
  span: Span;
}

/** `TimedOut`, `Done(Ship)`, `Pair(a, _)` */
export interface ConstructorPattern {
  kind: "ConstructorPattern";
  name: string;
  args: Pattern[];
  span: Span;
}

/** `(a, b)` */
export interface TuplePattern {
  kind: "TuplePattern";
  elements: Pattern[];
  span: Span;
}

/** `[]`, `[x]`, `[first, ...rest]`. Without `rest` the list must have exactly these elements. */
export interface ListPattern {
  kind: "ListPattern";
  elements: Pattern[];
  rest: Pattern | null;
  span: Span;
}

/** `{version, state: Done(_)}`. Fields that are not named are not checked. */
export interface RecordPattern {
  kind: "RecordPattern";
  fields: FieldPattern[];
  span: Span;
}

/** `name: pattern` in a record pattern. The punned form `{name}` has a `VarPattern` named like the field. */
export interface FieldPattern {
  kind: "FieldPattern";
  name: string;
  pattern: Pattern;
  span: Span;
}

/** `Done(Ship) | TimedOut`: matches if any alternative matches. Never nested directly in another `OrPattern`. */
export interface OrPattern {
  kind: "OrPattern";
  alternatives: Pattern[];
  span: Span;
}

// ---------------------------------------------------------------------------
// Types (only in type and external declarations: v0 programs carry no annotations)

export type TypeExpression = TypeName | TypeVar | TupleType | FunctionType;

/** `string`, `list<'a>`, `result<int, string>` */
export interface TypeName {
  kind: "TypeName";
  name: string;
  args: TypeExpression[];
  span: Span;
}

/** `'a`. The name is without the quote. */
export interface TypeVar {
  kind: "TypeVar";
  name: string;
  span: Span;
}

/** `(int, string)` */
export interface TupleType {
  kind: "TupleType";
  elements: TypeExpression[];
  span: Span;
}

/**
 * `(string, ~containing: pr) => event<release>`, `() => time`, `string => unit`.
 * Functions are uncurried: one list of parameters, then the result.
 */
export interface FunctionType {
  kind: "FunctionType";
  /** Positional and labelled parameter types, in source order. Empty for `() => …`. */
  params: ParameterType[];
  result: TypeExpression;
  span: Span;
}

/** A positional parameter type is the type itself. */
export type ParameterType = TypeExpression | LabelledType;

/** `~until: duration`, or `~until: duration=?` when a caller may leave the argument out. */
export interface LabelledType {
  kind: "LabelledType";
  label: string;
  type: TypeExpression;
  /** True for `~label: type=?`. */
  optional: boolean;
  span: Span;
}

/** `Ship | Drop | Later(duration)` */
export interface VariantType {
  kind: "VariantType";
  constructors: ConstructorDecl[];
  span: Span;
}

/** `Later(duration)`; `args` is empty for `Ship`. */
export interface ConstructorDecl {
  kind: "ConstructorDecl";
  name: string;
  args: TypeExpression[];
  span: Span;
}

/** `{version: string, notes: list<string>}` */
export interface RecordType {
  kind: "RecordType";
  fields: FieldDecl[];
  span: Span;
}

/** `name: type` in a record type. */
export interface FieldDecl {
  kind: "FieldDecl";
  name: string;
  type: TypeExpression;
  span: Span;
}

// ---------------------------------------------------------------------------

/** Every node kind. */
export type AstNode =
  | Program
  | TypeDecl
  | External
  | Open
  | Let
  | LetRec
  | RecBinding
  | Expression
  | RecordField
  | Case
  | LabelledArg
  | LabelledParam
  | Pattern
  | FieldPattern
  | TypeExpression
  | LabelledType
  | VariantType
  | ConstructorDecl
  | RecordType
  | FieldDecl;

export type NodeKind = AstNode["kind"];

/** The fields of a node kind other than `kind` and `span`. */
export type FieldsOf<K extends NodeKind> = Exclude<keyof Extract<AstNode, { kind: K }>, "kind" | "span">;

/**
 * The fields of every node kind, in their JSON order. In the JSON form each
 * node is `kind`, then these fields in this order, then `span`.
 */
export const NODE_FIELDS = {
  Program: ["body"],
  TypeDecl: ["name", "params", "definition"],
  External: ["name", "type"],
  Open: ["module"],
  Let: ["pattern", "value"],
  LetRec: ["bindings"],
  RecBinding: ["name", "value"],
  IntLiteral: ["value"],
  FloatLiteral: ["value"],
  StringLiteral: ["value"],
  TemplateLiteral: ["strings", "expressions"],
  BoolLiteral: ["value"],
  UnitLiteral: [],
  TimeLiteral: ["value", "epochMs", "offsetMinutes"],
  DurationLiteral: ["amount", "unit"],
  ParticipantLiteral: ["name", "instance", "args"],
  RefLiteral: ["refKind", "value"],
  Identifier: ["name"],
  Constructor: ["name", "args"],
  TupleLiteral: ["elements"],
  ListLiteral: ["elements", "rest"],
  RecordLiteral: ["spread", "fields"],
  RecordField: ["name", "value"],
  FieldAccess: ["record", "field"],
  Call: ["callee", "args"],
  Pipe: ["left", "callee", "args"],
  Try: ["operand"],
  Unary: ["op", "operand"],
  Binary: ["op", "left", "right"],
  Lambda: ["params", "body"],
  Block: ["body"],
  If: ["condition", "thenBranch", "elseBranch"],
  Switch: ["scrutinee", "cases"],
  Case: ["pattern", "guard", "body"],
  LabelledArg: ["label", "value"],
  LabelledParam: ["label", "pattern", "defaultValue"],
  WildcardPattern: [],
  VarPattern: ["name"],
  LiteralPattern: ["literal"],
  ConstructorPattern: ["name", "args"],
  TuplePattern: ["elements"],
  ListPattern: ["elements", "rest"],
  RecordPattern: ["fields"],
  FieldPattern: ["name", "pattern"],
  OrPattern: ["alternatives"],
  TypeName: ["name", "args"],
  TypeVar: ["name"],
  TupleType: ["elements"],
  FunctionType: ["params", "result"],
  LabelledType: ["label", "type", "optional"],
  VariantType: ["constructors"],
  ConstructorDecl: ["name", "args"],
  RecordType: ["fields"],
  FieldDecl: ["name", "type"],
} as const satisfies { readonly [K in NodeKind]: readonly FieldsOf<K>[] };

// Fails to compile if NODE_FIELDS leaves out a field of some node kind.
type UnlistedFields = { [K in NodeKind]: Exclude<FieldsOf<K>, (typeof NODE_FIELDS)[K][number]> }[NodeKind];
const allFieldsListed: [UnlistedFields] extends [never] ? true : UnlistedFields = true;
void allFieldsListed;

// ---------------------------------------------------------------------------
// Schema: what each field may hold. Reading the JSON form checks every node
// against it (json.ts), so a document read back is a well-formed tree.

const EXPRESSION_KINDS = [
  "IntLiteral", "FloatLiteral", "StringLiteral", "TemplateLiteral", "BoolLiteral", "UnitLiteral", "TimeLiteral",
  "DurationLiteral", "ParticipantLiteral", "RefLiteral", "Identifier", "Constructor", "TupleLiteral", "ListLiteral",
  "RecordLiteral", "FieldAccess", "Call", "Pipe", "Try", "Unary", "Binary", "Lambda", "Block", "If", "Switch",
] as const satisfies readonly Expression["kind"][];

/** Patterns other than `OrPattern`, which is never directly inside another one. */
const ALTERNATIVE_KINDS = [
  "WildcardPattern", "VarPattern", "LiteralPattern", "ConstructorPattern", "TuplePattern", "ListPattern", "RecordPattern",
] as const satisfies readonly Pattern["kind"][];

const PATTERN_KINDS = [...ALTERNATIVE_KINDS, "OrPattern"] as const;
const TYPE_KINDS = ["TypeName", "TypeVar", "TupleType", "FunctionType"] as const satisfies readonly TypeExpression["kind"][];
const STATEMENT_KINDS = ["Let", "LetRec", ...EXPRESSION_KINDS] as const;

/** The unions of ast.ts as lists of kinds, by the name an error message uses for them. */
export const NODE_GROUPS = {
  "top-level item": ["TypeDecl", "External", "Open", ...STATEMENT_KINDS],
  statement: STATEMENT_KINDS,
  expression: EXPRESSION_KINDS,
  argument: [...EXPRESSION_KINDS, "LabelledArg"],
  parameter: [...PATTERN_KINDS, "LabelledParam"],
  pattern: PATTERN_KINDS,
  type: TYPE_KINDS,
  "parameter type": [...TYPE_KINDS, "LabelledType"],
} as const satisfies { readonly [group: string]: readonly NodeKind[] };

export type NodeGroup = keyof typeof NODE_GROUPS;

// Fails to compile if a group leaves out a kind of its union.
type Unlisted<Union, Listed extends readonly unknown[]> = Exclude<Union, Listed[number]>;
type UnlistedKinds =
  | Unlisted<TopLevelItem["kind"], (typeof NODE_GROUPS)["top-level item"]>
  | Unlisted<Statement["kind"], typeof STATEMENT_KINDS>
  | Unlisted<Expression["kind"], typeof EXPRESSION_KINDS>
  | Unlisted<Argument["kind"], (typeof NODE_GROUPS)["argument"]>
  | Unlisted<Parameter["kind"], (typeof NODE_GROUPS)["parameter"]>
  | Unlisted<Pattern["kind"], typeof PATTERN_KINDS>
  | Unlisted<TypeExpression["kind"], typeof TYPE_KINDS>
  | Unlisted<ParameterType["kind"], (typeof NODE_GROUPS)["parameter type"]>;
const allKindsGrouped: [UnlistedKinds] extends [never] ? true : UnlistedKinds = true;
void allKindsGrouped;

/**
 * What a field may hold:
 * - `"string"`, `"boolean"`; `"number"` is finite, `"integer"` a safe integer;
 * - `"decimal"` is a canonical decimal string such as `"0"`, `"42"` or `"-1"`,
 *   and `"digits"` one without a sign;
 * - `oneOf`: one of these strings;
 * - `node`: a node of a group, or of one of the listed kinds;
 * - `list`: a list of at least `min` items;
 * - `nullable`: null, or what the inner schema allows.
 */
export type FieldSchema =
  | "string"
  | "boolean"
  | "number"
  | "integer"
  | "decimal"
  | "digits"
  | { readonly oneOf: readonly string[] }
  | { readonly node: NodeGroup | readonly NodeKind[] }
  | { readonly list: FieldSchema; readonly min: number }
  | { readonly nullable: FieldSchema };

const node = (kinds: NodeGroup | readonly NodeKind[]) => ({ node: kinds });
const list = (of: FieldSchema, min = 0) => ({ list: of, min });
const nullable = (of: FieldSchema) => ({ nullable: of });
const expression = node("expression");
const pattern = node("pattern");
const type = node("type");

const UNARY_OPERATORS = ["!", "-", "-."] as const satisfies readonly UnaryOperator[];
const BINARY_OPERATORS = [
  "||", "&&", "==", "!=", "<", "<=", ">", ">=", "+", "-", "++", "+.", "-.", "*", "/", "*.", "/.",
] as const satisfies readonly BinaryOperator[];
const DURATION_UNITS = ["m", "h", "d", "w"] as const satisfies readonly DurationUnit[];
const REF_KINDS = ["doc", "channel"] as const satisfies readonly RefKind[];

// Fail to compile if an enumeration leaves out a value of its type.
type UnlistedValues =
  | Unlisted<UnaryOperator, typeof UNARY_OPERATORS>
  | Unlisted<BinaryOperator, typeof BINARY_OPERATORS>
  | Unlisted<DurationUnit, typeof DURATION_UNITS>
  | Unlisted<RefKind, typeof REF_KINDS>;
const allValuesListed: [UnlistedValues] extends [never] ? true : UnlistedValues = true;
void allValuesListed;

/** The schema of every field of every node kind. The compiler checks that it covers each field. */
export const NODE_SCHEMA: { readonly [K in NodeKind]: { readonly [F in FieldsOf<K>]: FieldSchema } } = {
  Program: { body: list(node("top-level item")) },
  TypeDecl: { name: "string", params: list(node(["TypeVar"])), definition: nullable(node(["VariantType", "RecordType", ...TYPE_KINDS])) },
  External: { name: "string", type },
  Open: { module: { oneOf: ["Std"] } },
  Let: { pattern, value: expression },
  LetRec: { bindings: list(node(["RecBinding"]), 1) },
  RecBinding: { name: "string", value: node(["Lambda"]) },
  IntLiteral: { value: "decimal" },
  FloatLiteral: { value: "number" },
  StringLiteral: { value: "string" },
  TemplateLiteral: { strings: list("string", 1), expressions: list(expression) },
  BoolLiteral: { value: "boolean" },
  UnitLiteral: {},
  TimeLiteral: { value: "string", epochMs: "integer", offsetMinutes: "integer" },
  DurationLiteral: { amount: "digits", unit: { oneOf: DURATION_UNITS } },
  ParticipantLiteral: { name: "string", instance: nullable("digits"), args: list(node(["LabelledArg"])) },
  RefLiteral: { refKind: { oneOf: REF_KINDS }, value: "string" },
  Identifier: { name: "string" },
  Constructor: { name: "string", args: list(expression) },
  TupleLiteral: { elements: list(expression, 2) },
  ListLiteral: { elements: list(expression), rest: nullable(expression) },
  RecordLiteral: { spread: nullable(expression), fields: list(node(["RecordField"])) },
  RecordField: { name: "string", value: expression },
  FieldAccess: { record: expression, field: "string" },
  Call: { callee: expression, args: list(node("argument")) },
  Pipe: { left: expression, callee: expression, args: list(node("argument")) },
  Try: { operand: expression },
  Unary: { op: { oneOf: UNARY_OPERATORS }, operand: expression },
  Binary: { op: { oneOf: BINARY_OPERATORS }, left: expression, right: expression },
  Lambda: { params: list(node("parameter")), body: expression },
  Block: { body: list(node("statement")) },
  If: { condition: expression, thenBranch: node(["Block"]), elseBranch: nullable(node(["Block", "If"])) },
  Switch: { scrutinee: expression, cases: list(node(["Case"]), 1) },
  Case: { pattern, guard: nullable(expression), body: expression },
  LabelledArg: { label: "string", value: expression },
  LabelledParam: { label: "string", pattern, defaultValue: nullable(expression) },
  WildcardPattern: {},
  VarPattern: { name: "string" },
  LiteralPattern: { literal: node(["IntLiteral", "FloatLiteral", "StringLiteral", "BoolLiteral", "UnitLiteral"]) },
  ConstructorPattern: { name: "string", args: list(pattern) },
  TuplePattern: { elements: list(pattern, 2) },
  ListPattern: { elements: list(pattern), rest: nullable(pattern) },
  RecordPattern: { fields: list(node(["FieldPattern"]), 1) },
  FieldPattern: { name: "string", pattern },
  OrPattern: { alternatives: list(node(ALTERNATIVE_KINDS), 2) },
  TypeName: { name: "string", args: list(type) },
  TypeVar: { name: "string" },
  TupleType: { elements: list(type, 2) },
  FunctionType: { params: list(node("parameter type")), result: type },
  LabelledType: { label: "string", type, optional: "boolean" },
  VariantType: { constructors: list(node(["ConstructorDecl"]), 1) },
  ConstructorDecl: { name: "string", args: list(type) },
  RecordType: { fields: list(node(["FieldDecl"]), 1) },
  FieldDecl: { name: "string", type },
};

/**
 * The node kinds that norn-ast version 2 added, for host interface files. A
 * `TypeDecl` whose `definition` is null, an abstract type, also needs version
 * 2. A tree is written with the lowest version that can express it, so a tree
 * without these keeps the exact bytes, and so the code identity, that version
 * 1 gave it.
 */
export const VERSION_2_KINDS = ["External", "FunctionType", "LabelledType"] as const satisfies readonly NodeKind[];
