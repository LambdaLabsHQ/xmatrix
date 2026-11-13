// Vendored from norn-lang/norn@1dd36e4e31d002a62e9a61864a9d9d4b9695b16c; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * The Norn type checker (docs/types.md).
 *
 * ```ts
 * const host = loadInterface(hostProgram, "hosts/reference.norn");
 * const std = loadLibrary(stdProgram, "std/std.norn", host);
 * const result = checkProgram(program, { host, std });
 * ```
 *
 * `readInterface`, `readLibrary` and `checkSource` do the same from source
 * text. Nothing this module exports reads a file or needs Node, so it runs in
 * a browser. `node.ts` reads the reference host and the standard library from
 * this repository's files.
 */
export { FAMILIES, type Family } from "./builtins.js";
export { CODES, type CheckDiagnostic, type Code, type Severity } from "./diagnostics.js";
export type { EffectSummary } from "./effects.js";
export { elaborate } from "./elaborate.js";
export type { Form, FormDefinition, ReportForm } from "./forms.js";
export { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library } from "./infer.js";
export { builtinInterface, hostSources, loadInterface, type HostInterface, type ValueBinding } from "./interface.js";
export { checkSource, readInterface, readLibrary, type SourceCheck } from "./source.js";
