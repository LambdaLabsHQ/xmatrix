// Vendored from norn-lang/norn@879866cb314729dd7e6be1621ac64fc433c3309e; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
/**
 * Derived library interfaces, Elm-style compatibility diffs, content-hash
 * pinning, and three-way upgrade diffing (interface + ledger preview +
 * audience/effect-lock). Browser-safe: uses portable sha256 and no Node APIs.
 */
import { astToJson } from "../json.js";
import type * as A from "../ast.js";
import { sha256 } from "../../runtime/sha256.js";
import { compile, type Sources } from "../../runtime/code.js";
import { previewEdit, type EditPreview, type Ledger } from "../../runtime/ledger.js";
import { elaborate } from "./elaborate.js";
import { checkProgram, type Library } from "./infer.js";
import { hostSources, type HostInterface } from "./interface.js";
import { printScheme, printType } from "./types.js";

export interface DerivedValueExport {
  name: string;
  type: string;
  hash: string;
}

export interface DerivedTypeExport {
  name: string;
  params: string[];
  kind: string;
  opaque: boolean;
  fields?: { name: string; type: string }[];
  constructors?: { name: string; args: string[] }[];
  doc?: string;
}

export interface DerivedInterface {
  name: string;
  needs: string[];
  types: DerivedTypeExport[];
  values: DerivedValueExport[];
  effects: { family: string; targets: string[] }[];
  /** SHA-256 of the library's canonical AST JSON. */
  hash: string;
}

/** Derives the canonical interface of a checked library in source order. */
export function deriveInterface(lib: Library): DerivedInterface {
  const name = lib.name ?? lib.file;
  const types: DerivedTypeExport[] = lib.types.map((info) => ({
    name: info.name,
    params: [...info.params],
    kind: info.opaque ? "opaque" : info.kind,
    opaque: Boolean(info.opaque),
    ...(!info.opaque && info.kind === "record"
      ? { fields: info.fields.map((f) => ({ name: f.name, type: printType(f.type) })) }
      : {}),
    ...(!info.opaque && info.kind === "variant"
      ? { constructors: info.constructors.map((c) => ({ name: c.name, args: c.args.map((a) => printType(a)) })) }
      : {}),
    ...(info.doc ? { doc: info.doc } : {}),
  }));
  const values: DerivedValueExport[] = lib.exports.map((binding) => {
    const nodeJson = binding.node ? JSON.stringify(binding.node, (k, v) => (k === "span" ? undefined : v)) : binding.name;
    return {
      name: binding.name,
      type: printScheme(binding.type),
      hash: `sha256:${sha256(`${binding.name}:${printScheme(binding.type)}:${nodeJson}`).slice(0, 16)}`,
    };
  });
  const effects = (lib.effects ?? []).map((e) => ({ family: e.family, targets: [...e.targets] }));
  const astHash = `sha256:${sha256(astToJson(lib.program))}`;
  return {
    name,
    needs: [...(lib.needs ?? [])],
    types,
    values,
    effects,
    hash: astHash,
  };
}

export type InterfaceChangeKind = "NONE" | "MINOR" | "MAJOR";

export interface InterfaceDiff {
  library: string;
  change: InterfaceChangeKind;
  addedValues: DerivedValueExport[];
  removedValues: DerivedValueExport[];
  changedValues: { name: string; before: string; after: string }[];
  addedTypes: DerivedTypeExport[];
  removedTypes: DerivedTypeExport[];
  changedTypes: { name: string; before: DerivedTypeExport; after: DerivedTypeExport }[];
  addedNeeds: string[];
  removedNeeds: string[];
  /** True when any implementation hash changed even if public signatures stayed identical. */
  definitionChanged: boolean;
}

