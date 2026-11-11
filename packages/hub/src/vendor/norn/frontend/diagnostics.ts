// Vendored from norn-lang/norn@9333fe512bf5af158f5f0695e27fbeb27218243b; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
import type { Span } from "./ast.js";

/** What a program that nests deeper than the stack allows is told: the platform's real limit, not a fixed bound. */
export const STACK_EXHAUSTED = "the program nests deeper than this implementation's stack can follow";

/** Whether an error is the JavaScript engine running out of stack. */
export function isStackExhausted(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

/** A syntax error with the source range it is about. The type checker's diagnostics add a severity, a code and more. */
export interface Diagnostic {
  message: string;
  span: Span;
  /** "error" when absent: a syntax error is always one. */
  severity?: "error" | "warning";
}

/** `message at file:line:column` */
export function diagnosticLine(diagnostic: Diagnostic, file: string): string {
  const { line, column } = diagnostic.span.start;
  return `${diagnostic.message} at ${file}:${line}:${column}`;
}

/**
 * The one-line form after its severity, then the source line with a caret
 * under the range:
 *
 *     error: expected '=>' after pattern, found 'run' at examples/decide.norn:4:13
 *      4 | | Done(Drop) run(@auto, "Record the decision")
 *        |             ^^^
 */
export function formatDiagnostic(diagnostic: Diagnostic, source: string, file: string): string {
  const { start, end } = diagnostic.span;
  const text = (source.split("\n")[start.line - 1] ?? "").replace(/\r$/, "");
  const characters = [...text];
  const indent = characters
    .slice(0, start.column - 1)
    .map((character) => (character === "\t" ? "\t" : " "))
    .join("");
  const lastColumn = end.line === start.line ? end.column : characters.length + 1;
  const carets = "^".repeat(Math.max(1, lastColumn - start.column));
  const gutter = " ".repeat(String(start.line).length);
  return [
    `${diagnostic.severity ?? "error"}: ${diagnosticLine(diagnostic, file)}`,
    ` ${start.line} | ${text}`,
    ` ${gutter} | ${indent}${carets}`,
  ].join("\n");
}
