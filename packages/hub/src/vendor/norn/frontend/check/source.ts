// Vendored from norn-lang/norn@da755aeefe40f233998eb2b6fedeb59de752cb58; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Checking from source text: host interfaces, the standard library and
 * programs. Nothing here reads a file, so a browser can run it on text it
 * bundles; `node.ts` reads this repository's reference host and standard
 * library from their files, for the CLI and the tests.
 */
import type * as A from "../ast.js";
import { STACK_EXHAUSTED } from "../diagnostics.js";
import { parse } from "../parser.js";
import type { CheckDiagnostic } from "./diagnostics.js";
import { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library } from "./infer.js";
import { builtinInterface, loadInterface, type HostInterface } from "./interface.js";

/** A host interface from source text. A syntax error makes an interface of the built-ins alone, with the error. */
export function readInterface(source: string, file: string): HostInterface {
  const parsed = parse(source);
  if (!parsed.ok) return { ...builtinInterface(), file, diagnostics: parsed.diagnostics.map(syntax), ok: false };
  return loadInterface(parsed.program, file);
}

/** The standard library from source text, checked against a host. */
export function readLibrary(source: string, file: string, host: HostInterface): Library {
  const parsed = parse(source);
  if (!parsed.ok) {
    const program: A.Program = { kind: "Program", body: [], span: { start: { line: 1, column: 1, offset: 0 }, end: { line: 1, column: 1, offset: 0 } } };
    return { file, program, exports: [], types: [], resolutions: new Map(), diagnostics: parsed.diagnostics.map(syntax), ok: false };
  }
  return loadLibrary(parsed.program, file, host);
}

export interface SourceCheck extends CheckResult {
  /** The tree, when the source parses. */
  program: A.Program | null;
}

/** Parses a program's source and checks it against a host interface and, for `open Std`, a standard library. */
export function checkSource(source: string, options: CheckOptions): SourceCheck {
  const parsed = parse(source);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics.map(syntax), bindings: [], effects: null, reports: [], program: null };
  return { ...checkProgram(parsed.program, options), program: parsed.program };
}

/** A syntax error as a checker diagnostic; running out of stack while parsing is `too-deep`, as while checking. */
export function syntax(diagnostic: { message: string; span: A.Span }): CheckDiagnostic {
  return { severity: "error", code: diagnostic.message === STACK_EXHAUSTED ? "too-deep" : "syntax", message: diagnostic.message, span: diagnostic.span };
}
