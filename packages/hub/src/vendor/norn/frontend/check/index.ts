// Vendored from norn-lang/norn@860952750284caf8a6cb37a62ac435791ca91911; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
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
export { FAMILIES, builtinModuleExports, type Family } from "./builtins.js";
export { CODES, type CheckDiagnostic, type Code, type DiagnosticFix, type DiagnosticSecondary, type Severity } from "./diagnostics.js";
export type { EffectSummary } from "./effects.js";
export { elaborate, type FormEvidencePlan } from "./elaborate.js";
export {
  ACTIONS_INTERFACE_SOURCE, EVENTS_INTERFACE_SOURCE, manifestActionForm, manifestEventForm, validateActionAgainstManifests,
  validateEventKindAgainstManifests,
  type ConnectorActionSpec, type ConnectorEventSpec, type ConnectorFieldSpec, type ConnectorManifest,
} from "./events.js";
export type { Form, FormDefinition, FormRefusal, ReportForm } from "./forms.js";
export { checkProgram, loadLibrary, type CheckOptions, type CheckResult, type Library, type LoadLibraryOptions } from "./infer.js";
export { builtinInterface, hostSources, loadInterface, type HostInterface, type ValueBinding } from "./interface.js";
export {
  deriveInterface, diffEffectLocks, diffInterfaces, diffProgramUpgrade, formatInterfaceSummary, pinProgramDefinitions,
  type DerivedInterface, type DerivedTypeExport, type DerivedValueExport, type EffectLockDiff, type InterfaceChangeKind, type InterfaceDiff, type ProgramPin, type UpgradeDiff,
} from "./modules.js";
export { checkSource, readInterface, readLibrary, type SourceCheck } from "./source.js";