/** Computes an Elm-style NONE / MINOR / MAJOR compatibility diff between two library interfaces. */
export function diffInterfaces(before: DerivedInterface, after: DerivedInterface): InterfaceDiff {
  const beforeValues = new Map(before.values.map((v) => [v.name, v]));
  const afterValues = new Map(after.values.map((v) => [v.name, v]));
  const addedValues = after.values.filter((v) => !beforeValues.has(v.name));
  const removedValues = before.values.filter((v) => !afterValues.has(v.name));
  const changedValues: { name: string; before: string; after: string }[] = [];
  let definitionChanged = before.hash !== after.hash;
  for (const [name, afterVal] of afterValues) {
    const prev = beforeValues.get(name);
    if (!prev) continue;
    if (prev.type !== afterVal.type) changedValues.push({ name, before: prev.type, after: afterVal.type });
    if (prev.hash !== afterVal.hash) definitionChanged = true;
  }

  const beforeTypes = new Map(before.types.map((t) => [t.name, t]));
  const afterTypes = new Map(after.types.map((t) => [t.name, t]));
  const addedTypes = after.types.filter((t) => !beforeTypes.has(t.name));
  const removedTypes = before.types.filter((t) => !afterTypes.has(t.name));
  const changedTypes: { name: string; before: DerivedTypeExport; after: DerivedTypeExport }[] = [];
  for (const [name, afterType] of afterTypes) {
    const prev = beforeTypes.get(name);
    if (!prev) continue;
    const fieldsChanged = JSON.stringify(prev.fields ?? []) !== JSON.stringify(afterType.fields ?? []);
    const ctorsChanged = JSON.stringify(prev.constructors ?? []) !== JSON.stringify(afterType.constructors ?? []);
    if (prev.kind !== afterType.kind || prev.opaque !== afterType.opaque || prev.params.join(",") !== afterType.params.join(",") || fieldsChanged || ctorsChanged) {
      changedTypes.push({ name, before: prev, after: afterType });
    }
  }

  const addedNeeds = after.needs.filter((n) => !before.needs.includes(n));
  const removedNeeds = before.needs.filter((n) => !after.needs.includes(n));

  let change: InterfaceChangeKind = "NONE";
  if (removedValues.length || changedValues.length || removedTypes.length || changedTypes.length || addedNeeds.length) {
    change = "MAJOR";
  } else if (addedValues.length || addedTypes.length || removedNeeds.length) {
    change = "MINOR";
  }

  return {
    library: after.name,
    change,
    addedValues,
    removedValues,
    changedValues,
    addedTypes,
    removedTypes,
    changedTypes,
    addedNeeds,
    removedNeeds,
    definitionChanged,
  };
}

/** Content-hash pin recorded with a running program for every library and `needs` binding it touches. */
export interface ProgramPin {
  programHash: string;
  libraries: Record<string, { hash: string; definitions: Record<string, string>; needs: string[] }>;
}

/** Pins the exact AST & definition hashes of every library available to a program. */
export function pinProgramDefinitions(program: A.Program, libraries: Readonly<Record<string, Library>>): ProgramPin {
  const pinned: ProgramPin["libraries"] = {};
  for (const [name, lib] of Object.entries(libraries).sort(([a], [b]) => a.localeCompare(b))) {
    const iface = deriveInterface(lib);
    const definitions: Record<string, string> = {};
    for (const v of iface.values) definitions[v.name] = v.hash;
    pinned[name] = { hash: iface.hash, definitions, needs: iface.needs };
  }
  return {
    programHash: `sha256:${sha256(astToJson(program))}`,
    libraries: pinned,
  };
}

export interface EffectLockDiff {
  addedFamilies: string[];
  removedFamilies: string[];
  addedTargets: { family: string; target: string }[];
  removedTargets: { family: string; target: string }[];
  empty: boolean;
}

export function diffEffectLocks(
  before: readonly { family: string; targets: readonly string[] }[],
  after: readonly { family: string; targets: readonly string[] }[],
): EffectLockDiff {
  const bMap = new Map(before.map((e) => [e.family, new Set(e.targets)]));
  const aMap = new Map(after.map((e) => [e.family, new Set(e.targets)]));
  const addedFamilies = [...aMap.keys()].filter((f) => !bMap.has(f)).sort();
  const removedFamilies = [...bMap.keys()].filter((f) => !aMap.has(f)).sort();
  const addedTargets: { family: string; target: string }[] = [];
  const removedTargets: { family: string; target: string }[] = [];
  for (const [family, targets] of aMap) {
    const prev = bMap.get(family) ?? new Set<string>();
    for (const target of targets) if (!prev.has(target)) addedTargets.push({ family, target });
  }
  for (const [family, targets] of bMap) {
    const next = aMap.get(family) ?? new Set<string>();
    for (const target of targets) if (!next.has(target)) removedTargets.push({ family, target });
  }
  const empty = addedFamilies.length === 0 && removedFamilies.length === 0 && addedTargets.length === 0 && removedTargets.length === 0;
  return { addedFamilies, removedFamilies, addedTargets, removedTargets, empty };
}

