// Vendored from norn-lang/norn@b082e26527d15f8d5e316326da0d613c6c031405; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The Norn parser: tokens to the syntax tree of ast.ts.
 *
 * A hand-written recursive-descent parser. Binary operators use precedence
 * climbing; calls, field access, pipes and `?` form one postfix chain. The
 * syntax rules it follows are in docs/ast.md.
 */
import type * as A from "./ast.js";
import { STACK_EXHAUSTED, isStackExhausted, type Diagnostic } from "./diagnostics.js";
import { lex, type Token, type TokenKind } from "./lexer.js";

export type ParseResult = { ok: true; program: A.Program } | { ok: false; diagnostics: Diagnostic[] };

/**
 * Parses a whole program. Lexical errors are reported alone; otherwise the
 * parser reports one error per top-level item it cannot read and carries on
 * at the next line that starts in column 1.
 *
 * Chains (calls, field access, `->`, `?`, binary and prefix operators, `else
 * if`) are read in loops. Nested constructs such as parentheses, blocks and
 * lambdas recurse, so their only limit is the stack: running out of it is a
 * diagnostic at the construct being read, not a crash.
 */
export function parse(source: string): ParseResult {
  const lexed = lex(source);
  if (lexed.diagnostics.length > 0) return { ok: false, diagnostics: lexed.diagnostics };
  const parser = new Parser(lexed.tokens);
  const program = parser.parseProgram();
  return parser.diagnostics.length > 0 ? { ok: false, diagnostics: parser.diagnostics } : { ok: true, program };
}

class ParseError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

const BINARY_PRECEDENCE: ReadonlyMap<TokenKind, number> = new Map<TokenKind, number>([
  ["||", 1],
  ["&&", 2],
  ["==", 3], ["!=", 3], ["<", 3], ["<=", 3], [">", 3], [">=", 3],
  ["+", 4], ["-", 4], ["++", 4], ["+.", 4], ["-.", 4],
  ["*", 5], ["/", 5], ["*.", 5], ["/.", 5],
]);

/** Tokens that can begin a top-level item, for resuming after an error. */
const ITEM_START: ReadonlySet<TokenKind> = new Set<TokenKind>([
  "let", "type", "open", "if", "switch", "true", "false", "Ident", "UIdent", "Underscore", "Int", "Float", "String",
  "TemplateFull", "TemplateHead", "Time", "Duration", "Participant", "Ref", "(", "[", "{", "!",
]);

/** Hints for words from other languages that end up where a statement should end. */
const FOREIGN_WORDS: ReadonlyMap<string, string> = new Map([
  ["await", "Norn has no 'await': a built-in that waits suspends the program by itself"],
  ["async", "Norn has no 'async': functions are not coloured"],
  ["while", "Norn has no loops: repeat with recursion, or with forEach over a stream"],
  ["for", "Norn has no loops: repeat with recursion, or with forEach over a stream"],
  ["return", "Norn has no 'return': a function's value is its last expression, and postfix ? returns early"],
  ["try", "Norn has no exceptions: switch on the outcome, or use postfix ?"],
  ["function", "functions are written (x) => …"],
  ["const", "bindings are written let x = …"],
  ["var", "bindings are written let x = …"],
]);

