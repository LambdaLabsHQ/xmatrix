import { APP_CONNECTOR_PROVIDER_MANIFESTS, isSupportedNornEdition, nornFactsBlock, nornLibBlock, nornRunBlock, parseHarnessCapabilityMentions, parseMarkdown, requestReferenceToken,
  utf8ByteLength } from "@xmatrix/protocol";
import { NORN_HANDED_ON_REASON, type NornProgramState, type NornProgramWrite, type NornStep } from "@xmatrix/db";
import {
  checkSource, diffProgramUpgrade, elaborate, hostSources, manifestEventForm, pinProgramDefinitions, readInterface, readLibrary,
  type Form, type Library, type ProgramPin, type ReportForm, type UpgradeDiff,
} from "./vendor/norn/frontend/check/index";
import { NORN_STD, NORN_STD_LEGACY_V1 } from "./vendor/norn/std";
import { parse } from "./vendor/norn/frontend/parser";
import { compile, type Code } from "./vendor/norn/runtime/code";
import { checkFacts } from "./vendor/norn/runtime/facts";
import {
  delegate, deliverEvent, emptyLedger, evaluate, hold, holdKind, holdKindKey, migrateLedger, occur, preparedAction, previewEdit, reclaim, settle, stop, take, verifyMigration,
  type CloudEventInput, type Delegation, type EditPreview, type Ledger, type LedgerRequest, type MigrationReport, type MigrationResult,
  type MigrationStep, type Pass, type PassOptions, type Reply,
} from "./vendor/norn/runtime/ledger";
import { eventKey, number, show, text, unit, type Value } from "./vendor/norn/runtime/value";
import {
  BUILTIN_NORN_LIBRARY_SOURCES, loadBuiltinNornLibraries, nornActionStatement, nornConnectorActionSpecs, NORN_CONNECTOR_EVENT_MANIFESTS,
} from "./norn-libraries";
import { nornBranchConversationId, type NornBranchChannel } from "./norn-branches";

/**
 * The xMatrix host of Norn (docs/architecture/norn-host.md): what a program
 * in a message is, how one pass over its ledger goes, and what a request
 * looks like to the Agent that holds it. Nothing here reads or writes: the
 * database layer runs `nornStep` while it holds the program's row.
 */

/** A `norn run` (or `norn <edition> run`) block of a text, and why it does not run when it cannot. */
export interface NornBlock { name: string; source: string; edition?: string; problem?: string }
/** A `norn 1 lib <Name>` Space library block on a Page. */
export interface NornLibBlock { name: string; source: string; edition?: string; problem?: string }
/** A `norn 1 facts <Type>` fact block on a Page. */
export interface NornFactBlock { typeName: string; source: string; edition?: string; problem?: string }

/** Extracts top-level `norn 1 lib <Name>` library blocks from Markdown text. */
export function nornLibBlocks(body: string): NornLibBlock[] {
  const root = parseMarkdown(body) as { children?: { type?: string; lang?: string | null; meta?: string | null; value?: string }[] };
  const blocks = (root.children ?? []).flatMap(node => {
    const block = node.type === "code" ? nornLibBlock([node.lang, node.meta].filter(Boolean).join(" ")) : null;
    return block ? [{ ...block, source: node.value ?? "" }] : [];
  });
  return blocks.map(block => block.problem || blocks.filter(other => other.name === block.name).length < 2 ? block
    : { ...block, problem: `Two library blocks are named ${block.name}; rename one.` });
}

/** Extracts top-level `norn 1 facts <Type>` fact blocks from Markdown text. */
export function nornFactBlocks(body: string): NornFactBlock[] {
  const root = parseMarkdown(body) as { children?: { type?: string; lang?: string | null; meta?: string | null; value?: string }[] };
  const blocks = (root.children ?? []).flatMap(node => {
    const block = node.type === "code" ? nornFactsBlock([node.lang, node.meta].filter(Boolean).join(" ")) : null;
    return block ? [{ ...block, source: node.value ?? "" }] : [];
  });
  return blocks.map(block => block.problem || blocks.filter(other => other.typeName === block.typeName).length < 2 ? block
    : { ...block, problem: `Two fact blocks declare ${block.typeName} on this page; keep only one.` });
}

/** Stable fingerprint of a Page's `norn 1 facts` blocks: prose-only edits produce the exact same key. */
export const pageFactsKey = (body: string): string => JSON.stringify(
  nornFactBlocks(body).map(b => [b.typeName, b.edition ?? "", b.source, b.problem ?? ""]),
);

/** Checks one `norn 1 facts <Type>` block against the Space's libraries and returns its Norn value or refusal. */
export function checkPageFactBlock(
  block: NornFactBlock,
  spaceCatalog?: SpaceLibraryCatalog,
): { ok: true; value: Value } | { ok: false; problem: string } {
  if (block.problem) return { ok: false, problem: block.problem };
  const seedNames = referencedLibraryNames(`let _fact: ${block.typeName} = (\n${block.source}\n)\n`);
  const dot = block.typeName.indexOf(".");
  if (dot > 0) seedNames.add(block.typeName.slice(0, dot));
  const loaded = loadProgramLibraries(spaceCatalog?.libraries, undefined, {
    seedNames,
    libraryProblems: spaceCatalog?.problems,
  });
  if (loaded.refusal) return { ok: false, problem: loaded.refusal };
  const checked = checkFacts(block.source, block.typeName, { host: HOST, std: STD, libraries: loaded.libraries });
  if (!checked.ok) {
    return { ok: false, problem: checked.diagnostics.map(d => d.message).join("\n") };
  }
  return { ok: true, value: checked.value };
}

/** Map of valid Space library sources defined on a Page body. */
export function pageSpaceLibraries(body: string): Record<string, string> {
  const libs: Record<string, string> = {};
  for (const block of nornLibBlocks(body)) {
    if (!block.problem && block.name) libs[block.name] = block.source;
  }
  return libs;
}

/** Reserved module names provided by the language or host that Space libraries cannot shadow. */
export const RESERVED_NORN_LIBRARY_NAMES: ReadonlySet<string> = new Set([
  "Std", "Events", "Actions", "Holds", "Admission", ...Object.keys(BUILTIN_NORN_LIBRARY_SOURCES),
]);

/** Resolved Space-wide library catalog across all readable Pages in a Space. */
export interface SpaceLibraryCatalog {
  libraries: Record<string, string>;
  problems: Record<string, string>;
}

/**
 * Collects top-level `norn 1 lib <Name>` blocks across a Space's readable Pages.
 * Optional `override` substitutes an unsaved or newly edited Page body in place
 * of its stored revision. Cross-page name collisions and built-in module
 * shadowing are recorded in `problems` and omitted from `libraries`.
 */
export function collectSpaceLibraries(
  pages: ReadonlyArray<{ pageId: string; title?: string; body: string }>,
  override?: { pageId: string; body: string },
): SpaceLibraryCatalog {
  const effective = override
    ? [
      ...pages.map(page => page.pageId === override.pageId ? { ...page, body: override.body } : page),
      ...(pages.some(page => page.pageId === override.pageId) ? [] : [{ pageId: override.pageId, body: override.body }]),
    ]
    : [...pages];
  const libraries: Record<string, string> = {};
  const problems: Record<string, string> = {};
  const owners = new Map<string, string[]>();
  for (const page of effective) {
    for (const block of nornLibBlocks(page.body)) {
      if (!block.name) continue;
      if (block.problem) {
        problems[block.name] ??= block.problem;
        continue;
      }
      if (RESERVED_NORN_LIBRARY_NAMES.has(block.name)) {
        problems[block.name] = `Library ${block.name} conflicts with built-in module ${block.name}; rename it.`;
        continue;
      }
      const list = owners.get(block.name) ?? [];
      list.push(page.pageId);
      owners.set(block.name, list);
      if (list.length === 1) {
        libraries[block.name] = block.source;
      } else {
        delete libraries[block.name];
        problems[block.name] = `Library ${block.name} is defined on multiple pages (${list.map(id => `page:${id}`).join(", ")}); rename or remove one.`;
      }
    }
  }
  return { libraries, problems };
}

/** Walks a parsed Norn AST node to collect every module name referenced by `open`, `needs`, qualified values, or qualified types/constructors. */
function collectAstModuleRefs(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectAstModuleRefs(item, out);
    return;
  }
  const rec = node as Record<string, unknown>;
  const kind = rec.kind;
  if ((kind === "Open" || kind === "Needs" || kind === "QualifiedIdentifier") && typeof rec.module === "string") {
    out.add(rec.module);
  }
  if ((kind === "TypeName" || kind === "Constructor" || kind === "ConstructorPattern")
    && typeof rec.name === "string" && rec.name.includes(".")) {
    out.add(rec.name.slice(0, rec.name.indexOf(".")));
  }
  for (const [key, value] of Object.entries(rec)) {
    if (key === "span") continue;
    collectAstModuleRefs(value, out);
  }
}

/** Module names directly referenced by a Norn program or library source. */
export function referencedLibraryNames(source: string): Set<string> {
  const out = new Set<string>();
  const parsed = parse(source);
  if (parsed.ok) collectAstModuleRefs(parsed.program, out);
  return out;
}

/**
 * Resolves the transitive Space library dependencies of `source` in topological
 * dependency order. Unreferenced libraries in `catalog` (including broken draft
 * libraries on unrelated pages) are skipped so they never break other programs.
 */
