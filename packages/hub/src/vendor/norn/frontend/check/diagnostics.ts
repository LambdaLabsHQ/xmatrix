// Vendored from norn-lang/norn@1dd36e4e31d002a62e9a61864a9d9d4b9695b16c; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * What the checker reports. A diagnostic reads like a parse error: a message
 * that says what was expected and what was found, and a span. In JSON it also
 * has a stable `code`, and `expected`, `found` or `missing` where they apply
 * (docs/types.md §9).
 */
import type { Span } from "../ast.js";

export type Severity = "error" | "warning";

export interface CheckDiagnostic {
  severity: Severity;
  /** Stable: a skill or a document can explain it. CODES lists them all. */
  code: Code;
  message: string;
  span: Span;
  /** When two types disagree: what the context needs, as a type or a class of types. */
  expected?: string;
  /** When two types disagree: what the program has. */
  found?: string;
  /** When cases are not covered: example patterns that no case matches. */
  missing?: string[];
}

/** Every diagnostic code, with what it means. docs/types.md §9 lists the same. */
export const CODES = {
  "syntax": "the source does not parse",
  "type-mismatch": "a value's type is not the one its context needs",
  "infinite-type": "a type would have to contain itself",
  "not-ordered": "<, <=, > or >= on a type that has no order",
  "not-comparable": "== or != on a type with a function inside",
  "not-a-deadline": "a deadline that is neither a time nor a duration",
  "not-an-addressee": "say to something that is neither a participant nor a ref",
  "not-handled": "a forEach handler that returns neither () nor a reply",
  "class-conflict": "one value would need two classes that no type has together",
  "unknown-name": "a name that nothing binds",
  "unknown-constructor": "a constructor that no type declares",
  "unknown-type": "a type name that nothing declares",
  "unknown-type-variable": "a type variable that the declaration does not list",
  "unknown-field": "a field that the record type does not have, or that no record type has",
  "unknown-label": "a labelled argument that the function does not take",
  "missing-field": "a record literal without a field of its type",
  "missing-label": "a call without a labelled argument that the function requires",
  "argument-count": "a call with more or fewer positional arguments than the function takes",
  "constructor-arity": "a constructor with more or fewer arguments than it takes",
  "type-arity": "a type name with more or fewer type arguments than it takes",
  "not-a-function": "a call of a value that is not a function",
  "duplicate-binding": "a name bound twice in one pattern or parameter list",
  "duplicate-label": "a label given twice",
  "duplicate-field": "a field given or declared twice",
  "duplicate-type": "a type name declared twice, or one that is built in",
  "duplicate-constructor": "a constructor name declared twice; constructors are global",
  "duplicate-external": "an external declared twice, or one that redeclares a built-in",
  "duplicate-type-parameter": "a type parameter listed twice",
  "cyclic-type": "a type alias that refers to itself",
  "or-pattern-bindings": "alternatives of a pattern that bind different names",
  "later-parameter": "a default value that uses a labelled parameter declared after it",
  "choose-options": "options of choose that are not constructors of one variant type",
  "same-request": "two requests that ask the same participant for the same thing, with nothing to tell them apart",
  "report-form": "a run whose report would hold a function, a request, a fact, a stream or a reply",
  "try-operand": "? on a value that is not a reply, option or result",
  "try-return": "? in a function that returns another family than the value under ?",
  "non-exhaustive": "a switch that does not handle every case",
  "refutable-pattern": "a let or parameter pattern that does not match every value",
  "unreachable-case": "a case that can never match, because earlier cases cover it",
  "dropped-request": "a request used as a statement before the last, bound to _, given to ignore or to a generic function that drops it, or left as the program's last expression",
  "unused-request": "a let that binds a request to a name that is never used",
  "dropped-reply": "a reply used as a statement before the last, bound to _, or given to a generic function that drops it",
  "unused-reply": "a let that binds a reply to a name that is never used",
  "interface-only": "an external or an abstract type in a program",
  "interface-item": "something other than a type or an external in a host interface file",
  "no-std": "open Std without the standard library",
  "std-error": "a standard library that does not type-check with this host",
  "too-deep": "a program that nests deeper than the checker's stack can follow",
} as const;

export type Code = keyof typeof CODES;

/** Diagnostics in source order; diagnostics at one place keep the order they were found in. */
export function sortDiagnostics(diagnostics: readonly CheckDiagnostic[]): CheckDiagnostic[] {
  return diagnostics
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((a, b) => a.diagnostic.span.start.offset - b.diagnostic.span.start.offset || a.index - b.index)
    .map(({ diagnostic }) => diagnostic);
}

/** "a, b or c" */
export function either(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`;
}

/** "a, b and c" */
export function both(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "first", "second", … "tenth", then "11th". */
export function ordinal(index: number): string {
  const words = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
  const n = index + 1;
  if (index < words.length) return words[index]!;
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** "1 argument", "2 arguments" */
export function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The closest of some names to a misspelt one, if it is close enough to be a likely typo. */
export function closest(name: string, candidates: Iterable<string>): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const distance = editDistance(name.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance || (distance === bestDistance && best !== null && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  // A typo changes a small part of a name: at most one edit in three characters.
  return best !== null && bestDistance * 3 <= Math.max(name.length, best.length) ? best : null;
}

/** Edits between two names, where swapping two neighbouring letters is one edit, as in `wiat` for `wait`. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}