export interface UpgradeDiff {
  /** Interface diffs for every library whose version changed. */
  interfaces: InterfaceDiff[];
  /** Two-text ledger preview diff (null if either version fails type-checking). */
  ledger: EditPreview | null;
  /** Audience and effect-lock diff. */
  effects: EffectLockDiff;
  /** True if any library definition hash changed. */
  definitionChanged: boolean;
  /**
   * Per design review: even when all three diffs are empty (e.g. a pure filter
   * predicate changed condition), any definition hash change defaults to
   * remaining pinned and requires explicit adoption by the program author.
   */
  requiresExplicitAdoption: boolean;
  beforeOk: boolean;
  afterOk: boolean;
}

export function diffProgramUpgrade(input: {
  beforeProgram: A.Program;
  afterProgram: A.Program;
  host: HostInterface;
  std: Library | null;
  beforeLibraries: Readonly<Record<string, Library>>;
  afterLibraries: Readonly<Record<string, Library>>;
  ledger: Ledger;
  now: number;
  sources?: Sources;
}): UpgradeDiff {
  const names = [...new Set([...Object.keys(input.beforeLibraries), ...Object.keys(input.afterLibraries)])].sort();
  const interfaces: InterfaceDiff[] = [];
  let definitionChanged = false;
  for (const name of names) {
    const bLib = input.beforeLibraries[name];
    const aLib = input.afterLibraries[name];
    if (bLib && aLib) {
      const diff = diffInterfaces(deriveInterface(bLib), deriveInterface(aLib));
      interfaces.push(diff);
      if (diff.definitionChanged) definitionChanged = true;
    } else {
      definitionChanged = true;
    }
  }
  const beforeChecked = checkProgram(input.beforeProgram, { host: input.host, std: input.std, libraries: input.beforeLibraries });
  const afterChecked = checkProgram(input.afterProgram, { host: input.host, std: input.std, libraries: input.afterLibraries });
  const effects = diffEffectLocks(beforeChecked.effects ?? [], afterChecked.effects ?? []);
  let ledgerDiff: EditPreview | null = null;
  if (beforeChecked.ok && afterChecked.ok) {
    const sources = input.sources ?? hostSources(input.host);
    const toLibPrograms = (libs: Readonly<Record<string, Library>>) =>
      Object.fromEntries(Object.entries(libs).map(([k, v]) => [k, v.program]));
    const beforeCode = compile(elaborate(input.beforeProgram, beforeChecked.reports), {
      std: input.std?.program,
      libraries: toLibPrograms(input.beforeLibraries),
      sources,
    });
    const afterCode = compile(elaborate(input.afterProgram, afterChecked.reports), {
      std: input.std?.program,
      libraries: toLibPrograms(input.afterLibraries),
      sources,
    });
    ledgerDiff = previewEdit(beforeCode, afterCode, input.ledger, input.now);
  }
  return {
    interfaces,
    ledger: ledgerDiff,
    effects,
    definitionChanged,
    requiresExplicitAdoption: definitionChanged || !effects.empty || Boolean(ledgerDiff && !ledgerDiff.empty),
    beforeOk: beforeChecked.ok,
    afterOk: afterChecked.ok,
  };
}

/** Formats a type cleanly for interface display. */
export function formatInterfaceSummary(iface: DerivedInterface): string {
  const lines: string[] = [`library ${iface.name} (${iface.hash.slice(0, 19)})`];
  for (const n of iface.needs) lines.push(`  needs ${n}`);
  for (const t of iface.types) {
    const params = t.params.length ? `<${t.params.map((p) => `'${p}`).join(", ")}>` : "";
    lines.push(`  ${t.opaque ? "pub opaque type" : "pub type"} ${t.name}${params}`);
  }
  for (const v of iface.values) lines.push(`  pub ${v.name}: ${v.type}`);
  if (iface.effects.length) {
    lines.push(`  effects: ${iface.effects.map((e) => e.targets.length ? `${e.family}(${e.targets.join(", ")})` : e.family).join(", ")}`);
  }
  return lines.join("\n");
}
export { printType };