class Parser {
  readonly diagnostics: Diagnostic[] = [];
  private readonly tokens: Token[];
  /** For each `(`, the index of its matching `)`, or -1. */
  private readonly closing: Int32Array;
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.closing = new Int32Array(tokens.length).fill(-1);
    const open: number[] = [];
    tokens.forEach((token, index) => {
      if (token.kind === "(") open.push(index);
      if (token.kind === ")" && open.length > 0) this.closing[open.pop()!] = index;
    });
  }

  // Token access -----------------------------------------------------------

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)]!;
  }

  private previous(): Token {
    return this.tokens[Math.max(this.index - 1, 0)]!;
  }

  private next(): Token {
    const token = this.peek();
    if (token.kind !== "EOF") this.index += 1;
    return token;
  }

  private at(kind: TokenKind): boolean {
    return this.peek().kind === kind;
  }

  /** The end of a comma-separated list: its closing token, or the end of the file. */
  private atListEnd(close: TokenKind): boolean {
    return this.at(close) || this.at("EOF");
  }

  private eat(kind: TokenKind): boolean {
    if (!this.at(kind)) return false;
    this.next();
    return true;
  }

  /** Whether a line break separates the current token from the one before it. */
  private atLineStart(): boolean {
    return this.index === 0 || this.previous().span.end.line < this.peek().span.start.line;
  }

  /** A `(` that opens an argument list: it is on the same line as what it applies to. */
  private atArguments(): boolean {
    return this.at("(") && !this.atLineStart();
  }

  /** From the start of `start` to the end of the last token read. */
  private spanFrom(start: { span: A.Span }): A.Span {
    return span(start.span.start, this.previous().span.end);
  }

  // Errors -----------------------------------------------------------------

  private fail(message: string, span: A.Span = this.peek().span): never {
    throw new ParseError({ message, span });
  }

  private expect(kind: TokenKind, context: string): Token {
    if (this.at(kind)) return this.next();
    this.fail(`expected '${kind}' ${context}, found ${describe(this.peek())}`);
  }

  private expectIdent(what: string): Token {
    if (this.at("Ident")) return this.next();
    this.fail(`expected ${what}, found ${describe(this.peek())}`);
  }

  /** The closing token of a comma-separated list, or an error that says what was expected. */
  private closeList(close: TokenKind, open: Token, item: string): Token {
    if (this.at(close)) return this.next();
    const found = this.peek();
    if (found.kind === "EOF") {
      this.fail(`expected '${close}' to close the '${open.text}' at ${where(open)}, found end of file`);
    }
    this.fail(`expected ',' or '${close}' after ${item}, found ${describe(found)}`);
  }

  private noAnnotation(): void {
    if (this.at(":")) this.fail("type annotations are not part of Norn v0: types are inferred (spec §4)");
  }

  // Program and statements -------------------------------------------------

  parseProgram(): A.Program {
    const body: A.TopLevelItem[] = [];
    while (!this.at("EOF")) {
      const start = this.index;
      try {
        body.push(this.parseTopLevelItem());
        this.endStatement([]);
      } catch (error) {
        if (error instanceof ParseError) this.diagnostics.push(error.diagnostic);
        else if (isStackExhausted(error)) this.diagnostics.push({ message: STACK_EXHAUSTED, span: spanOf(this.peek()) });
        else throw error;
        this.recover(start);
      }
    }
    return { kind: "Program", body, span: span({ line: 1, column: 1, offset: 0 }, this.peek().span.end) };
  }

  /** Skips to the next line that starts in column 1 with something that can begin an item. */
  private recover(start: number): void {
    if (this.index === start) this.next();
    while (!this.at("EOF")) {
      const token = this.peek();
      if (token.span.start.column === 1 && this.atLineStart() && ITEM_START.has(token.kind)) return;
      this.next();
    }
  }

  private parseTopLevelItem(): A.TopLevelItem {
    if (this.at("type")) return this.parseTypeDecl();
    if (this.atExternal()) return this.parseExternal();
    if (this.at("open")) return this.parseOpen();
    return this.parseStatement();
  }

  private parseStatement(): A.Statement {
    if (this.at("let")) return this.parseLet();
    if (this.at("type")) this.fail("a type declaration is only allowed at the top level of a program");
    if (this.at("open")) this.fail("'open' is only allowed at the top level of a program");
    if (this.atExternal()) this.fail("an external declaration is only allowed at the top level of a host interface file");
    return this.parseExpression();
  }

  /**
   * `external name: type`. `external` is a keyword only here, at the start of
   * an item and followed by a name on the same line, so programs that use it
   * as a name keep their meaning.
   */
  private atExternal(): boolean {
    const token = this.peek();
    const name = this.peek(1);
    return token.kind === "Ident" && token.text === "external" && name.kind === "Ident" && name.span.start.line === token.span.end.line;
  }

  private parseExternal(): A.External {
    const start = this.next();
    const name = this.next();
    this.expect(":", `after '${name.text}': an external declares its type, as in external merged: (string) => event<pr>`);
    const type = this.parseType();
    return { kind: "External", name: name.text, type, span: this.spanFrom(start) };
  }

  /** After a statement: a `;`, a line break, or the end of the enclosing block or case. */
  private endStatement(terminators: TokenKind[]): void {
    if (this.eat(";")) {
      while (this.eat(";"));
      return;
    }
    const token = this.peek();
    if (token.kind === "EOF" || terminators.includes(token.kind) || this.atLineStart()) return;
    const before = this.previous();
    const hint = before.kind === "Ident" ? FOREIGN_WORDS.get(before.text) : undefined;
    this.fail(`expected a line break or ';' before ${describe(token)}${hint === undefined ? "" : `; ${hint}`}`);
  }

  /** Statements up to `}` (a block) or up to `|` or `}` (a switch case). */
  private parseStatements(inCase: boolean): A.Statement[] {
    const terminators: TokenKind[] = inCase ? ["}", "|"] : ["}"];
    const body: A.Statement[] = [];
    for (;;) {
      while (this.eat(";"));
      const token = this.peek();
      if (token.kind === "EOF" || terminators.includes(token.kind)) return body;
      body.push(this.parseStatement());
      this.endStatement(terminators);
    }
  }

  private parseLet(): A.Let | A.LetRec {
    const letToken = this.next();
    if (this.eat("rec")) {
      const bindings = [this.parseRecBinding("'let rec'")];
      while (this.eat("and")) bindings.push(this.parseRecBinding("'and'"));
      return { kind: "LetRec", bindings, span: this.spanFrom(letToken) };
    }
    const pattern = this.parsePattern();
    this.noAnnotation();
    this.expect("=", "after the pattern of 'let'");
    const value = this.parseExpression();
    if (this.at("and")) this.fail("'and' can only join the functions of a 'let rec'");
    return { kind: "Let", pattern, value, span: this.spanFrom(letToken) };
  }

  private parseRecBinding(after: string): A.RecBinding {
    const name = this.expectIdent(`a function name after ${after}`);
    this.noAnnotation();
    this.expect("=", `after '${name.text}'`);
    const value = this.parseExpression();
    if (value.kind !== "Lambda") {
      this.fail(`'let rec' binds functions only: write 'let rec ${name.text} = (…) => …'`, value.span);
    }
    return { kind: "RecBinding", name: name.text, value, span: this.spanFrom(name) };
  }

  private parseOpen(): A.Open {
    const openToken = this.next();
    const name = this.peek();
    if (name.kind !== "UIdent") this.fail(`expected a module name after 'open', found ${describe(name)}`);
    if (name.text !== "Std") this.fail(`only 'open Std' exists in v0: there is no module ${name.text}`);
    this.next();
    return { kind: "Open", module: "Std", span: this.spanFrom(openToken) };
  }

  // Expressions ------------------------------------------------------------

  private parseExpression(): A.Expression {
    return this.startsLambda() ? this.parseLambda() : this.parseBinary(0);
  }

  /** `x =>`, `_ =>` or `(…) =>`. */
  private startsLambda(): boolean {
    const token = this.peek();
    if (token.kind === "Ident" || token.kind === "Underscore") return this.peek(1).kind === "=>";
    if (token.kind !== "(") return false;
    const close = this.closing[this.index] ?? -1;
    return close >= 0 && this.tokens[close + 1]?.kind === "=>";
  }

  private parseLambda(): A.Lambda {
    const start = this.peek();
    let params: A.Parameter[];
    if (start.kind === "(") {
      params = [];
      const open = this.next();
      while (!this.atListEnd(")")) {
        params.push(this.parseParameter());
        if (!this.eat(",")) break;
      }
      this.closeList(")", open, "a parameter");
    } else {
      this.next();
      params = [start.kind === "Underscore"
        ? { kind: "WildcardPattern", span: spanOf(start) }
        : { kind: "VarPattern", name: start.text, span: spanOf(start) }];
    }
    this.expect("=>", "after the parameters");
    const body = this.parseExpression();
    return { kind: "Lambda", params, body, span: this.spanFrom(start) };
  }

  private parseParameter(): A.Parameter {
    const start = this.peek();
    if (start.kind !== "~") {
      const pattern = this.parsePattern();
      this.noAnnotation();
      if (this.at("=")) this.fail("only a labelled parameter can have a default, as in ~on=[]");
      return pattern;
    }
    this.next();
    const label = this.expectIdent("a label name after '~'");
    let pattern: A.Pattern = { kind: "VarPattern", name: label.text, span: spanOf(label) };
    if (this.eat("as")) pattern = this.parsePattern();
    this.noAnnotation();
    let defaultValue: A.Expression | null = null;
    if (this.eat("=")) {
      if (this.at("?")) {
        this.fail("optional parameters without a default ('~x=?') are not part of Norn v0: give a default, as in ~on=[]");
      }
      defaultValue = this.parseExpression();
    }
    return { kind: "LabelledParam", label: label.text, pattern, defaultValue, span: this.spanFrom(start) };
  }

  private parseBinary(minPrecedence: number): A.Expression {
    let left = this.parseUnary();
    for (;;) {
      const operator = this.peek();
      const precedence = BINARY_PRECEDENCE.get(operator.kind);
      if (precedence === undefined || precedence < minPrecedence) break;
      // `-x` at the start of a line begins a new statement; `- x` continues the line above.
      if ((operator.kind === "-" || operator.kind === "-.") && this.atLineStart() && !spaceAfter(operator, this.peek(1))) break;
      this.next();
      const right = this.parseBinary(precedence + 1);
      left = { kind: "Binary", op: operator.kind as A.BinaryOperator, left, right, span: span(left.span.start, right.span.end) };
    }
    return left;
  }

  private parseUnary(): A.Expression {
    const token = this.peek();
    return token.kind === "!" || token.kind === "-" || token.kind === "-." ? this.parsePrefixed() : this.parsePostfix();
  }

  /** Prefix operators, read in a loop and applied innermost first: `!-x` is `!(-x)`. */
  private parsePrefixed(): A.Expression {
    const operators: Token[] = [];
    for (let token = this.peek(); token.kind === "!" || token.kind === "-" || token.kind === "-."; token = this.peek()) {
      operators.push(this.next());
    }
    let expression = this.parsePostfix();
    for (let index = operators.length - 1; index >= 0; index -= 1) {
      const operator = operators[index]!;
      const op = operator.kind as A.UnaryOperator;
      expression = { kind: "Unary", op, operand: expression, span: span(operator.span.start, expression.span.end) };
    }
    return expression;
  }

  /** An atom followed by calls `(…)`, field access `.f`, pipes `->f(…)` and `?`, read left to right. */
  private parsePostfix(): A.Expression {
    let expression = this.parseAtom();
    for (;;) {
      const token = this.peek();
      if (this.atArguments()) {
        const args = this.parseArguments();
        expression = { kind: "Call", callee: expression, args, span: span(expression.span.start, this.previous().span.end) };
      } else if (token.kind === ".") {
        this.next();
        const field = this.expectIdent("a field name after '.'");
        expression = { kind: "FieldAccess", record: expression, field: field.text, span: span(expression.span.start, field.span.end) };
      } else if (token.kind === "->") {
        this.next();
        expression = this.parsePipe(expression);
      } else if (token.kind === "?") {
        this.next();
        expression = { kind: "Try", operand: expression, span: span(expression.span.start, token.span.end) };
      } else {
        break;
      }
    }
    return expression;
  }

  /** After `->`: a function name or a parenthesized expression, then its own arguments if any. */
  private parsePipe(left: A.Expression): A.Pipe {
    const token = this.peek();
    let callee: A.Expression;
    if (token.kind === "Ident") {
      this.next();
      callee = { kind: "Identifier", name: token.text, span: spanOf(token) };
    } else if (token.kind === "(") {
      callee = this.parseParenthesized();
    } else {
      this.fail(`expected a function name after '->', found ${describe(token)}`);
    }
    const args = this.atArguments() ? this.parseArguments() : [];
    return { kind: "Pipe", left, callee, args, span: span(left.span.start, this.previous().span.end) };
  }

  private parseArguments(): A.Argument[] {
    const open = this.next();
    const args: A.Argument[] = [];
    while (!this.atListEnd(")")) {
      args.push(this.parseArgument());
      if (!this.eat(",")) break;
    }
    this.closeList(")", open, "an argument");
    return args;
  }

  private parseArgument(): A.Argument {
    const start = this.peek();
    if (start.kind !== "~") return this.parseExpression();
    this.next();
    const label = this.expectIdent("a label name after '~'");
    if (!this.eat("=")) {
      const value: A.Identifier = { kind: "Identifier", name: label.text, span: spanOf(label) };
      return { kind: "LabelledArg", label: label.text, value, span: this.spanFrom(start) };
    }
    if (this.at("?")) this.fail("optional arguments ('~x=?') are not part of Norn v0");
    const value = this.parseExpression();
    return { kind: "LabelledArg", label: label.text, value, span: this.spanFrom(start) };
  }

  private parseAtom(): A.Expression {
    const token = this.peek();
    switch (token.kind) {
      case "Int":
        this.next();
        return { kind: "IntLiteral", value: token.value, span: spanOf(token) };
      case "Float":
        this.next();
        return { kind: "FloatLiteral", value: token.value, span: spanOf(token) };
      case "String":
        this.next();
        return { kind: "StringLiteral", value: token.value, span: spanOf(token) };
      case "TemplateFull":
        this.next();
        return { kind: "TemplateLiteral", strings: [token.value], expressions: [], span: spanOf(token) };
      case "TemplateHead":
        return this.parseTemplate();
      case "true":
      case "false":
        this.next();
        return { kind: "BoolLiteral", value: token.kind === "true", span: spanOf(token) };
      case "Time":
        this.next();
        return { kind: "TimeLiteral", value: token.text, epochMs: token.epochMs, offsetMinutes: token.offsetMinutes, span: spanOf(token) };
      case "Duration":
        this.next();
        return { kind: "DurationLiteral", amount: token.amount, unit: token.unit, span: spanOf(token) };
      case "Ref":
        this.next();
        return { kind: "RefLiteral", refKind: token.refKind, value: token.value, span: spanOf(token) };
      case "Participant":
        return this.parseParticipant();
      case "Ident":
        this.next();
        return { kind: "Identifier", name: token.text, span: spanOf(token) };
      case "UIdent":
        return this.parseConstructor();
      case "(":
        return this.parseParenthesized();
      case "[":
        return this.parseList();
      case "{":
        return this.parseBraces();
      case "if":
        return this.parseIf();
      case "switch":
        return this.parseSwitch();
      case "Underscore":
        this.fail("'_' can only be used as a pattern, not as a value");
      case "TypeVar":
        this.fail(`type variables such as ${token.text} can only appear in type declarations`);
      default:
        this.fail(`expected an expression, found ${describe(token)}`);
    }
  }

  private parseTemplate(): A.TemplateLiteral {
    const head = this.next() as Token & { value: string };
    const strings = [head.value];
    const expressions: A.Expression[] = [];
    for (;;) {
      if (this.at("TemplateMiddle") || this.at("TemplateTail")) this.fail("expected an expression inside '${…}'");
      expressions.push(this.parseExpression());
      const token = this.peek();
      if (token.kind !== "TemplateMiddle" && token.kind !== "TemplateTail") {
        this.fail(`expected '}' to end the interpolation, found ${describe(token)}`);
      }
      this.next();
      strings.push(token.value);
      if (token.kind === "TemplateTail") return { kind: "TemplateLiteral", strings, expressions, span: this.spanFrom(head) };
    }
  }

  private parseParticipant(): A.ParticipantLiteral {
    const token = this.next() as Token & { kind: "Participant" };
    const args: A.LabelledArg[] = [];
    if (this.atArguments()) {
      for (const arg of this.parseArguments()) {
        if (arg.kind !== "LabelledArg") {
          this.fail(`arguments of a participant must be labelled, as in @auto(~repo="acme/api")`, arg.span);
        }
        args.push(arg);
      }
    }
    return { kind: "ParticipantLiteral", name: token.name, instance: token.instance, args, span: this.spanFrom(token) };
  }

  private parseConstructor(): A.Constructor {
    const name = this.next();
    if (this.at(".") && this.peek(1).kind === "Ident") {
      this.fail(`qualified names such as ${name.text}.${this.peek(1).text} are not part of Norn v0; 'open Std' brings the standard library into scope`);
    }
    const args: A.Expression[] = [];
    if (this.atArguments()) {
      const open = this.next();
      if (this.at(")")) this.fail(`a constructor without a payload takes no parentheses: write ${name.text}`);
      while (!this.atListEnd(")")) {
        if (this.at("~")) this.fail("the arguments of a constructor cannot be labelled");
        args.push(this.parseExpression());
        if (!this.eat(",")) break;
      }
      this.closeList(")", open, "an argument");
    }
    return { kind: "Constructor", name: name.text, args, span: this.spanFrom(name) };
  }

  /** `()`, `(expression)` or a tuple `(a, b)`. */
  private parseParenthesized(): A.Expression {
    const open = this.next();
    if (this.at(")")) {
      this.next();
      return { kind: "UnitLiteral", span: this.spanFrom(open) };
    }
    const first = this.parseExpression();
    if (this.eat(")")) return first;
    if (!this.at(",")) this.closeList(")", open, "the expression");
    const elements = [first];
    while (this.eat(",")) {
      if (this.atListEnd(")")) break;
      elements.push(this.parseExpression());
    }
    this.closeList(")", open, "a tuple element");
    if (elements.length < 2) this.fail("a tuple needs at least two elements", this.spanFrom(open));
    return { kind: "TupleLiteral", elements, span: this.spanFrom(open) };
  }

  private parseList(): A.ListLiteral {
    const open = this.next();
    const elements: A.Expression[] = [];
    let rest: A.Expression | null = null;
    while (!this.atListEnd("]")) {
      if (this.eat("...")) {
        rest = this.parseExpression();
        this.eat(",");
        if (!this.at("]") && !this.at("EOF")) this.fail("a '...' spread must be the last element of a list");
        break;
      }
      elements.push(this.parseExpression());
      if (!this.eat(",")) break;
    }
    this.closeList("]", open, "a list element");
    return { kind: "ListLiteral", elements, rest, span: this.spanFrom(open) };
  }

  /** A record when `{` is followed by `...`, `name:` or `name,`; otherwise a block. */
  private parseBraces(): A.RecordLiteral | A.Block {
    const first = this.peek(1);
    const second = this.peek(2);
    const isRecord = first.kind === "..." || (first.kind === "Ident" && (second.kind === ":" || second.kind === ","));
    return isRecord ? this.parseRecord() : this.parseBlock("");
  }

  private parseRecord(): A.RecordLiteral {
    const open = this.next();
    let spread: A.Expression | null = null;
    const fields: A.RecordField[] = [];
    if (this.eat("...")) {
      spread = this.parseExpression();
      if (!this.eat(",")) {
        this.closeList("}", open, "the spread");
        return { kind: "RecordLiteral", spread, fields, span: this.spanFrom(open) };
      }
    }
    while (!this.atListEnd("}")) {
      if (this.at("...")) this.fail("a record spread must come first, as in {...base, field: value}");
      const name = this.expectIdent("a field name");
      const value: A.Expression = this.eat(":")
        ? this.parseExpression()
        : { kind: "Identifier", name: name.text, span: spanOf(name) };
      fields.push({ kind: "RecordField", name: name.text, value, span: this.spanFrom(name) });
      if (!this.eat(",")) break;
    }
    this.closeList("}", open, "a field");
    return { kind: "RecordLiteral", spread, fields, span: this.spanFrom(open) };
  }

  /** `{ statements }`. `context` completes "expected '{' …" when the brace is missing. */
  private parseBlock(context: string): A.Block {
    const open = this.peek();
    if (open.kind !== "{") this.fail(`expected '{' ${context}, found ${describe(open)}`);
    this.next();
    const body = this.parseStatements(false);
    if (!this.at("}")) this.fail(`expected '}' to close the '{' at ${where(open)}, found end of file`);
    this.next();
    return { kind: "Block", body, span: this.spanFrom(open) };
  }

  /** `if … else if … else …`, read in a loop: each `else if` is the `elseBranch` of the `If` before it. */
  private parseIf(): A.If {
    const branches: { ifToken: Token; condition: A.Expression; thenBranch: A.Block }[] = [];
    let last: A.Block | null = null;
    for (;;) {
      const ifToken = this.next();
      const condition = this.parseExpression();
      const thenBranch = this.parseBlock("after the condition of 'if'");
      branches.push({ ifToken, condition, thenBranch });
      if (!this.eat("else")) break;
      if (!this.at("if")) {
        last = this.parseBlock("or 'if' after 'else'");
        break;
      }
    }
    const end = this.previous().span.end;
    let elseBranch: A.Block | A.If | null = last;
    for (let index = branches.length - 1; index >= 0; index -= 1) {
      const { ifToken, condition, thenBranch } = branches[index]!;
      elseBranch = { kind: "If", condition, thenBranch, elseBranch, span: span(ifToken.span.start, end) };
    }
    return elseBranch as A.If;
  }

  private parseSwitch(): A.Switch {
    const switchToken = this.next();
    const scrutinee = this.parseExpression();
    const open = this.peek();
    if (open.kind !== "{") this.fail(`expected '{' after the value of 'switch', found ${describe(open)}`);
    this.next();
    const cases: A.Case[] = [];
    while (this.at("|")) cases.push(this.parseCase());
    if (cases.length === 0) this.fail(`expected '|' to start the first case of the switch, found ${describe(this.peek())}`);
    if (!this.at("}")) this.fail(`expected '}' to close the '{' at ${where(open)}, found end of file`);
    this.next();
    return { kind: "Switch", scrutinee, cases, span: this.spanFrom(switchToken) };
  }

  private parseCase(): A.Case {
    const bar = this.next();
    const pattern = this.parsePattern();
    let guard: A.Expression | null = null;
    if (this.eat("if")) guard = this.parseBinary(0);
    this.expect("=>", guard === null ? "after pattern" : "after the guard");
    const body = this.parseStatements(true);
    const first = body[0];
    const last = body[body.length - 1];
    if (first === undefined || last === undefined) this.fail(`expected an expression after '=>', found ${describe(this.peek())}`);
    const value: A.Expression = body.length === 1 && first.kind !== "Let" && first.kind !== "LetRec"
      ? first
      : { kind: "Block", body, span: span(first.span.start, last.span.end) };
    return { kind: "Case", pattern, guard, body: value, span: this.spanFrom(bar) };
  }

  // Patterns ---------------------------------------------------------------

  private parsePattern(): A.Pattern {
    const first = this.parsePrimaryPattern();
    let pattern = first;
    if (this.at("|")) {
      const alternatives: A.Pattern[] = [];
      const add = (alternative: A.Pattern) => {
        if (alternative.kind === "OrPattern") alternatives.push(...alternative.alternatives);
        else alternatives.push(alternative);
      };
      add(first);
      while (this.eat("|")) add(this.parsePrimaryPattern());
      pattern = { kind: "OrPattern", alternatives, span: this.spanFrom(first) };
    }
    return pattern;
  }

  private parsePrimaryPattern(): A.Pattern {
    const token = this.peek();
    switch (token.kind) {
      case "Underscore":
        this.next();
        return { kind: "WildcardPattern", span: spanOf(token) };
      case "Ident":
        this.next();
        return { kind: "VarPattern", name: token.text, span: spanOf(token) };
      case "Int":
      case "Float":
      case "String":
      case "true":
      case "false":
      case "-":
        return this.parseLiteralPattern();
      case "UIdent":
        return this.parseConstructorPattern();
      case "(":
        return this.parseParenthesizedPattern();
      case "[":
        return this.parseListPattern();
      case "{":
        return this.parseRecordPattern();
      case "TemplateFull":
      case "TemplateHead":
        this.fail("a template string cannot be a pattern: use a plain string");
      case "Participant":
      case "Time":
      case "Duration":
      case "Ref":
        this.fail("only strings, numbers, booleans and () can be matched as literals; compare others with == in a guard");
      default:
        this.fail(`expected a pattern, found ${describe(token)}`);
    }
  }

  private parseLiteralPattern(): A.LiteralPattern {
    const start = this.next();
    let literal: A.LiteralPattern["literal"];
    if (start.kind === "-") {
      const number = this.peek();
      if (number.kind === "Int") {
        literal = { kind: "IntLiteral", value: number.value === "0" ? "0" : `-${number.value}`, span: span(start.span.start, number.span.end) };
      } else if (number.kind === "Float") {
        literal = { kind: "FloatLiteral", value: -number.value, span: span(start.span.start, number.span.end) };
      } else {
        this.fail(`expected a number after '-' in a pattern, found ${describe(number)}`);
      }
      this.next();
    } else if (start.kind === "Int") {
      literal = { kind: "IntLiteral", value: start.value, span: spanOf(start) };
    } else if (start.kind === "Float") {
      literal = { kind: "FloatLiteral", value: start.value, span: spanOf(start) };
    } else if (start.kind === "String") {
      literal = { kind: "StringLiteral", value: start.value, span: spanOf(start) };
    } else {
      literal = { kind: "BoolLiteral", value: start.kind === "true", span: spanOf(start) };
    }
    return { kind: "LiteralPattern", literal, span: spanOf(literal) };
  }

  private parseConstructorPattern(): A.ConstructorPattern {
    const name = this.next();
    const args: A.Pattern[] = [];
    if (this.atArguments()) {
      const open = this.next();
      if (this.at(")")) this.fail(`a constructor without a payload takes no parentheses: write ${name.text}`);
      while (!this.atListEnd(")")) {
        args.push(this.parsePattern());
        if (!this.eat(",")) break;
      }
      this.closeList(")", open, "a pattern");
    }
    return { kind: "ConstructorPattern", name: name.text, args, span: this.spanFrom(name) };
  }

  private parseParenthesizedPattern(): A.Pattern {
    const open = this.next();
    if (this.eat(")")) {
      return { kind: "LiteralPattern", literal: { kind: "UnitLiteral", span: this.spanFrom(open) }, span: this.spanFrom(open) };
    }
    const first = this.parsePattern();
    if (this.eat(")")) return first;
    if (!this.at(",")) this.closeList(")", open, "the pattern");
    const elements = [first];
    while (this.eat(",")) {
      if (this.atListEnd(")")) break;
      elements.push(this.parsePattern());
    }
    this.closeList(")", open, "a pattern");
    if (elements.length < 2) this.fail("a tuple pattern needs at least two elements", this.spanFrom(open));
    return { kind: "TuplePattern", elements, span: this.spanFrom(open) };
  }

  private parseListPattern(): A.ListPattern {
    const open = this.next();
    const elements: A.Pattern[] = [];
    let rest: A.Pattern | null = null;
    while (!this.atListEnd("]")) {
      if (this.eat("...")) {
        rest = this.parsePattern();
        this.eat(",");
        if (!this.at("]") && !this.at("EOF")) this.fail("a '...' rest must be the last element of a list pattern");
        break;
      }
      elements.push(this.parsePattern());
      if (!this.eat(",")) break;
    }
    this.closeList("]", open, "a pattern");
    return { kind: "ListPattern", elements, rest, span: this.spanFrom(open) };
  }

  private parseRecordPattern(): A.RecordPattern {
    const open = this.next();
    const fields: A.FieldPattern[] = [];
    while (!this.atListEnd("}")) {
      const name = this.expectIdent("a field name");
      const pattern: A.Pattern = this.eat(":")
        ? this.parsePattern()
        : { kind: "VarPattern", name: name.text, span: spanOf(name) };
      fields.push({ kind: "FieldPattern", name: name.text, pattern, span: this.spanFrom(name) });
      if (!this.eat(",")) break;
    }
    this.closeList("}", open, "a field");
    if (fields.length === 0) this.fail("a record pattern needs at least one field", this.spanFrom(open));
    return { kind: "RecordPattern", fields, span: this.spanFrom(open) };
  }

  // Types ------------------------------------------------------------------

  private parseTypeDecl(): A.TypeDecl {
    const typeToken = this.next();
    const nameToken = this.peek();
    if (nameToken.kind === "UIdent") {
      this.fail(`type names start with a lowercase letter: write 'type ${lowerFirst(nameToken.text)} = …'`);
    }
    const name = this.expectIdent("a type name after 'type'");
    const params: A.TypeVar[] = [];
    if (this.at("<")) {
      const open = this.next();
      while (!this.atListEnd(">")) {
        const variable = this.peek();
        if (variable.kind !== "TypeVar") this.fail(`expected a type variable such as 'a, found ${describe(variable)}`);
        this.next();
        params.push({ kind: "TypeVar", name: variable.text.slice(1), span: spanOf(variable) });
        if (!this.eat(",")) break;
      }
      this.closeList(">", open, "a type variable");
    }
    // Without '=', at the end of the line, the type is abstract: `type pr`.
    if (!this.at("=") && (this.at(";") || this.at("EOF") || this.atLineStart())) {
      return { kind: "TypeDecl", name: name.text, params, definition: null, span: this.spanFrom(typeToken) };
    }
    this.expect("=", `after the type name '${name.text}'`);
    const next = this.peek();
    const definition = next.kind === "|" || next.kind === "UIdent"
      ? this.parseVariantType()
      : next.kind === "{" ? this.parseRecordType() : this.parseType();
    return { kind: "TypeDecl", name: name.text, params, definition, span: this.spanFrom(typeToken) };
  }

  private parseVariantType(): A.VariantType {
    const start = this.peek();
    this.eat("|");
    const constructors = [this.parseConstructorDecl()];
    while (this.eat("|")) constructors.push(this.parseConstructorDecl());
    return { kind: "VariantType", constructors, span: this.spanFrom(start) };
  }

  private parseConstructorDecl(): A.ConstructorDecl {
    const name = this.peek();
    if (name.kind !== "UIdent") {
      this.fail(`expected a constructor name, which starts with an uppercase letter, found ${describe(name)}`);
    }
    this.next();
    const args: A.TypeExpression[] = [];
    if (this.atArguments()) {
      const open = this.next();
      if (this.at(")")) this.fail(`a constructor without a payload takes no parentheses: write ${name.text}`);
      while (!this.atListEnd(")")) {
        args.push(this.parseType());
        if (!this.eat(",")) break;
      }
      this.closeList(")", open, "a type");
    }
    return { kind: "ConstructorDecl", name: name.text, args, span: this.spanFrom(name) };
  }

  private parseRecordType(): A.RecordType {
    const open = this.next();
    const fields: A.FieldDecl[] = [];
    while (!this.atListEnd("}")) {
      const name = this.expectIdent("a field name");
      this.expect(":", `after the field name '${name.text}'`);
      const type = this.parseType();
      fields.push({ kind: "FieldDecl", name: name.text, type, span: this.spanFrom(name) });
      if (!this.eat(",")) break;
    }
    this.closeList("}", open, "a field");
    if (fields.length === 0) this.fail("a record type needs at least one field", this.spanFrom(open));
    return { kind: "RecordType", fields, span: this.spanFrom(open) };
  }

  /**
   * A type: `string`, `list<'a>`, `'a`, `(int, string)`, or a function type
   * such as `(string, ~until: duration=?) => outcome<string>`, `() => time` or
   * `string => unit`. The result of a function type extends as far right as
   * it can, so `int => int => int` is `int => (int => int)`.
   */
  private parseType(): A.TypeExpression {
    const token = this.peek();
    if (token.kind === "(") return this.parseParenthesizedType();
    let type: A.TypeExpression;
    if (token.kind === "TypeVar") {
      this.next();
      type = { kind: "TypeVar", name: token.text.slice(1), span: spanOf(token) };
    } else if (token.kind === "Ident") {
      this.next();
      const args: A.TypeExpression[] = [];
      if (this.at("<")) {
        const open = this.next();
        while (!this.atListEnd(">")) {
          args.push(this.parseType());
          if (!this.eat(",")) break;
        }
        this.closeList(">", open, "a type");
      }
      type = { kind: "TypeName", name: token.text, args, span: this.spanFrom(token) };
    } else if (token.kind === "UIdent") {
      this.fail(`expected a type, found '${token.text}': type names start with a lowercase letter`);
    } else if (token.kind === "~") {
      this.fail("a labelled type such as ~until: duration is only allowed among the parameters of a function type");
    } else {
      this.fail(`expected a type, found ${describe(token)}`);
    }
    return this.at("=>") ? this.parseFunctionType(token, [type]) : type;
  }

  /** `(…)`: the parameters of a function type when `=>` follows, otherwise a tuple type or a parenthesized type. */
  private parseParenthesizedType(): A.TypeExpression {
    const open = this.next();
    const params: A.ParameterType[] = [];
    while (!this.atListEnd(")")) {
      params.push(this.parseParameterType());
      if (!this.eat(",")) break;
    }
    const close = this.closeList(")", open, "a type");
    if (this.at("=>")) return this.parseFunctionType(open, params);
    const labelled = params.find((param) => param.kind === "LabelledType");
    if (labelled !== undefined) {
      this.fail("a labelled type such as ~until: duration is only allowed among the parameters of a function type, which '=>' follows", labelled.span);
    }
    const types = params as A.TypeExpression[];
    if (types.length === 0) this.fail("write 'unit' for the unit type", spanOf(close));
    if (types.length === 1) return types[0]!;
    return { kind: "TupleType", elements: types, span: this.spanFrom(open) };
  }

  /** A positional parameter type, or `~label: type` with `=?` after it when the argument may be left out. */
  private parseParameterType(): A.ParameterType {
    const start = this.peek();
    if (start.kind !== "~") return this.parseType();
    this.next();
    const label = this.expectIdent("a label name after '~'");
    this.expect(":", `after the label '~${label.text}', as in ~${label.text}: duration`);
    const type = this.parseType();
    let optional = false;
    if (this.eat("=")) {
      if (!this.at("?")) {
        this.fail(`expected '?' after '=' in a labelled parameter type, as in ~${label.text}: duration=?, found ${describe(this.peek())}`);
      }
      this.next();
      optional = true;
    }
    return { kind: "LabelledType", label: label.text, type, optional, span: this.spanFrom(start) };
  }

  /** After the parameters: `=> result`. */
  private parseFunctionType(start: Token, params: A.ParameterType[]): A.FunctionType {
    this.expect("=>", "after the parameters of a function type");
    const result = this.parseType();
    return { kind: "FunctionType", params, result, span: this.spanFrom(start) };
  }
}

/**
 * A span of fresh objects. No object appears twice in a tree: every node,
 * span and position is its own, as in a tree read back from JSON.
 */
function span(start: A.Pos, end: A.Pos): A.Span {
  return { start: { ...start }, end: { ...end } };
}

function spanOf(node: { span: A.Span }): A.Span {
  return span(node.span.start, node.span.end);
}

function describe(token: Token): string {
  switch (token.kind) {
    case "EOF":
      return "end of file";
    case "String":
      return "a string";
    case "TemplateFull":
    case "TemplateHead":
      return "a template string";
    case "TemplateMiddle":
    case "TemplateTail":
      return "'}'";
    case "Ref":
      return "a reference";
    case "TypeVar":
      return `the type variable ${token.text}`;
    default:
      return `'${token.text}'`;
  }
}

function where(token: Token): string {
  return `${token.span.start.line}:${token.span.start.column}`;
}

function spaceAfter(token: Token, next: Token): boolean {
  return next.span.start.offset > token.span.end.offset;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}