export function resolveProgramLibraries(
  source: string,
  catalog: Readonly<Record<string, string>>,
  problems?: Readonly<Record<string, string>>,
  seedNames?: Iterable<string>,
): { libraries: Record<string, string>; order: string[] } | { refusal: string } {
  const roots = seedNames ? [...seedNames] : [...referencedLibraryNames(source)];
  const visited = new Set<string>();
  const visiting: string[] = [];
  const order: string[] = [];

  const visit = (name: string): string | undefined => {
    if (problems?.[name]) return problems[name];
    if (!(name in catalog)) return undefined;
    if (visited.has(name)) return undefined;
    const cycleAt = visiting.indexOf(name);
    if (cycleAt !== -1) {
      return `Circular library dependency: ${[...visiting.slice(cycleAt), name].join(" -> ")}`;
    }
    visiting.push(name);
    for (const dep of referencedLibraryNames(catalog[name]!)) {
      if (dep === name) continue;
      const err = visit(dep);
      if (err) return err;
    }
    visiting.pop();
    visited.add(name);
    order.push(name);
    return undefined;
  };

  for (const root of roots) {
    const err = visit(root);
    if (err) return { refusal: err };
  }
  const libraries: Record<string, string> = {};
  for (const name of order) libraries[name] = catalog[name]!;
  return { libraries, order };
}

/** Returns only the transitive Space libraries from `catalog` referenced by `source`, in dependency order. */
export function selectReferencedLibraries(
  source: string,
  catalog: Readonly<Record<string, string>>,
): Record<string, string> {
  const resolved = resolveProgramLibraries(source, catalog);
  return "refusal" in resolved ? {} : resolved.libraries;
}

/**
 * The programs a text carries: its top-level fenced blocks tagged `norn run`
 * (`nornRunBlock`), each under its name. A block tagged `norn` alone is only
 * shown, and so is one inside a quote. Every block tagged `norn run` is here,
 * so one that runs nothing says why instead of being passed over; whether its
 * program checks is `checkNornProgram`'s to say.
 */
export function nornBlocks(body: string): NornBlock[] {
  const root = parseMarkdown(body) as { children?: { type?: string; lang?: string | null; meta?: string | null; value?: string }[] };
  const blocks = (root.children ?? []).flatMap(node => {
    const block = node.type === "code" ? nornRunBlock([node.lang, node.meta].filter(Boolean).join(" ")) : null;
    return block ? [{ ...block, source: node.value ?? "" }] : [];
  });
  // A name used twice names nothing: neither block runs until one is renamed.
  return blocks.map(block => block.problem || blocks.filter(other => other.name === block.name).length < 2 ? block
    : { ...block, problem: `Two blocks are named ${block.name}; rename one.` });
}

/** Why a block does not run as written, or undefined when it runs. */
export function nornBlockProblem(
  block: NornBlock,
  libraries?: Readonly<Record<string, string>>,
  libraryProblems?: Readonly<Record<string, string>>,
): string | undefined {
  if (block.problem) return block.problem;
  const checked = checkNornProgram(block.source, libraries || libraryProblems ? { libraries, libraryProblems } : undefined);
  return "refusal" in checked ? checked.refusal : undefined;
}

/** A running Norn program that a proposed Page edit would silently remove or break. */
export interface NornEditGuardViolation {
  name: string;
  reason: "removed" | "broken";
  detail: string;
}

