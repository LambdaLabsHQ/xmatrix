// Vendored from norn-lang/norn@186f2084b147284f08a133ffa7f4987569796f2e; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The Norn lexer: source text to tokens.
 *
 * Besides ReScript's tokens it reads Norn's literals: participants (`@alice`,
 * `@codex:2`), references (`doc"…"`), times (`2026-11-07T12:00Z`) and
 * durations (`30m`). Template strings become a head, middles and a tail around
 * their interpolations, so the parser sees `${…}` contents as ordinary tokens.
 */
import type { DurationUnit, Pos, RefKind, Span } from "./ast.js";
import type { Diagnostic } from "./diagnostics.js";

export const KEYWORDS = ["let", "rec", "and", "if", "else", "switch", "type", "open", "true", "false", "as"] as const;
export type Keyword = (typeof KEYWORDS)[number];

/** Longest first, so that `...` wins over `.` and `->` over `-`. */
const PUNCTUATORS = [
  "...",
  "=>", "->", "==", "!=", "<=", ">=", "&&", "||", "++", "+.", "-.", "*.", "/.",
  "(", ")", "[", "]", "{", "}", ",", ";", ":", ".", "=", "|", "~", "?", "!", "<", ">", "+", "-", "*", "/",
] as const;
export type Punctuator = (typeof PUNCTUATORS)[number];

export const REF_KINDS: readonly RefKind[] = ["doc", "channel"];
const DURATION_UNITS: readonly string[] = ["m", "h", "d", "w"] satisfies DurationUnit[];

interface TokenBase {
  /** The source text of the token. */
  text: string;
  span: Span;
}

export type Token =
  | (TokenBase & { kind: Keyword | Punctuator | "Ident" | "UIdent" | "Underscore" | "TypeVar" | "EOF" })
  | (TokenBase & { kind: "Int"; value: string })
  | (TokenBase & { kind: "Float"; value: number })
  | (TokenBase & { kind: "String"; value: string })
  | (TokenBase & { kind: "TemplateFull" | "TemplateHead" | "TemplateMiddle" | "TemplateTail"; value: string })
  | (TokenBase & { kind: "Time"; epochMs: number; offsetMinutes: number })
  | (TokenBase & { kind: "Duration"; amount: string; unit: DurationUnit })
  | (TokenBase & { kind: "Participant"; name: string; instance: string | null })
  | (TokenBase & { kind: "Ref"; refKind: RefKind; value: string });

export type TokenKind = Token["kind"];

export interface LexResult {
  /** Always ends with an `EOF` token. */
  tokens: Token[];
  diagnostics: Diagnostic[];
}

export function lex(source: string): LexResult {
  return new Lexer(source).run();
}

/** Thrown inside the lexer to abandon the current token; `run` records it and goes on. */
class LexError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(diagnostic: Diagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

/** An open `{`, or the `${` of a template whose matching `}` resumes the template text. */
type Brace = { template: false } | { template: true; start: Pos };

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const DIGITS = /[0-9]+/y;
const DATE = /([0-9]{4})-([0-9]{2})-([0-9]{2})/y;
const TIME_OF_DAY = /T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?/y;
const OFFSET = /Z|([+-])([0-9]{2}):([0-9]{2})/y;
const PARTICIPANT = /@([A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*)(?::([0-9]+))?/y;
const TYPE_VAR = /'[a-z_][A-Za-z0-9_]*/y;

class Lexer {
  private readonly source: string;
  private offset = 0;
  private line = 1;
  private column = 1;
  private readonly tokens: Token[] = [];
  private readonly diagnostics: Diagnostic[] = [];
  private readonly braces: Brace[] = [];

  constructor(source: string) {
    this.source = source;
    if (source.startsWith("﻿")) this.offset = 1;
  }

  run(): LexResult {
    for (;;) {
      try {
        this.skipTrivia();
        if (this.offset >= this.source.length) break;
        this.token();
      } catch (error) {
        if (!(error instanceof LexError)) throw error;
        this.diagnostics.push(error.diagnostic);
      }
    }
    const open = this.braces.findLast((brace) => brace.template);
    if (open?.template) this.report("unterminated template string", open.start);
    const end = this.here();
    this.tokens.push({ kind: "EOF", text: "", span: { start: end, end } });
    return { tokens: this.tokens, diagnostics: this.diagnostics };
  }

  // Positions --------------------------------------------------------------

  private here(): Pos {
    return { line: this.line, column: this.column, offset: this.offset };
  }

  private peekChar(ahead = 0): string {
    return this.source.charAt(this.offset + ahead);
  }

  /** Moves past one code point, keeping line and column. */
  private advance(): string {
    const code = this.source.codePointAt(this.offset);
    if (code === undefined) return "";
    const character = String.fromCodePoint(code);
    this.offset += character.length;
    if (character === "\n") {
      this.line += 1;
      this.column = 1;
    } else {
      this.column += 1;
    }
    return character;
  }

  /** Moves past `count` characters known to be ASCII and not line breaks. */
  private skipAscii(count: number): void {
    this.offset += count;
    this.column += count;
  }

  private match(pattern: RegExp): RegExpExecArray | null {
    pattern.lastIndex = this.offset;
    return pattern.exec(this.source);
  }

  private report(message: string, start: Pos, end: Pos = start): void {
    this.diagnostics.push({ message, span: { start, end } });
  }

  private fail(message: string, start: Pos, end: Pos = this.here()): never {
    throw new LexError({ message, span: { start, end } });
  }

  private push(token: Token): void {
    this.tokens.push(token);
  }

  private base(start: Pos): TokenBase {
    const end = this.here();
    return { text: this.source.slice(start.offset, end.offset), span: { start, end } };
  }

  // Trivia -----------------------------------------------------------------

  private skipTrivia(): void {
    for (;;) {
      const character = this.peekChar();
      if (character === " " || character === "\t" || character === "\r" || character === "\n") {
        this.advance();
      } else if (character === "/" && this.peekChar(1) === "/") {
        while (this.offset < this.source.length && this.peekChar() !== "\n") this.advance();
      } else if (character === "/" && this.peekChar(1) === "*") {
        const start = this.here();
        const close = this.source.indexOf("*/", this.offset + 2);
        const stop = close === -1 ? this.source.length : close + 2;
        while (this.offset < stop) this.advance();
        if (close === -1) this.fail("unterminated comment: '/*' has no matching '*/'", start, start);
      } else {
        return;
      }
    }
  }

  // Tokens -----------------------------------------------------------------

  private token(): void {
    const start = this.here();
    const character = this.peekChar();
    if (/[A-Za-z_]/.test(character)) return this.word(start);
    if (/[0-9]/.test(character)) return this.number(start);
    if (character === '"') return this.push({ kind: "String", value: this.quoted(start), ...this.base(start) });
    if (character === "`") {
      this.advance();
      return this.templateText(start, start, true);
    }
    if (character === "@") return this.participant(start);
    if (character === "'") return this.typeVar(start);
    if (character === "}") {
      const brace = this.braces.pop();
      if (brace?.template) {
        this.advance();
        return this.templateText(start, brace.start, false);
      }
    }
    if (character === "{") this.braces.push({ template: false });
    for (const punctuator of PUNCTUATORS) {
      if (this.source.startsWith(punctuator, this.offset)) {
        this.skipAscii(punctuator.length);
        return this.push({ kind: punctuator, ...this.base(start) });
      }
    }
    const code = this.source.codePointAt(this.offset) ?? 0;
    this.advance();
    const shown = code > 0x20 && code < 0x7f ? `'${String.fromCodePoint(code)}'` : `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
    this.fail(`unexpected character ${shown}`, start);
  }

  /** Identifiers, keywords, `_`, and reference literals such as `doc"…"`. */
  private word(start: Pos): void {
    const text = this.match(IDENT)![0];
    this.skipAscii(text.length);
    const keyword = (KEYWORDS as readonly string[]).includes(text) ? (text as Keyword) : null;
    if (this.peekChar() === '"' && keyword === null && /^[a-z]/.test(text)) {
      if (!(REF_KINDS as readonly string[]).includes(text)) {
        this.fail(`unknown reference kind '${text}': a reference is doc"…" or channel"…"`, start);
      }
      const value = this.quoted(this.here());
      return this.push({ kind: "Ref", refKind: text as RefKind, value, ...this.base(start) });
    }
    if (text === "_") return this.push({ kind: "Underscore", ...this.base(start) });
    if (/^[A-Z]/.test(text)) return this.push({ kind: "UIdent", ...this.base(start) });
    this.push({ kind: keyword ?? "Ident", ...this.base(start) });
  }

  /** Integers, floats, durations (`30m`) and times (`2026-11-07T12:00Z`). */
  private number(start: Pos): void {
    if (this.match(DATE)) return this.time(start);
    this.skipAscii(this.match(DIGITS)![0].length);
    let isFloat = false;
    if (this.peekChar() === "." && /[0-9]/.test(this.peekChar(1))) {
      isFloat = true;
      this.skipAscii(1);
      this.skipAscii(this.match(DIGITS)![0].length);
    }
    const sign = this.peekChar(1) === "+" || this.peekChar(1) === "-" ? 1 : 0;
    if (/[eE]/.test(this.peekChar()) && /[0-9]/.test(this.peekChar(1 + sign))) {
      isFloat = true;
      this.skipAscii(1 + sign);
      this.skipAscii(this.match(DIGITS)![0].length);
    }
    const digits = this.source.slice(start.offset, this.offset);
    const suffix = this.match(IDENT)?.[0];
    if (suffix !== undefined) {
      this.skipAscii(suffix.length);
      const written = `${digits}${suffix}`;
      if (!DURATION_UNITS.includes(suffix)) {
        if (isFloat) this.fail(`unexpected '${suffix}' after the number ${digits}`, start);
        this.fail(`unknown duration unit '${suffix}' in '${written}': a duration is a whole number followed by m, h, d or w, as in 90m`, start);
      }
      if (isFloat) this.fail(`invalid duration '${written}': a duration is a whole number followed by m, h, d or w, as in 90m`, start);
      return this.push({ kind: "Duration", amount: canonicalDigits(digits), unit: suffix as DurationUnit, ...this.base(start) });
    }
    if (!isFloat) return this.push({ kind: "Int", value: canonicalDigits(digits), ...this.base(start) });
    const value = Number(digits);
    if (!Number.isFinite(value)) this.fail(`float literal ${digits} is out of range`, start);
    this.push({ kind: "Float", value, ...this.base(start) });
  }

  private time(start: Pos): void {
    const example = "as in 2026-11-07T12:00Z";
    const date = this.match(DATE)!;
    this.skipAscii(date[0].length);
    const timeOfDay = this.match(TIME_OF_DAY);
    if (timeOfDay === null) this.fail(`a time literal needs a time of day and an offset, ${example}`, start);
    this.skipAscii(timeOfDay[0].length);
    const offset = this.match(OFFSET);
    if (offset === null) this.fail(`a time literal needs an offset such as Z or +08:00, ${example}`, start);
    this.skipAscii(offset[0].length);
    if (/[A-Za-z0-9_]/.test(this.peekChar())) this.fail(`unexpected '${this.peekChar()}' after the time literal`, this.here(), this.here());

    const [year, month, day] = [date[1], date[2], date[3]].map(Number) as [number, number, number];
    const [hour, minute, second] = [timeOfDay[1], timeOfDay[2], timeOfDay[3] ?? "0"].map(Number) as [number, number, number];
    const offsetSign = offset[1] === "-" ? -1 : 1;
    const offsetHours = Number(offset[2] ?? "0");
    const offsetMinutes = Number(offset[3] ?? "0");
    const problem =
      month < 1 || month > 12 ? `month ${date[2]}`
      : day < 1 || day > daysInMonth(year, month) ? `day ${date[3]} for ${date[1]}-${date[2]}`
      : hour > 23 ? `hour ${timeOfDay[1]}`
      : minute > 59 ? `minute ${timeOfDay[2]}`
      : second > 59 ? `second ${timeOfDay[3]}`
      : offsetHours > 23 || offsetMinutes > 59 ? `offset ${offset[0]}`
      : null;
    if (problem !== null) this.fail(`invalid ${problem} in the time literal`, start);

    const instant = new Date(0);
    instant.setUTCFullYear(year, month - 1, day);
    instant.setUTCHours(hour, minute, second, 0);
    const offsetTotal = offsetSign * (offsetHours * 60 + offsetMinutes);
    this.push({
      kind: "Time",
      epochMs: instant.getTime() - offsetTotal * 60_000,
      offsetMinutes: offsetTotal,
      ...this.base(start),
    });
  }

  private participant(start: Pos): void {
    const found = this.match(PARTICIPANT);
    if (found === null) {
      this.advance();
      this.fail("expected a participant name after '@', as in @alice", start);
    }
    this.skipAscii(found[0].length);
    const instance = found[2] === undefined ? null : canonicalDigits(found[2]);
    this.push({ kind: "Participant", name: found[1]!, instance, ...this.base(start) });
  }

  private typeVar(start: Pos): void {
    const found = this.match(TYPE_VAR);
    if (found === null) {
      this.advance();
      this.fail("expected a type variable such as 'a after the quote; strings use double quotes", start);
    }
    this.skipAscii(found[0].length);
    this.push({ kind: "TypeVar", ...this.base(start) });
  }

  // Strings ----------------------------------------------------------------

  /** A `"…"` string starting at the current quote. Returns the decoded text. */
  private quoted(start: Pos): string {
    this.advance();
    let value = "";
    for (;;) {
      const character = this.peekChar();
      if (character === "" || character === "\n") {
        this.fail("unterminated string: a string ends on its own line; use \\n for a line break, or a template string", start, start);
      }
      if (character === '"') {
        this.advance();
        return value;
      }
      value += character === "\\" ? this.escape() : this.advance();
    }
  }

  /**
   * Template text from just after `` ` `` or the `}` that closes an
   * interpolation, up to the next `${` or the closing `` ` ``.
   */
  private templateText(start: Pos, templateStart: Pos, isHead: boolean): void {
    let value = "";
    for (;;) {
      const character = this.peekChar();
      if (character === "") this.fail("unterminated template string", templateStart, templateStart);
      if (character === "`") {
        this.advance();
        return this.push({ kind: isHead ? "TemplateFull" : "TemplateTail", value, ...this.base(start) });
      }
      if (character === "$" && this.peekChar(1) === "{") {
        this.skipAscii(2);
        this.braces.push({ template: true, start: templateStart });
        return this.push({ kind: isHead ? "TemplateHead" : "TemplateMiddle", value, ...this.base(start) });
      }
      if (character === "\r" && this.peekChar(1) === "\n") {
        this.advance();
        continue;
      }
      value += character === "\\" ? this.escape() : this.advance();
    }
  }

  /** The escape at the current backslash, decoded. A bad escape is reported, and the string goes on. */
  private escape(): string {
    const start = this.here();
    this.advance();
    const character = this.advance();
    const simple: { [key: string]: string } = { n: "\n", r: "\r", t: "\t", "\\": "\\", '"': '"', "'": "'", "`": "`", $: "$" };
    const decoded = simple[character];
    if (decoded !== undefined) return decoded;
    if (character === "u") {
      const braced = this.peekChar() === "{";
      const digits = braced ? /\{([0-9A-Fa-f]{1,6})\}/y : /([0-9A-Fa-f]{4})/y;
      const found = this.match(digits);
      const code = found === null ? NaN : parseInt(found[1]!, 16);
      if (found === null || code > 0x10ffff || (braced && code >= 0xd800 && code <= 0xdfff)) {
        this.report("invalid unicode escape: use \\uXXXX or \\u{X…} with a code point up to 10FFFF", start, this.here());
        return "";
      }
      this.skipAscii(found[0].length);
      return String.fromCodePoint(code);
    }
    const shown = character === "\n" ? "a line break" : `'${character}'`;
    this.report(`unknown escape sequence: '\\' followed by ${shown}; the escapes are \\n \\r \\t \\\\ \\" \\' \\\` \\$ and \\u`, start, this.here());
    return "";
  }
}

function canonicalDigits(digits: string): string {
  return digits.replace(/^0+(?=[0-9])/, "");
}

function daysInMonth(year: number, month: number): number {
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