const librariesKey = (libs: Readonly<Record<string, string>>): string =>
  JSON.stringify(Object.entries(libs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Guards an atomic Page edit (`current` -> `target`) against silently removing
 * or breaking any currently running `norn run` block (or a Space library it
 * depends on). Only programs present in `current` and currently running are
 * checked, so unrelated edits on a page with an already-broken block still go
 * through. Callers that intentionally stop and remove a running program list
 * its block name in `removePrograms`.
 */
export function guardRunningNornBlocks(
  current: string,
  target: string,
  runningPrograms: ReadonlyArray<{ name: string }>,
  options?: {
    removePrograms?: ReadonlySet<string>;
    extraLibraries?: Readonly<Record<string, string>>;
  },
): NornEditGuardViolation[] {
  if (!runningPrograms.length) return [];
  const currentBlocks = nornBlocks(current);
  const targetBlocks = nornBlocks(target);
  const currentLibs = { ...options?.extraLibraries, ...pageSpaceLibraries(current) };
  const targetLibs = { ...options?.extraLibraries, ...pageSpaceLibraries(target) };
  const libsChanged = librariesKey(currentLibs) !== librariesKey(targetLibs);
  const currentLibOpts = Object.keys(currentLibs).length ? { libraries: currentLibs } : undefined;
  const targetLibOpts = Object.keys(targetLibs).length ? { libraries: targetLibs } : undefined;
  const violations: NornEditGuardViolation[] = [];
  const seen = new Set<string>();
  for (const { name } of runningPrograms) {
    if (seen.has(name)) continue;
    seen.add(name);
    const before = currentBlocks.find(block => block.name === name);
    if (!before) continue;
    const after = targetBlocks.find(block => block.name === name);
    if (!after) {
      if (options?.removePrograms?.has(name)) continue;
      violations.push({
        name,
        reason: "removed",
        detail: `Running program \`${name}\` would be removed from the page.`,
      });
      continue;
    }
    if (after.problem) {
      // An unsupported future edition header keeps the running program alive while reporting a notice.
      if (after.edition !== undefined && !isSupportedNornEdition(after.edition)) continue;
      if (!before.problem) violations.push({ name, reason: "broken", detail: after.problem });
      continue;
    }
    if (after.source === before.source && !libsChanged) continue;
    const afterChecked = checkNornProgram(after.source, targetLibOpts);
    if (!("refusal" in afterChecked)) continue;
    const beforeChecked = before.problem
      ? { refusal: before.problem }
      : checkNornProgram(before.source, currentLibOpts);
    if (!("refusal" in beforeChecked)) {
      violations.push({ name, reason: "broken", detail: afterChecked.refusal });
    }
  }
  return violations;
}

/** The program a message starts: its one `norn run` block. */
export function nornProgramIn(body: string): { source: string } | { refusal: string } | undefined {
  const blocks = nornBlocks(body);
  if (!blocks.length) return undefined;
  if (blocks.length > 1) return { refusal: "A message starts one program: it has more than one `norn run` block." };
  return blocks[0]!.problem ? { refusal: `The program was not started: ${blocks[0]!.problem}` } : { source: blocks[0]!.source };
}

/**
 * What this host adds to the language: the outside events a program can wait
 * for. Each is a stream of what happened, in words, with its link when it has
 * one. The Hub tells a program of an event only while the program's authority
 * may use its Space's connected apps.
 */
export const NORN_HOST_INTERFACE = `// A workflow failed on the default branch of the repository "owner/repo".
external ciFailed: (string) => stream<string>

// A pull request was merged into the default branch of the repository "owner/repo".
external prMerged: (string) => stream<string>

// A connected app delivered an event: appEvent("sentry", ~feature="issue.created").
external appEvent: (string, ~feature: string=?) => stream<string>
`;
const HOST = readInterface(NORN_HOST_INTERFACE, "xmatrix.norn");
const SOURCES = hostSources(HOST);
/** The standard library, for a program that writes `open Std`: `routine`, `decide`, `remind`, `followUp`, `schedule`, `all`, `race`, `quorum`. */
const STD = readLibrary(NORN_STD, "std.norn", HOST);
/** Pre-edition-1 standard library snapshot pinned for legacy v1 ledgers so AST node IDs stay byte-for-byte identical. */
const STD_LEGACY_V1 = readLibrary(NORN_STD_LEGACY_V1, "std.norn", HOST);
/** Built-in application libraries layered on `Events` and `Actions`: `GitHub`, `Gmail`, `X`. */
const BUILTIN_LIBRARIES = loadBuiltinNornLibraries(HOST);

function loadProgramLibraries(
  extra?: Readonly<Record<string, string>>,
  pinnedBuiltins?: Readonly<Record<string, string>>,
  options?: { source?: string; libraryProblems?: Readonly<Record<string, string>>; seedNames?: Iterable<string> },
): { libraries: Record<string, Library>; refusal?: string } {
  const libraries: Record<string, Library> = { ...BUILTIN_LIBRARIES };
  for (const [name, source] of Object.entries(pinnedBuiltins ?? {})) {
    const lib = readLibrary(source, `${name}.norn`, HOST, { name });
    if (lib.ok) libraries[name] = lib;
  }
  let orderedEntries: Array<[string, string]>;
  if ((extra || options?.libraryProblems) && (options?.source !== undefined || options?.seedNames !== undefined)) {
    const resolved = resolveProgramLibraries(options.source ?? "", extra ?? {}, options.libraryProblems, options.seedNames);
    if ("refusal" in resolved) return { libraries, refusal: resolved.refusal };
    orderedEntries = resolved.order.map(name => [name, resolved.libraries[name]!]);
  } else {
    orderedEntries = Object.entries(extra ?? {});
  }
  for (const [name, source] of orderedEntries) {
    const lib = readLibrary(source, `${name}.norn`, HOST, {
      name,
      libraries,
    });
    const errors = lib.diagnostics.filter(d => d.severity === "error");
    if (!lib.ok || errors.length) {
      return {
        libraries,
        refusal: `Library ${name}: ${errors.slice(0, 20).map(({ message, span }) => `${span.start.line}:${span.start.column} ${message}`).join("\n")}`,
      };
    }
    libraries[name] = lib;
  }
  return { libraries };
}

type Checked = { code: Code; targets: string[]; libraries: Readonly<Record<string, Library>> } | { refusal: string };
/** Checks a program against this host, `Std` (or pinned/legacy `Std`), built-in `GitHub`/`Gmail` libraries, and any Space libraries. */
export function checkNornProgram(
  source: string,
  options?: {
    libraries?: Readonly<Record<string, string>>;
    libraryProblems?: Readonly<Record<string, string>>;
    pinnedBuiltins?: Readonly<Record<string, string>>;
    stdSource?: string;
    legacyStd?: boolean;
  },
): Checked {
  const loaded = loadProgramLibraries(options?.libraries, options?.pinnedBuiltins, {
    source,
    libraryProblems: options?.libraryProblems,
  });
  if (loaded.refusal) return { refusal: loaded.refusal };
  const checkWithStd = (stdLib: Library): Checked => {
    const checked = checkSource(source, {
      host: HOST,
      std: stdLib,
      libraries: loaded.libraries,
      manifests: NORN_CONNECTOR_EVENT_MANIFESTS,
    });
    const errors = checked.diagnostics.filter(diagnostic => diagnostic.severity === "error");
    if (!checked.ok || !checked.program || errors.length) {
      return { refusal: errors.slice(0, 20).map(({ message, span }) => `${span.start.line}:${span.start.column} ${message}`).join("\n") };
    }
    const libraryPrograms = Object.fromEntries(Object.entries(loaded.libraries).map(([name, lib]) => [name, lib.program]));
    return {
      code: compile(elaborate(checked.program, checked.reports), { std: stdLib.program, libraries: libraryPrograms, sources: SOURCES }),
      targets: [...new Set((checked.effects ?? []).flatMap(effect => effect.targets))].sort(),
      libraries: loaded.libraries,
    };
  };
  if (options?.stdSource) {
    const pinnedStd = options.stdSource === NORN_STD ? STD : options.stdSource === NORN_STD_LEGACY_V1 ? STD_LEGACY_V1 : readLibrary(options.stdSource, "std.norn", HOST);
    return checkWithStd(pinnedStd);
  }
  if (options?.legacyStd) {
    const legacyResult = checkWithStd(STD_LEGACY_V1);
    if (!("refusal" in legacyResult)) return legacyResult;
  }
  return checkWithStd(STD);
}

/** Pins a program's source and every referenced library by SHA-256 content hash. */
export function pinNornProgram(
  source: string,
  spaceLibraries?: Readonly<Record<string, string>>,
  libraryProblems?: Readonly<Record<string, string>>,
): ProgramPin | { refusal: string } {
  const parsed = parse(source);
  if (!parsed.ok) return { refusal: parsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const loaded = loadProgramLibraries(spaceLibraries, undefined, { source, libraryProblems });
  if (loaded.refusal) return { refusal: loaded.refusal };
  return pinProgramDefinitions(parsed.program, loaded.libraries);
}

/** Computes a 3-way upgrade diff (interface diff + effect lock diff + ledger diff) before updating a program or library. */
export function diffNornProgramUpgrade(
  before: { source: string; libraries?: Readonly<Record<string, string>>; libraryProblems?: Readonly<Record<string, string>> },
  after: { source: string; libraries?: Readonly<Record<string, string>>; libraryProblems?: Readonly<Record<string, string>> },
  ledger: Ledger = emptyLedger(0),
  now = 0,
): UpgradeDiff | { refusal: string } {
  const beforeParsed = parse(before.source);
  if (!beforeParsed.ok) return { refusal: beforeParsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const afterParsed = parse(after.source);
  if (!afterParsed.ok) return { refusal: afterParsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const loadedBefore = loadProgramLibraries(before.libraries, undefined, { source: before.source, libraryProblems: before.libraryProblems });
  if (loadedBefore.refusal) return { refusal: loadedBefore.refusal };
  const loadedAfter = loadProgramLibraries(after.libraries, undefined, { source: after.source, libraryProblems: after.libraryProblems });
  if (loadedAfter.refusal) return { refusal: loadedAfter.refusal };
  return diffProgramUpgrade({
    beforeProgram: beforeParsed.program,
    afterProgram: afterParsed.program,
    host: HOST,
    std: STD,
    beforeLibraries: loadedBefore.libraries,
    afterLibraries: loadedAfter.libraries,
    ledger,
    now,
    sources: SOURCES,
  });
}

/** Two-text read-only edit preview against an existing ledger without mutating it. */
export function previewNornEdit(
  beforeSource: string,
  afterSource: string,
  ledger: Ledger,
  now: number,
  options?: {
    beforeLibraries?: Readonly<Record<string, string>>;
    afterLibraries?: Readonly<Record<string, string>>;
    beforeLibraryProblems?: Readonly<Record<string, string>>;
    afterLibraryProblems?: Readonly<Record<string, string>>;
  },
): EditPreview | { refusal: string } {
  const before = checkNornProgram(beforeSource, options?.beforeLibraries || options?.beforeLibraryProblems
    ? { libraries: options?.beforeLibraries, libraryProblems: options?.beforeLibraryProblems } : undefined);
  if ("refusal" in before) return before;
  const after = checkNornProgram(afterSource, options?.afterLibraries || options?.afterLibraryProblems
    ? { libraries: options?.afterLibraries, libraryProblems: options?.afterLibraryProblems } : undefined);
  if ("refusal" in after) return after;
  return previewEdit(before.code, after.code, ledger, now);
}

/**
 * Read-only migration verification for legacy v1 ledgers: never mutates the
 * input ledger and fails closed (`keepLegacy: true`) on any ambiguity.
 */
export function verifyNornLedgerMigration(
  source: string,
  legacyLedger: Ledger,
  now: number,
  steps: readonly MigrationStep[] = [],
  options?: { libraries?: Readonly<Record<string, string>>; legacyStd?: boolean },
): { migration: MigrationResult; report?: MigrationReport } | { refusal: string } {
  const checked = checkNornProgram(source, { ...options, legacyStd: options?.legacyStd ?? ((legacyLedger.identityScheme ?? 1) === 1) });
  if ("refusal" in checked) return checked;
  const migration = migrateLedger(checked.code, legacyLedger, now);
  if (!migration.ok) return { migration };
  const report = verifyMigration(checked.code, legacyLedger, now, steps);
  return { migration, report };
}

/** A holder that names an Agent this host starts: a harness by its name, or `@auto`. */
export const agentHolder = (holder: string): boolean =>
  holder === "@auto" || (!holder.includes(":") && parseHarnessCapabilityMentions(holder).length === 1);
/**
 * A holder that can only be a person: a name that is no harness and no
 * Instance address. Who that is, and whether anyone is, is known only where
 * the request is delivered: the conversation's people are read there.
 */
export const personHolder = (holder: string): boolean => holder.startsWith("@") && !holder.includes(":") && !agentHolder(holder);
/** An Agent Instance by its address in the conversation: `@claude:2`. */
export const instanceHolder = (holder: string): boolean => /^@[^\s@:()]{1,80}:[1-9]\d{0,8}$/u.test(holder);
/**
 * Whom this host can deliver a request to: a harness by its name or `@auto`,
 * each delivery starting a new Run of it, or a person by name. An Instance by
 * its address only holds a request its holder delegated to it there: a
 * program asks by name, and a new Run takes it.
 */
const deliverable = (request: Pick<LedgerRequest, "holder" | "delegatedBy" | "action">): boolean =>
  Boolean(request.action) || agentHolder(request.holder) || personHolder(request.holder) || (Boolean(request.delegatedBy) && instanceHolder(request.holder));

/**
 * A request of a connected app (Norn spec §6.3): `Actions.prepare`, which
 * fixes what will be done and has it admitted, or `Actions.perform`, which
 * does it once. The host holds it; no Agent and no person is delivered it.
 */
export type NornAppRequest = LedgerRequest & { action: NonNullable<LedgerRequest["action"]> };
export const appRequest = (request: Pick<LedgerRequest, "action">): request is NornAppRequest => Boolean(request.action);
/** A connected app by the name people know it by. */
const appName = (app: string): string => APP_CONNECTOR_PROVIDER_MANIFESTS.find(manifest => manifest.id === app)?.name ?? app;
/**
 * Who a request is asked of and what is asked, as a reader of the program's
 * flow takes it in. A request of a connected app reads as the app and what it
 * is to do, never as the host's own holder name.
 */
export function nornRequestWords(request: Pick<LedgerRequest, "holder" | "text" | "verb" | "action" | "context">): { holder: string; text: string } {
  if (!request.action) return { holder: request.holder, text: request.text };
  return { holder: `@${appName(request.action.app)}`, text: request.verb === "prepare"
    ? `Approve ${request.text}${request.context ? `: ${request.context}` : ""}`
    : request.verb === "read"
      ? `Read ${request.text}${request.context ? `: ${request.context}` : ""}`
      : `Do ${request.text}, as approved` };
}
/** What the host answers a `prepare` it admitted with: the one value the program's `perform` takes. */
export const nornPreparedReply = (request: LedgerRequest): Reply => ({ tag: "Answered", value: preparedAction(request) });
/** Converts bounded plain JSON from a connector action into a Norn `Value` for `json` fields. */
function plainJsonToValue(raw: unknown): Value {
  if (raw === null || raw === undefined) return unit;
  if (typeof raw === "boolean") return { type: "bool", value: raw };
  if (typeof raw === "number") return Number.isInteger(raw) ? { type: "int", value: String(raw) } : number(raw);
  if (typeof raw === "string") return text(raw);
  if (Array.isArray(raw)) return { type: "list", values: raw.map(plainJsonToValue) };
  if (typeof raw === "object") {
    const fields: Record<string, Value> = {};
    for (const [key, item] of Object.entries(raw as Record<string, unknown>)) fields[key] = plainJsonToValue(item);
    return { type: "record", fields };
  }
  return unit;
}
/** What a completed action answers: the receipt's words, its link when it gave one, and any structured JSON fields. */
export const nornActionAnswer = (result: { summary: string; url?: string; data?: Readonly<Record<string, unknown>> }): Reply => {
  const fields: Record<string, Value> = {
    summary: text(result.summary),
    url: result.url ? { type: "variant", name: "Some", args: [text(result.url)] } : { type: "variant", name: "None", args: [] },
  };
  if (result.data) {
    for (const [key, value] of Object.entries(result.data)) {
      if (key !== "summary" && key !== "url") fields[key] = plainJsonToValue(value);
    }
  }
  return { tag: "Answered", value: { type: "record", fields } };
};
/** Why this host cannot do what a request asks of a connected app; undefined when it can try. */
function appRefusal(request: NornAppRequest): string | undefined {
  const { app, name, input } = request.action;
  const spec = nornConnectorActionSpecs(app).find(candidate => candidate.name === name);
  if (!spec) return `This host has no action ${name} of the app ${app}`;
  if (request.verb === "read" && spec.effect !== "read") return `${app} ${name} is not a read-only action`;
  if (request.verb !== "prepare" && request.verb !== "read") return undefined;
  const statement = nornActionStatement(app, name, input);
  return "refusal" in statement ? statement.refusal : undefined;
}

const typeText = (form: Form): string => form.kind === "base" || form.kind === "named" ? form.name
  : form.kind === "list" ? `list<${typeText(form.element)}>` : form.kind === "tuple" ? `(${form.elements.map(typeText).join(", ")})` : "_";
/** A report's form as its holder reads it: the type, then each type it names. */
function formText(report: ReportForm): string {
  const lines = Object.entries(report.definitions).flatMap(([name, definition]) => definition.kind === "host" ? []
    : [`${name} = ${definition.kind === "record" ? `{${definition.fields.map(field => `${field.name}: ${typeText(field.form)}`).join(", ")}}`
      : definition.constructors.map(ctor => ctor.name + (ctor.args.length ? `(${ctor.args.map(typeText).join(", ")})` : "")).join(" | ")}`]);
  return [report.text, ...lines.filter(line => line !== `${report.text} = ${report.text}`)].join("\n");
}
/** A run whose report the program reads only as this host's report: its text. */
const hostReport = (form: ReportForm | null): boolean =>
  form === null || (form.form.kind === "named" && form.definitions[form.form.name]?.kind === "host");
/** What an answer to this request must be, in words for its holder. */
function answerText(request: LedgerRequest): string {
  switch (request.verb) {
    case "ask": return "any text";
    case "confirm": return "Yes or No";
    case "choose": return `one of: ${(request.options ?? []).map(show).join(", ")}`;
    case "judge": return "true or false";
    default: return !request.form || hostReport(request.form) || request.form.form.kind === "any" || request.form.text === "string"
      ? "any text: your report" : `a Norn value of this type:\n${formText(request.form)}`;
  }
}

/** Reads what a holder typed as the request's answer. Plain text is taken as it stands where the request wants text. */
export function readNornAnswer(request: Pick<LedgerRequest, "verb" | "form">, typed: string): { value: Value } | { refusal: string } {
  if (request.verb === "run" && hostReport(request.form)) return { value: { type: "record", fields: { text: text(typed) } } };
  // Text, or a report the program only passes on: what was typed is the answer, quoted or not.
  const wantsText = request.verb === "ask" || (request.verb === "run" && (request.form!.form.kind === "any" ||
    (request.form!.form.kind === "base" && request.form!.form.name === "string")));
  const parsed = parse(typed);
  // A value is a program that computes nothing and asks nobody.
  const pass = parsed.ok ? evaluate(compile(parsed.program), emptyLedger(), 0, { steps: 100_000 }) : undefined;
  const value = pass?.status === "completed" && !pass.log.length ? pass.result : null;
  if (wantsText) return { value: value?.type === "string" ? value : text(typed) };
  return value ? { value } : { refusal: "The answer is not a Norn value, such as Sound or Flawed(\"why\")." };
}

const fence = (body: string): string => {
  const ticks = "`".repeat(Math.max(3, ...[...body.matchAll(/`+/gu)].map(run => run[0].length + 1)));
  return `${ticks}text\n${body}\n${ticks}`;
};
/** What a program may ask of the participant a request starts: where it runs and with what. */
const CONDITIONS = ["repo", "pwd", "machine", "harness", "model", "effort"];
/**
 * The conditions a program put on its participant (`@auto(~repo="acme/app")`),
 * as a summon writes them (`repo:acme/app`), or why they cannot be written.
 */
function summonConditions(request: LedgerRequest): { words: string[]; refusal?: string } {
  const words: string[] = [];
  for (const [label, value] of Object.entries(request.conditions ?? {})) {
    if (!CONDITIONS.includes(label)) return { words, refusal: `This host does not know the condition ~${label}; it knows ${CONDITIONS.map(each => `~${each}`).join(", ")}` };
    if (!value || /["\n]/u.test(value)) return { words, refusal: `The condition ~${label} cannot be written in a summon` };
    words.push(`${label}:${/\s/u.test(value) ? `"${value}"` : value}`);
  }
  return { words };
}

/** A participant's name as words: without the `@`, so that saying it summons and notifies nobody. */
const named = (participant: string): string => participant.replace(/^@/u, "");
/**
 * How a holding came about, for its holder, when a participant made it
 * (Norn spec §7): delegated to them to answer for someone, or given back to
 * them by the one they delegated it to. What the participant wrote is quoted,
 * so nothing in it summons or commands anyone.
 */
function delegationLines(request: Pick<LedgerRequest, "holder" | "delegatedBy">, delegation: Delegation | null,
  reader: "agent" | "person"): string[] {
  const words = delegation?.reason ? ["Their words:", fence(delegation.reason)] : [];
  if (request.delegatedBy && delegation?.kind === "delegated" && delegation.to === request.holder) {
    return ["", `${named(request.delegatedBy)} delegated this request to you: you answer it for them.`, ...words,
      reader === "agent" ? `If you will not or cannot answer it, \`xmatrix refuse\` or \`xmatrix broke\` gives it back to ${named(request.delegatedBy)}; it does not end the request.`
        : `Declining gives it back to ${named(request.delegatedBy)}.`];
  }
  if (!request.delegatedBy && delegation?.kind === "returned" && delegation.to === request.holder) {
    return ["", `${named(delegation.from)}, to whom you delegated this request, gave it back: it is yours to answer again.`, ...words];
  }
  return [];
}
/**
 * The message that delivers a request to its holder. What the program wrote
 * is quoted as literal text, so nothing in it summons or commands anyone;
 * the only summon is the holder's own, on the first line.
 *
 * A person reading the conversation is shown the message up to `answerFrom`:
 * the summon and the request's reference, which their client draws as the
 * request itself. What follows is the holder's: the task in full and how to
 * answer it.
 */
export function nornDelivery(request: LedgerRequest, requestRef: string, to: {
  /** The Instance already there that the request goes to, by its address; without one the holder's summon starts a Run. */
  there?: string;
  /** Its Instance stays for the program's next request, instead of ending with this one. */
  kept?: boolean;
  /** The Instance was at work here before the request was delegated to it: answering it does not end its Run. */
  atWork?: boolean;
  /** An earlier holding of the request broke off: this holder goes on from what that one did. */
  handedOn?: boolean;
  /** A person takes part in the program, so the holder says in the conversation what it does. */
  withPerson?: boolean;
  /** How this holding came about, when a participant made it: delegated to this holder, or given back to it. */
  delegation?: Delegation | null } = {}): { body: string; answerFrom: number } {
  const [answer, ...types] = answerText(request).split("\n");
  const asked = [to.there ?? [request.holder, ...summonConditions(request).words].join(" "), "",
    // The reference in its own code span is what a person's client draws as the request itself.
    `**Request** \`${requestReferenceToken(requestRef)}\``].join("\n");
  const answering = ["", "", fence(request.text),
    ...(request.about === null ? [] : ["", "About:", fence(request.about)]),
    ...(request.context === null ? [] : ["", "Given:", fence(request.context)]),
    ...(to.handedOn ? ["", "An earlier attempt at this request broke off before it answered. First read this conversation (`xmatrix channel history`) and the pages the request names for what that attempt already did, and go on from there: do not do again what is done."] : []),
    ...delegationLines(request, to.delegation ?? null, "agent"),
    "", "The request is from a program. xMatrix posts your answer in this conversation under your name and gives it to the program.",
    // Agents that work for one another alone keep the conversation to their answers; where a person takes part, they follow the work here.
    to.withPerson ? "A person takes part in this program and reads this conversation: say here what you are doing, as you would on a task they gave you."
      : "Say nothing else in the conversation.",
    "What is left for a person to do or decide goes to them as a card before you answer: `xmatrix ask @name …`, `xmatrix confirm @name …` or `xmatrix choose @name …`. Words in your answer alone ask nobody; the card's answer comes back to you here.",
    to.atWork ? "Answer it with exactly one of these. It does not end your Run: you were at work here before it came, and you go on:"
      : to.kept ? "End this turn with exactly one of these. You stay in this conversation afterwards: the program may ask you again here, and a person who writes here reaches you:"
      : "End this turn with exactly one of these. It ends your Run, so do it last:", "",
    `- \`xmatrix reply ${requestRef} '<answer>'\` when it is done. The answer must be ${answer}`,
    ...(types.length ? ["", fence(types.join("\n")), ""] : []),
    `- \`xmatrix refuse ${requestRef} '<why>'\` when you will not do it.`,
    `- \`xmatrix broke ${requestRef} '<why>'\` when you tried and could not.`,
    // A delegate answers or gives the request back; only the holder the program asked passes it on.
    ...(request.delegatedBy ? [] : [`- \`xmatrix delegate ${requestRef} @name '<why>'\` when the whole request is someone else's to answer: a person here, or an Agent. They answer it for you.`]),
    "", `A turn that ends without one of these is recorded as failed.${request.by === null ? "" : ` The request closes at ${new Date(request.by).toISOString()}.`}`,
  ].join("\n");
  return { body: asked + answering, answerFrom: asked.length };
}
/**
 * A request of a person as its card shows it (`appMetadata.nornRequest`): what
 * is asked, what an answer may be, and until when. The Web draws the controls
 * from `verb` and `options`; the answer comes back by the request's reference.
 */
export interface NornRequestCard {
  ref: string; verb: string; holder: string; holderUserId: string; text: string;
  about: string | null; context: string | null;
  /** What `choose` offers, as Norn writes each option. */
  options: string[];
  /** When the request closes by itself. */
  by: string | null;
  /** The Agent Instance whose program asks (`claude:2`); null when a person wrote the program. */
  asker: string | null;
  /** The answer taken when it closes unanswered, where the asker said so. */
  otherwise: string | null;
  /** Who delegated the request to this person (`@Daniel`), who answers it for them; null when it was not delegated. */
  delegatedBy: string | null;
}
/** Who asks and what silence means, as the program that makes the request says. */
export interface NornAsking { asker: string | null; otherwise: string | null }
export const nornRequestCard = (request: LedgerRequest, requestRef: string, holderUserId: string,
  asking: NornAsking = { asker: null, otherwise: null }): NornRequestCard => ({
  ref: requestRef, verb: request.verb, holder: request.holder, holderUserId, text: request.text, about: request.about,
  context: request.context, options: (request.options ?? []).map(show),
  by: request.by === null ? null : new Date(request.by).toISOString(), ...asking, delegatedBy: request.delegatedBy ?? null });
/**
 * Who asks a request and what silence means: the Agent that wrote the program,
 * by its address without the @, and for a question asked with a command
 * (`nornQuestionSource`), the answer it gave for silence.
 */
export function nornAsking(program: { authorMention: string | null; source: string; askedWithCommand: boolean }): NornAsking {
  const otherwise = program.askedWithCommand ? /^\| NoReply => Answered\(([A-Z][A-Za-z0-9]*)\)$/mu.exec(program.source)?.[1] : undefined;
  return { asker: program.authorMention?.replace(/^@/u, "") ?? null, otherwise: otherwise ?? null };
}
/**
 * The same request in words, for whoever reads the conversation without the
 * card: the person's name first, so it tells them as a mention does. A person
 * is shown what is asked, never the request's reference; the card carries it.
 */
export function nornPersonBody(request: LedgerRequest, asking: NornAsking = { asker: null, otherwise: null },
  delegation: Delegation | null = null): string {
  // What is asked comes first: a list of conversations shows the start of the message, and that is what its
  // reader needs. The first line is plain words; the rest of a longer question follows as the program wrote it.
  const [first = "", ...more] = request.text.split("\n");
  return [`${request.holder} ${first.replace(/[`*_[\]]/gu, "").trim()}`,
    ...(more.join("").trim() ? ["", fence(request.text)] : []),
    ...(request.about === null ? [] : ["", "About:", fence(request.about)]),
    ...(request.context === null ? [] : ["", "Given:", fence(request.context)]),
    ...delegationLines(request, delegation, "person"),
    "", `Answer on this card: ${answerText(request).split("\n")[0]}.${request.by === null ? ""
      : ` It closes at ${new Date(request.by).toISOString()}${asking.otherwise === null ? "" : `; without an answer, ${asking.otherwise}`}.`} ${
      asking.asker ?? "A program"} asks.`,
  ].join("\n");
}
/** How a person's request ended, in a line under its card. */
export function nornOutcomeText(holder: string, reply: Reply, otherwise: string | null = null): string {
  switch (reply.tag) {
    case "Answered": return `${holder} answered: ${reply.value.type === "string" ? reply.value.value : show(reply.value)}`;
    case "Refused": return `${holder} declined: ${reply.reason}`;
    case "NoReply": return otherwise === null ? "It closed without an answer." : `It closed without an answer, so ${otherwise}.`;
    case "Cancelled": return "The program no longer asks this.";
    case "Revoked": return "The program lost the authority to ask this.";
    default: return reply.reason;
  }
}
/** One question an Agent asks with a command instead of writing its program (`xmatrix confirm`, `choose`, `ask`). */
export interface NornQuestion {
  verb: "ask" | "confirm" | "choose"; who: string; question: string;
  /** What `choose` offers: capitalised words. */
  options?: string[];
  /** When it closes without an answer: a duration (`1d`) or a time (`2026-11-20T09:00Z`). */
  by?: string;
  /** The answer taken when it closes unanswered; without one, the asker reads that nobody replied. */
  otherwise?: string;
}
/**
 * The program for one question: the request, waited on, with what silence
 * means when the asker said so. Its result is the reply itself, so the asker
 * reads `Answered(…)`, `Refused(…)` or `NoReply`. Returns why it cannot be asked.
 */
export function nornQuestionSource(input: NornQuestion): { source: string } | { refusal: string } {
  if (!/^@[^\s@:()]{1,80}(?::[1-9]\d{0,8})?$/u.test(input.who)) return { refusal: "Name whom to ask, as in @Daniel" };
  if (input.by !== undefined && !/^(?:[1-9]\d{0,3}(?:m|h|d)|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)$/u.test(input.by)) {
    return { refusal: "--by is a duration such as 4h or 2d, or a UTC time such as 2026-11-20T09:00Z" };
  }
  const options = input.verb === "choose" ? input.options ?? [] : input.verb === "confirm" ? ["Yes", "No"] : [];
  if (input.verb === "choose" && (options.length < 2 || new Set(options).size !== options.length || options.some(option => !/^[A-Z][A-Za-z0-9]{0,40}$/u.test(option)
    || ["Yes", "No", "Answered", "Refused", "Broke", "NoReply", "Cancelled", "Revoked", "Some", "None", "Ok", "Error", "First", "Second"].includes(option)))) {
    return { refusal: "Give two or more different options, each one capitalised word, as in Approve Reject Later" };
  }
  if (input.otherwise !== undefined && (!options.includes(input.otherwise) || input.by === undefined)) {
    return { refusal: options.length ? `--otherwise is one of ${options.join(", ")}, and needs --by: it is the answer taken when that time passes`
      : "--otherwise needs a question with options, and --by" };
  }
  const request = `${input.verb}(${input.who}, ${JSON.stringify(input.question)}${input.verb === "choose" ? `, [${options.join(", ")}]` : ""}${
    input.by === undefined ? "" : `, ~by=${input.by}`})->wait`;
  const source = [...(input.verb === "choose" ? [`type choice = ${options.join(" | ")}`] : []),
    ...(input.otherwise === undefined ? [request] : [`switch ${request} {`, `| NoReply => Answered(${input.otherwise})`, "| other => other", "}"])].join("\n");
  const checked = checkNornProgram(source);
  return "refusal" in checked ? { refusal: checked.refusal } : { source };
}

/** Message bodies are refused above this size, so a request that cannot fit is never delivered. */
const MAX_DELIVERY_BYTES = 60 * 1024;

/**
 * How a program ended, as its Channel reads it. A page's program ends in the
 * conversation that is the program, so there it is the outcome alone.
 */
export function nornEndBody(ended: Ledger["ended"], onPage = false): string {
  const [finished, stopped, lost] = onPage ? ["Finished", "Stopped", "Ended without its result"]
    : ["The program finished", "The program stopped", "The program ended without its result"];
  if (!ended) return onPage ? "Ended." : "The program ended.";
  if (ended.status === "completed") return `${finished}: ${ended.result ? show(ended.result) : "()"}`;
  return ended.error ? `${stopped}: ${ended.error}` : `${lost}: ${ended.result ? show(ended.result) : "failed"}`;
}

/** An answer as a reader takes it in: a report is its text, anything else is written as Norn writes it. */
export const plainAnswer = (value: Value): string =>
  value.type === "record" && Object.keys(value.fields).length === 1 && value.fields.text?.type === "string" ? value.fields.text.value : show(value);
/** A program's result: what it answered with, without the `Answered(…)` around it. */
export const plainResult = (value: Value): string =>
  value.type === "variant" && value.name === "Answered" && value.args.length === 1 ? plainAnswer(value.args[0]!) : show(value);

/**
 * What a holder's own ending of a request reads as, in the message xMatrix
 * posts under the holder's name. A delegate who refuses or fails gives the
 * request back to whoever delegated it, and says so.
 */
export const nornAnswerBody = (outcome: "answered" | "refused" | "broke", words: string, returnedTo?: string): string =>
  outcome === "answered" ? words : returnedTo ? `I gave this back to ${named(returnedTo)}: ${words}`
    : `${outcome === "refused" ? "I will not do this" : "I could not do this"}: ${words}`;

/** A program ended from outside, by whoever may stop it: nobody is to be told that it stopped by itself. */
const ENDED_FROM_OUTSIDE = /^(?:Stopped in the conversation|Removed (?:from|with) its page)$/u;
/** How a request ended without an answer, after its holder's name. */
function unanswered(reply: Reply): string {
  switch (reply.tag) {
    case "Broke": return `did not finish: ${reply.reason}`;
    case "Refused": return `declined: ${reply.reason}`;
    case "NoReply": return "did not answer in time";
    default: return "was not answered";
  }
}
/**
 * How a Page's program ended, as its conversation reads it, and whom that
 * waits on. What an Agent answered stands in the conversation under its name
 * already, so a result that is that answer is not said again. A program that
 * failed on an Agent's work or on its own error names the people who answered
 * it (or, with none, whoever saved it) and says where it stopped: nothing goes
 * on by itself from there, and the Agent that stayed in the conversation takes
 * what they say next.
 */
export function nornPageEnd(program: { ended: Ledger["ended"]; requests: Record<string, LedgerRequest> | null;
  people: { userId: string; name: string }[]; authority: { userId: string; name: string | null } }): { body: string; waitsOn: string[] } {
  const { ended } = program;
  const requests = Object.values(program.requests ?? {}).sort((a, b) => (a.settledAt ?? 0) - (b.settledAt ?? 0));
  if (ended?.status === "completed") {
    const result = ended.result ? plainResult(ended.result) : "";
    const told = requests.some(request => !personHolder(request.holder) && request.reply?.tag === "Answered" && plainAnswer(request.reply.value) === result);
    return { body: told || !result ? "Finished." : `Finished: ${result}`, waitsOn: [] };
  }
  if (!ended || (ended.error !== null && ENDED_FROM_OUTSIDE.test(ended.error))) return { body: nornEndBody(ended, true), waitsOn: [] };
  const last = requests.filter(request => request.reply !== null && !["Answered", "Cancelled"].includes(request.reply.tag)).at(-1);
  // A person who declined, or let their own request close, ended it themselves: they are not then waited on for it.
  if (ended.error === null && last && personHolder(last.holder)) return { body: nornEndBody(ended, true), waitsOn: [] };
  const people = program.people.length ? program.people
    : [{ userId: program.authority.userId, name: program.authority.name ? `@${program.authority.name}` : "" }];
  const asked = last?.text.split("\n")[0]?.replace(/[`*_[\]]/gu, "").trim() ?? "";
  const where = ended.error !== null ? `the program stopped: ${ended.error}`
    // The holder's name is written without its @: this tells people, and summons nobody.
    : last && appRequest(last) ? `${appName(last.action.app)} ${last.text} ${unanswered(last.reply!)}`
    : last ? `${last.holder.replace(/^@/u, "")}, asked “${asked.length > 200 ? `${asked.slice(0, 200)}…` : asked}”, ${unanswered(last.reply!)}`
    : nornEndBody(ended, true);
  const names = [...new Set(people.map(person => person.name).filter(name => /^@[^\s@]+$/u.test(name)))].join(" ");
  return { body: `${names ? `${names} ` : ""}This stopped before it was finished: ${where}. Nothing more happens by itself: say here what to do next.`,
    waitsOn: [...new Set(people.map(person => person.userId))] };
}

/** How long a pass waits before trying again a program this build cannot check. */
const NORN_RECHECK_MS = 5 * 60_000;
export interface NornPassResult {
  status: "running" | "completed" | "failed";
  /** Why what this pass carried was not taken: an answer, a delegation, a taking back. Absent when it was. */
  refusal?: string;
  /** A delegate refused or failed the request: it went back to this participant, who delegated it (Norn spec §7). */
  returnedTo?: string;
  /** Active branch conversations for a Page program (`forEach(~per)` / `Std.each` / `spawn(~key)`). */
  branches?: NornBranchChannel[];
  /** Conversations (program and/or branch) whose work changed in this pass and need coordinator reconciliation. */
  wakeChannels?: string[];
  /** `Holds.kind` keys (`"<source>:<Type>"`) the program holds (samples or listens to) after this pass. */
  holding?: string[];
}
/** A host-asserted fact update applied to the program's ledger via `hold(...)`. */
export interface NornHoldUpdate {
  source: string;
  typeName: string;
  id: string;
  /** Validated Norn value to hold, or `null` to retract. */
  value: Value | null;
  /** Explicit override for `Holds.changes` emission; defaults to `false` when authored by the program itself. */
  notify?: boolean;
}
/** What a call does to one request of the program, in the step that runs its pass. */
export type NornAct =
  /** Its holder ends it: an answer typed or given, a refusal, a failure. */
  | { requestId: string; epoch: number; reply: Reply | { typed: string } }
  /** Its holder delegates it to one participant, who answers it for them (Norn spec §7). */
  | { requestId: string; epoch: number; delegateTo: string; reason?: string }
  /** Whoever delegated it takes it back. */
  | { requestId: string; reclaim: true };
/**
 * Why this host cannot take a delegation of `request` to `to`, before the
 * ledger is asked: a participant it cannot deliver to, or a person for a
 * request whose conditions only an Agent can meet.
 */
function delegationRefusal(request: LedgerRequest, to: string): string | undefined {
  if (!agentHolder(to) && !personHolder(to) && !instanceHolder(to)) return `This host cannot deliver a request to ${to}`;
  if (personHolder(to) && Object.keys(request.conditions ?? {}).length) return `${to} is a person: the request's conditions, such as ~repo, apply to an Agent`;
  return undefined;
}
const reference = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `r${[...bytes].map(byte => "abcdefghijkmnpqrstuvwxyz23456789"[byte % 32]).join("")}`;
};

/**
 * The program from the top, until every request it has open is one this host
 * can deliver: one it cannot ends `Broke` at once with the reason, and the
 * program is evaluated again, so it reads the failure in the same pass. Each
 * evaluation is handed to `each`; the last one is returned.
 */
export function nornPasses(code: Code, ledger: Ledger, now: number, each: (pass: Pass) => void = () => {}, options: PassOptions = {}): Pass {
  // Each round ends at least one request this host cannot deliver, so the rounds end.
  for (;;) {
    const pass = evaluate(code, ledger, now, options);
    // A request the program's changed text no longer makes is called off, so nobody goes on working for a
    // program that will not read the answer: its Agent is let go, and a person's card says it is no longer asked.
    for (const left of pass.unreached) settle(ledger, left.id, left.holder, { tag: "Cancelled" }, now, left.epoch);
    each(pass);
    let undelivered = false;
    for (const request of Object.values(ledger.requests)) {
      if (request.reply !== null || request.verb === "spawn") continue;
      // One of a group takes the request for the group: the first this host can reach.
      const taker = request.candidates?.find(holder => deliverable({ holder, delegatedBy: null }));
      if (taker) take(ledger, request.id, taker, now);
      const reason = !deliverable(request) ? `This host cannot deliver a request to ${request.holder} yet`
        : appRequest(request) ? appRefusal(request) ?? null
        : personHolder(request.holder) && Object.keys(request.conditions ?? {}).length ? `${request.holder} is a person: conditions such as ~repo apply to an Agent`
        : (personHolder(request.holder) ? undefined : summonConditions(request).refusal)
          ?? (utf8ByteLength(nornDelivery(request, reference()).body) > MAX_DELIVERY_BYTES ? "The request is too large to deliver in one message" : null);
      if (reason === null) continue;
      settle(ledger, request.id, request.holder, { tag: "Broke", reason }, now, request.epoch);
      undelivered = true;
    }
    if (!undelivered) return pass;
  }
}

/**
 * One pass over a program's ledger: a stop, the answer this call carries,
 * the requests nobody works on any more, then the program from the top.
 * Requests this host cannot deliver end at once, so the program reads why.
 */
export function nornStep(act?: NornAct,
  /** An outside event and the streams it matches in this program (legacy text or CloudEvents 1.0.2). */
  occurred?: { id: string; streams: readonly NornStream[]; what: string; cloudEvent?: CloudEventInput },
  options?: {
    libraries?: Readonly<Record<string, string>>;
    replacePinnedLibraries?: boolean;
    pinDependencies?: boolean;
    /** Host-asserted `Holds` updates to apply before evaluating this pass. */
    holds?: readonly NornHoldUpdate[];
    /** Conversation ID of an Agent edit that triggered `holds` (used for anti-self-trigger `notify: false`). */
    editorConversationId?: string;
  }): NornStep<NornPassResult> {
  return (state: NornProgramState) => {
    // The host's receipt travels with the occurrence. Older ledgers have no receipt on their occurrences.
    const ledger = state.ledger as Omit<Ledger, "occurrences"> & {
      occurrences: (Ledger["occurrences"][number] & { outsideEventId?: string })[];
      pinnedLibraries?: Record<string, string>;
      pinnedStd?: string;
      pinnedBuiltinLibraries?: Record<string, string>;
      branchMeta?: Record<string, NornBranchChannel & { active: boolean }>;
      requestBranches?: Record<string, string>;
    };
    const now = Math.max(state.nowMs, ledger.startedAt);
    const isV2 = (ledger.identityScheme ?? 1) === 2;
    if (options?.replacePinnedLibraries) {
      const referenced = options.libraries ? selectReferencedLibraries(state.source, options.libraries) : {};
      if (Object.keys(referenced).length > 0) ledger.pinnedLibraries = referenced;
      else delete ledger.pinnedLibraries;
    } else if (options?.libraries && Object.keys(options.libraries).length > 0) {
      const referenced = selectReferencedLibraries(state.source, options.libraries);
      if (Object.keys(referenced).length > 0) ledger.pinnedLibraries = referenced;
    }
    if (isV2 && (options?.pinDependencies || !ledger.pinnedStd)) {
      ledger.pinnedStd ??= NORN_STD;
      ledger.pinnedBuiltinLibraries ??= { ...BUILTIN_NORN_LIBRARY_SOURCES };
    }
    const activeLibraries = options?.replacePinnedLibraries ? ledger.pinnedLibraries : (options?.libraries ?? ledger.pinnedLibraries);
    if (options?.holds?.length && state.stopReason === null) {
      const branchChannels = Object.values(ledger.branchMeta ?? {}).map(b => b.channelId);
      const isSelfChannel = Boolean(
        options.editorConversationId && (options.editorConversationId === state.channelId || branchChannels.includes(options.editorConversationId)),
      );
      const beforeOcc = ledger.occurrences.length;
      const beforeHolds = JSON.stringify(ledger.holds ?? null);
      for (const update of options.holds) {
        hold(ledger, holdKind(update.source, update.typeName), update.id, update.value, now, {
          notify: update.notify ?? !isSelfChannel,
        });
      }
      if (!act && !occurred && !options.libraries && !options.replacePinnedLibraries
        && ledger.occurrences.length === beforeOcc && JSON.stringify(ledger.holds ?? null) === beforeHolds) {
        return { write: null, result: { status: "running" } };
      }
    }
    if (occurred && state.stopReason === null) {
      const legacyStreams = occurred.streams.filter(stream => stream.name !== "Events.events");
      const eventsStreams = occurred.streams.filter(stream => stream.name === "Events.events");
      let deliveredAny = false;
      let recordedError = false;
      if (legacyStreams.length > 0 && !ledger.occurrences.some(entry => entry.outsideEventId === occurred.id)) {
        for (const stream of legacyStreams) {
          occur(ledger, stream, text(occurred.what), now);
          ledger.occurrences.at(-1)!.outsideEventId = occurred.id;
        }
        deliveredAny = true;
      }
      if (eventsStreams.length > 0 && occurred.cloudEvent) {
        const spec = NORN_CONNECTOR_EVENT_MANIFESTS
          .find(m => m.app === occurred.cloudEvent!.app)
          ?.events.find(e => e.kind === occurred.cloudEvent!.kind);
        const form = spec ? manifestEventForm(spec) : undefined;
        const res = deliverEvent(ledger, occurred.cloudEvent, now, { ...(form ? { form } : {}), matchSources: eventsStreams });
        if (res.delivered) deliveredAny = true;
        else if (res.errors?.length) recordedError = true;
      }
      if (!deliveredAny && !recordedError) {
        return { write: null, result: { status: "running" } };
      }
    }
    const checked = checkNornProgram(state.source, {
      ...(activeLibraries && Object.keys(activeLibraries).length ? { libraries: activeLibraries } : {}),
      ...(ledger.pinnedBuiltinLibraries ? { pinnedBuiltins: ledger.pinnedBuiltinLibraries } : {}),
      ...(ledger.pinnedStd ? { stdSource: ledger.pinnedStd } : { legacyStd: !isV2 }),
    });
    let refusal: string | undefined, returnedTo: string | undefined, nextDue: number | null = null, taken = false;
    // What the program says is new to the ledger in the pass that says it, so it is collected here and nowhere else.
    const said: { to: string; text: string }[] = [];
    let waits: unknown[] = [];
    let latestPassBranches: Pass["branches"] = [];
    let latestHolding: string[] = [];
    // A program is checked where it is written, so text that does not check here was written for another
    // build of the Hub: one being rolled out, or one rolled back. The program is left as it is and the pass is
    // tried again later, on a build that reads it. Stopping it would end work that nothing is wrong with.
    // A stop needs no reading of the text, so it is taken either way.
    if (state.stopReason !== null) stop(ledger, now, state.stopReason);
    else if ("refusal" in checked) {
      return { write: { retryAtMs: now + NORN_RECHECK_MS, ...(occurred ? { ledger } : {}) },
        result: { status: "running", refusal: `The program does not check on this build of the Hub yet:\n${checked.refusal}` } };
    } else {
      const asked = act ? ledger.requests[act.requestId] : undefined;
      if (act && asked && "reply" in act) {
        const read = "typed" in act.reply ? readNornAnswer(asked, act.reply.typed) : undefined;
        if (read && "refusal" in read) refusal = read.refusal;
        else {
          const reply: Reply = read ? { tag: "Answered", value: read.value } : act.reply as Reply;
          const told = ledger.delegations?.length ?? 0;
          taken = settle(ledger, asked.id, asked.holder, reply, now, act.epoch);
          // A delegate's refusal or failure ends nothing: the request went back to whoever delegated it.
          returnedTo = (ledger.delegations ?? []).slice(told).find(entry => entry.kind === "returned")?.to;
          if (returnedTo) taken = true;
          else if (!taken) refusal = ledger.evidence.at(-1)?.reason ?? "The answer was not taken";
        }
      } else if (act && asked && "delegateTo" in act) {
        refusal = delegationRefusal(asked, act.delegateTo) ?? delegate(ledger, asked.id, asked.holder, act.delegateTo, now,
          { epoch: act.epoch, ...(act.reason ? { reason: act.reason } : {}) }) ?? undefined;
        taken = refusal === undefined;
      } else if (act && asked) {
        refusal = asked.delegatedBy ? reclaim(ledger, asked.id, asked.delegatedBy, now) ?? undefined : "The request is not delegated";
        taken = refusal === undefined;
      }
      for (const row of state.requests) {
        const request = ledger.requests[row.requestId];
        if (!row.abandoned || request?.reply !== null || request.epoch !== row.epoch) continue;
        // The host held it for a connected app, and the time it gave itself to hear of an outcome has passed.
        if (appRequest(request)) {
          settle(ledger, request.id, request.holder, { tag: "Broke", reason: request.verb === "prepare"
            ? "Nobody answered this approval request in 30 days"
            : request.verb === "read" ? "The read stopped without a confirmed result"
              : "The action stopped without a confirmed result; it was not tried again" }, now, row.epoch);
          continue;
        }
        const person = personHolder(request.holder);
        const handedOn = ledger.evidence.some(entry => entry.request === request.id && entry.reason === NORN_HANDED_ON_REASON);
        // Work that broke off (a turn that failed, a Run that never started) is not the Agent giving up: the request
        // goes once to a new Instance, as a new holding, which is delivered again. What the first one left is evidence.
        if (!person && row.brokeOff && !handedOn) {
          ledger.evidence.push({ request: request.id, holder: request.holder, at: now, reason: NORN_HANDED_ON_REASON,
            reply: { tag: "Broke", reason: "The Agent's work on this request broke off without an answer" } });
          request.epoch++;
          continue;
        }
        settle(ledger, request.id, request.holder, { tag: "Broke", reason: person ? `${request.holder} can no longer read this conversation`
          : handedOn ? "The Agent's work on this request ended without an answer, the second time on a new Instance"
          : "The Agent's work on this request ended without an answer" }, now, row.epoch);
      }
      nornPasses(checked.code, ledger, now, pass => {
        nextDue = pass.nextDue;
        latestPassBranches = pass.branches;
        // Surface `accepting` request validator rejections directly back to the respondent so they can retry.
        if (act && asked && "reply" in act) {
          const validationError = pass.validationErrors?.find(err => err.id === asked.id);
          if (validationError) {
            refusal = validationError.reason;
            taken = false;
          }
        }
        // The streams a plain wait is on, and those the program's loops take from while a handler works:
        // an event on one of the latter is kept for the loop, which handles it when the round is over.
        const streams = [...(pass.waiting?.targets ?? []).flatMap(target => target.kind === "stream" ? [target.source] : []), ...pass.listening];
        const uniqueStreams = streams.filter((stream, index) => streams.findIndex(other => eventKey(other) === eventKey(stream)) === index);
        const heldKinds = new Set<string>(pass.holding);
        for (const stream of uniqueStreams) {
          if (stream.name === "Holds.members" && stream.args[0]) {
            try { heldKinds.add(holdKindKey(stream.args[0])); } catch { /* ignore */ }
          } else if (stream.name === "Holds.changes" && stream.args[0]?.type === "variant" && stream.args[0].name === "Held" && stream.args[0].args[0]) {
            try { heldKinds.add(holdKindKey(stream.args[0].args[0])); } catch { /* ignore */ }
          }
        }
        latestHolding = [...heldKinds];
        waits = [...uniqueStreams, ...latestHolding.map(kind => ({ type: "hold", kind }))];
        said.push(...pass.said);
        // A round whose handler ended in anything but an answer is told in the program's conversation, once.
        for (const entry of pass.log) {
          if (entry.kind === "handlerFailed") said.push({ to: "", text: `A round of this program did not succeed: ${show(entry.reply)}` });
        }
      });
    }
    if (act && !taken && refusal === undefined) refusal = "The request has already ended";
    const activeBranches: NornBranchChannel[] = [];
    if (state.pageId && state.pageName) {
      // Nested `forEach` loops prepend `loop:` on each nesting level (`loop:loop:...`);
      // stripping leading `loop:` prefixes restores a strict slash-delimited ancestry path.
      const normalizeBranchScope = (scope: string): string => scope.replace(/^(?:loop:)+/u, "");
      type BranchDescriptor = NornBranchChannel & { active: boolean; spawnId?: string };
      const descriptors: BranchDescriptor[] = [];
      for (const branch of latestPassBranches) {
        const loopName = branch.loop.replace(/^loop:/u, "");
        let partition = branch.partition;
        if (partition.startsWith("\"") && partition.endsWith("\"")) {
          try {
            const parsed = JSON.parse(partition);
            if (typeof parsed === "string") partition = parsed;
          } catch { /* keep raw partition representation */ }
        }
        const key = `${loopName}:${partition}`;
        descriptors.push({
          key,
          label: partition,
          scope: branch.scope,
          channelId: nornBranchConversationId(state.pageId, state.pageName, key),
          active: true,
        });
      }
      for (const req of Object.values(ledger.requests)) {
        if (req.verb !== "spawn" || req.text === "$spawn" || !req.spawnScope) continue;
        const spawnNorm = normalizeBranchScope(req.spawnScope);
        const outer = descriptors
          .filter(d => {
            if (d.spawnId) return false;
            const dNorm = normalizeBranchScope(d.scope);
            return spawnNorm === dNorm || spawnNorm.startsWith(`${dNorm}/`);
          })
          .sort((a, b) => normalizeBranchScope(b.scope).length - normalizeBranchScope(a.scope).length)[0];
        const key = outer ? `${outer.key}/spawn:${req.text}` : `spawn:${req.text}`;
        const label = outer ? `${outer.label} · ${req.text}` : req.text;
        descriptors.push({
          key,
          label,
          scope: req.spawnScope,
          channelId: nornBranchConversationId(state.pageId, state.pageName, key),
          active: req.reply === null,
          spawnId: req.id,
        });
      }
      if (descriptors.length > 0 || ledger.branchMeta) {
        const meta = (ledger.branchMeta ??= {});
        const reqBranches = (ledger.requestBranches ??= {});
        for (const existing of Object.values(meta)) existing.active = false;
        for (const desc of descriptors) {
          meta[desc.key] = { key: desc.key, label: desc.label, scope: desc.scope, channelId: desc.channelId, active: desc.active };
        }
        const byScopeDesc = [...descriptors]
          .map(desc => ({ desc, norm: normalizeBranchScope(desc.scope) }))
          .sort((a, b) => b.norm.length - a.norm.length);
        const bySpawnId = new Map(descriptors.filter(d => d.spawnId).map(d => [d.spawnId!, d]));
        for (const req of Object.values(ledger.requests)) {
          if (req.verb === "spawn" || reqBranches[req.id]) continue;
          const reqNorm = normalizeBranchScope(req.scope ?? req.openedBy ?? "");
          const matched = byScopeDesc.find(({ norm }) => reqNorm === norm || reqNorm.startsWith(`${norm}/`))?.desc
            ?? (req.spawnOwner ? bySpawnId.get(req.spawnOwner) : undefined);
          if (matched) reqBranches[req.id] = matched.key;
        }
        for (const entry of Object.values(meta)) {
          if (entry.active) activeBranches.push({ key: entry.key, label: entry.label, scope: entry.scope, channelId: entry.channelId });
        }
      }
    }
    const prevRequests = new Map(state.requests.map(row => [row.requestId, row]));
    const status = ledger.ended ? ledger.ended.status : "running";
    const indexedRequests = Object.values(ledger.requests)
      .filter(request => request.verb !== "spawn" && (prevRequests.has(request.id) || request.reply === null))
      .map(request => {
        const branchKey = ledger.requestBranches?.[request.id];
        const branchChannelId = branchKey ? ledger.branchMeta?.[branchKey]?.channelId : undefined;
        return {
          requestId: request.id,
          requestRef: prevRequests.get(request.id)?.requestRef ?? reference(),
          epoch: request.epoch,
          holder: request.holder,
          settled: request.reply !== null,
          delegated: Boolean(request.delegatedBy),
          ...(branchChannelId ? { channelId: branchChannelId } : {}),
        };
      });
    const wakeSet = new Set<string>();
    if (status !== "running" || said.length > 0) wakeSet.add(state.channelId);
    for (const req of indexedRequests) {
      const targetChannel = req.channelId ?? state.channelId;
      const prev = prevRequests.get(req.requestId);
      if (!prev || prev.epoch !== req.epoch || prev.settled !== req.settled || (!req.settled && !prev.delivered)) {
        wakeSet.add(targetChannel);
      }
    }
    if (ledger.branchMeta) {
      const activeBranchIds = new Set(activeBranches.map(b => b.channelId));
      for (const entry of Object.values(ledger.branchMeta)) {
        if (wakeSet.has(entry.channelId) && !activeBranchIds.has(entry.channelId)) {
          activeBranches.push({ key: entry.key, label: entry.label, scope: entry.scope, channelId: entry.channelId });
          activeBranchIds.add(entry.channelId);
        }
      }
    }
    const write: NornProgramWrite = { ledger, state: status, nextDueMs: ledger.ended ? null : nextDue,
      // Only external participant requests that were or will be delivered are indexed; internal `spawn` handles are settled by the evaluator.
      requests: indexedRequests,
      waits, notices: said.map(({ to, text: body }) => ({ noticeId: reference(), recipient: to, body })) };
    return { write, result: {
      status,
      ...(refusal === undefined ? {} : { refusal }),
      ...(returnedTo ? { returnedTo } : {}),
      ...(activeBranches.length ? { branches: activeBranches } : {}),
      ...(wakeSet.size ? { wakeChannels: [...wakeSet] } : {}),
      ...(latestHolding.length ? { holding: latestHolding } : {}),
    } };
  };
}

/**
 * Each `norn run` or `norn 1 lib` block of a text that does not check as written, and why:
 * what whoever just wrote the text is told at once.
 */
export function nornProgramProblems(
  body: string,
  spaceCatalog?: SpaceLibraryCatalog,
): { source: string; problem: string }[] {
  const catalog = spaceCatalog ?? collectSpaceLibraries([{ pageId: "self", body }]);
  const libProblems = nornLibBlocks(body).flatMap(block => {
    const tag = block.edition === undefined ? `\`\`\`norn lib ${block.name}` : `\`\`\`norn ${block.edition} lib ${block.name}`;
    if (block.problem) return [{ source: tag, problem: block.problem }];
    if (catalog.problems[block.name]) return [{ source: tag, problem: catalog.problems[block.name]! }];
    const loaded = loadProgramLibraries({ ...catalog.libraries, [block.name]: block.source }, undefined, {
      seedNames: [block.name],
      libraryProblems: catalog.problems,
    });
    return loaded.refusal ? [{ source: tag, problem: loaded.refusal }] : [];
  });
  const libraries = Object.keys(catalog.libraries).length ? catalog.libraries : undefined;
  const libraryProblems = Object.keys(catalog.problems).length ? catalog.problems : undefined;
  const runProblems = nornBlocks(body).flatMap(block => {
    const problem = nornBlockProblem(block, libraries, libraryProblems);
    return problem === undefined ? [] : [{ source: nornBlockSource(block.name, block.edition), problem }];
  });
  const factProblems = nornFactBlocks(body).flatMap(block => {
    const tag = block.edition === undefined ? `\`\`\`norn facts ${block.typeName}` : `\`\`\`norn ${block.edition} facts ${block.typeName}`;
    const checked = checkPageFactBlock(block, catalog);
    return checked.ok ? [] : [{ source: tag, problem: checked.problem }];
  });
  return [...libProblems, ...factProblems, ...runProblems];
}

/** How a block's opening line reads, to say which block a problem is about. */
export const nornBlockSource = (name: string, edition?: string): string =>
  edition === undefined ? `\`\`\`norn run ${name}` : `\`\`\`norn ${edition} run ${name}`;

/** The ledger a program starts from. */
export const nornStartLedger = (nowMs: number): Ledger => emptyLedger(nowMs);

/** An outside stream as a program named it: `ciFailed("acme/app")`, `appEvent("sentry", ~feature="issue.created")`, or `Events.events(...)`. */
export type NornStream = Extract<Value, { type: "source" }>;

export function isNornStream(value: unknown): value is NornStream {
  const stream = value as Partial<NornStream> | null;
  return stream?.type === "source" && stream.kind === "stream" && typeof stream.name === "string" && Array.isArray(stream.args);
}
/** The text a program wrote in a stream's position or label, when it wrote text there. */
const streamText = (value: { type: string; value?: unknown } | undefined): string | undefined =>
  value?.type === "string" && typeof value.value === "string" ? value.value : undefined;

/** Which `Events.events(Events.kind(app, kind), ~source=?, ~subject=?)` streams a CloudEvent matches. */
export const eventsStream = (app: string, kind: string, source?: string, subject?: string) => (stream: NornStream): boolean => {
  if (stream.name !== "Events.events") return false;
  const kindArg = stream.args[0];
  if (!kindArg || kindArg.type !== "variant" || kindArg.name !== "EventKind" || kindArg.args.length !== 2) return false;
  if (streamText(kindArg.args[0]) !== app || streamText(kindArg.args[1]) !== kind) return false;
  if (stream.labels?.source !== undefined && streamText(stream.labels.source) !== source) return false;
  if (stream.labels?.subject !== undefined && streamText(stream.labels.subject) !== subject) return false;
  return true;
};

/** Which streams a GitHub event on a repository's default branch is an occurrence of. */
export const githubStream = (kind: "ci-failed" | "merged", repository: string) => (stream: NornStream): boolean =>
  stream.name === (kind === "ci-failed" ? "ciFailed" : "prMerged") && streamText(stream.args[0]) === repository;
/** Which streams a connected app's event is an occurrence of: the app, and its feature when the program named one. */
export const appStream = (provider: string, feature: string) => (stream: NornStream): boolean =>
  stream.name === "appEvent" && streamText(stream.args[0]) === provider &&
  (stream.labels?.feature === undefined || streamText(stream.labels.feature) === feature);
