import { nornLibBlock, nornRunBlock, parseHarnessCapabilityMentions, parseMarkdown, requestReferenceToken, utf8ByteLength } from "@xmatrix/protocol";
import { NORN_HANDED_ON_REASON, type NornProgramState, type NornProgramWrite, type NornStep } from "@xmatrix/db";
import {
  checkSource, diffProgramUpgrade, elaborate, hostSources, pinProgramDefinitions, readInterface, readLibrary,
  type Form, type Library, type ProgramPin, type ReportForm, type UpgradeDiff,
} from "./vendor/norn/frontend/check/index";
import { NORN_STD } from "./vendor/norn/std";
import { parse } from "./vendor/norn/frontend/parser";
import { compile, type Code } from "./vendor/norn/runtime/code";
import {
  delegate, deliverEvent, emptyLedger, evaluate, migrateLedger, occur, previewEdit, reclaim, settle, stop, take, verifyMigration,
  type CloudEventInput, type Delegation, type EditPreview, type Ledger, type LedgerRequest, type MigrationReport, type MigrationResult,
  type MigrationStep, type Pass, type PassOptions, type Reply,
} from "./vendor/norn/runtime/ledger";
import { eventKey, show, text, type Value } from "./vendor/norn/runtime/value";
import {
  loadBuiltinNornLibraries, NORN_CONNECTOR_EVENT_MANIFESTS,
} from "./norn-libraries";

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

/** Map of valid Space library sources defined on a Page body. */
export function pageSpaceLibraries(body: string): Record<string, string> {
  const libs: Record<string, string> = {};
  for (const block of nornLibBlocks(body)) {
    if (!block.problem && block.name) libs[block.name] = block.source;
  }
  return libs;
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
export function nornBlockProblem(block: NornBlock, libraries?: Readonly<Record<string, string>>): string | undefined {
  if (block.problem) return block.problem;
  const checked = checkNornProgram(block.source, libraries ? { libraries } : undefined);
  return "refusal" in checked ? checked.refusal : undefined;
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
/** Built-in application libraries layered on `Events`: `GitHub`, `Gmail`. */
const BUILTIN_LIBRARIES = loadBuiltinNornLibraries(HOST);

function loadProgramLibraries(extra?: Readonly<Record<string, string>>): { libraries: Record<string, Library>; refusal?: string } {
  const libraries: Record<string, Library> = { ...BUILTIN_LIBRARIES };
  for (const [name, source] of Object.entries(extra ?? {})) {
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
/** Checks a program against this host, `Std`, built-in `GitHub`/`Gmail` libraries, and any Space libraries. */
export function checkNornProgram(source: string, options?: { libraries?: Readonly<Record<string, string>> }): Checked {
  const loaded = loadProgramLibraries(options?.libraries);
  if (loaded.refusal) return { refusal: loaded.refusal };
  const checked = checkSource(source, {
    host: HOST,
    std: STD,
    libraries: loaded.libraries,
    manifests: NORN_CONNECTOR_EVENT_MANIFESTS,
  });
  const errors = checked.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (!checked.ok || !checked.program || errors.length) {
    return { refusal: errors.slice(0, 20).map(({ message, span }) => `${span.start.line}:${span.start.column} ${message}`).join("\n") };
  }
  const libraryPrograms = Object.fromEntries(Object.entries(loaded.libraries).map(([name, lib]) => [name, lib.program]));
  return {
    code: compile(elaborate(checked.program, checked.reports), { std: STD.program, libraries: libraryPrograms, sources: SOURCES }),
    targets: [...new Set((checked.effects ?? []).flatMap(effect => effect.targets))].sort(),
    libraries: loaded.libraries,
  };
}

/** Pins a program's source and every referenced library by SHA-256 content hash. */
export function pinNornProgram(source: string, spaceLibraries?: Readonly<Record<string, string>>): ProgramPin | { refusal: string } {
  const parsed = parse(source);
  if (!parsed.ok) return { refusal: parsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const loaded = loadProgramLibraries(spaceLibraries);
  if (loaded.refusal) return { refusal: loaded.refusal };
  return pinProgramDefinitions(parsed.program, loaded.libraries);
}

/** Computes a 3-way upgrade diff (interface diff + effect lock diff + ledger diff) before updating a program or library. */
export function diffNornProgramUpgrade(
  before: { source: string; libraries?: Readonly<Record<string, string>> },
  after: { source: string; libraries?: Readonly<Record<string, string>> },
  ledger: Ledger = emptyLedger(0),
  now = 0,
): UpgradeDiff | { refusal: string } {
  const beforeParsed = parse(before.source);
  if (!beforeParsed.ok) return { refusal: beforeParsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const afterParsed = parse(after.source);
  if (!afterParsed.ok) return { refusal: afterParsed.diagnostics.map(d => `${d.span.start.line}:${d.span.start.column} ${d.message}`).join("\n") };
  const loadedBefore = loadProgramLibraries(before.libraries);
  if (loadedBefore.refusal) return { refusal: loadedBefore.refusal };
  const loadedAfter = loadProgramLibraries(after.libraries);
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
  options?: { beforeLibraries?: Readonly<Record<string, string>>; afterLibraries?: Readonly<Record<string, string>> },
): EditPreview | { refusal: string } {
  const before = checkNornProgram(beforeSource, options?.beforeLibraries ? { libraries: options.beforeLibraries } : undefined);
  if ("refusal" in before) return before;
  const after = checkNornProgram(afterSource, options?.afterLibraries ? { libraries: options.afterLibraries } : undefined);
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
  options?: { libraries?: Readonly<Record<string, string>> },
): { migration: MigrationResult; report?: MigrationReport } | { refusal: string } {
  const checked = checkNornProgram(source, options);
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
const deliverable = (request: Pick<LedgerRequest, "holder" | "delegatedBy">): boolean =>
  agentHolder(request.holder) || personHolder(request.holder) || (Boolean(request.delegatedBy) && instanceHolder(request.holder));

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
      if (request.reply !== null) continue;
      // One of a group takes the request for the group: the first this host can reach.
      const taker = request.candidates?.find(holder => deliverable({ holder, delegatedBy: null }));
      if (taker) take(ledger, request.id, taker, now);
      const reason = !deliverable(request) ? `This host cannot deliver a request to ${request.holder} yet`
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
  options?: { libraries?: Readonly<Record<string, string>> }): NornStep<NornPassResult> {
  return (state: NornProgramState) => {
    // The host's receipt travels with the occurrence. Older ledgers have no receipt on their occurrences.
    const ledger = state.ledger as Omit<Ledger, "occurrences"> & {
      occurrences: (Ledger["occurrences"][number] & { outsideEventId?: string })[];
      pinnedLibraries?: Record<string, string>;
    };
    const now = Math.max(state.nowMs, ledger.startedAt);
    if (options?.libraries && Object.keys(options.libraries).length > 0) {
      ledger.pinnedLibraries = { ...options.libraries };
    }
    const activeLibraries = options?.libraries ?? ledger.pinnedLibraries;
    if (occurred && state.stopReason === null) {
      const legacyStreams = occurred.streams.filter(stream => stream.name !== "Events.events");
      const eventsStreams = occurred.streams.filter(stream => stream.name === "Events.events");
      let deliveredAny = false;
      if (legacyStreams.length > 0 && !ledger.occurrences.some(entry => entry.outsideEventId === occurred.id)) {
        for (const stream of legacyStreams) {
          occur(ledger, stream, text(occurred.what), now);
          ledger.occurrences.at(-1)!.outsideEventId = occurred.id;
        }
        deliveredAny = true;
      }
      if (eventsStreams.length > 0 && occurred.cloudEvent) {
        const res = deliverEvent(ledger, occurred.cloudEvent, now, { matchSources: eventsStreams });
        if (res.delivered) deliveredAny = true;
      }
      if (!deliveredAny) {
        return { write: null, result: { status: "running" } };
      }
    }
    const checked = checkNornProgram(state.source, activeLibraries && Object.keys(activeLibraries).length ? { libraries: activeLibraries } : undefined);
    let refusal: string | undefined, returnedTo: string | undefined, nextDue: number | null = null, taken = false;
    // What the program says is new to the ledger in the pass that says it, so it is collected here and nowhere else.
    const said: { to: string; text: string }[] = [];
    let waits: unknown[] = [];
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
        // The streams a plain wait is on, and those the program's loops take from while a handler works:
        // an event on one of the latter is kept for the loop, which handles it when the round is over.
        const streams = [...(pass.waiting?.targets ?? []).flatMap(target => target.kind === "stream" ? [target.source] : []), ...pass.listening];
        waits = streams.filter((stream, index) => streams.findIndex(other => eventKey(other) === eventKey(stream)) === index);
        said.push(...pass.said);
        // A round whose handler ended in anything but an answer is told in the program's conversation, once.
        for (const entry of pass.log) {
          if (entry.kind === "handlerFailed") said.push({ to: "", text: `A round of this program did not succeed: ${show(entry.reply)}` });
        }
      });
    }
    if (act && !taken && refusal === undefined) refusal = "The request has already ended";
    const refs = new Map(state.requests.map(row => [row.requestId, row.requestRef]));
    const status = ledger.ended ? ledger.ended.status : "running";
    const write: NornProgramWrite = { ledger, state: status, nextDueMs: ledger.ended ? null : nextDue,
      // Only requests that were or will be delivered are indexed: the rest ended in the pass that opened them.
      requests: Object.values(ledger.requests).filter(request => refs.has(request.id) || request.reply === null)
        .map(request => ({ requestId: request.id, requestRef: refs.get(request.id) ?? reference(), epoch: request.epoch,
          holder: request.holder, settled: request.reply !== null, delegated: Boolean(request.delegatedBy) })),
      waits, notices: said.map(({ to, text: body }) => ({ noticeId: reference(), recipient: to, body })) };
    return { write, result: { status, ...(refusal === undefined ? {} : { refusal }), ...(returnedTo ? { returnedTo } : {}) } };
  };
}

/**
 * Each `norn run` or `norn 1 lib` block of a text that does not check as written, and why:
 * what whoever just wrote the text is told at once.
 */
export function nornProgramProblems(body: string): { source: string; problem: string }[] {
  const libProblems = nornLibBlocks(body).flatMap(block => {
    const tag = block.edition === undefined ? `\`\`\`norn lib ${block.name}` : `\`\`\`norn ${block.edition} lib ${block.name}`;
    if (block.problem) return [{ source: tag, problem: block.problem }];
    const loaded = loadProgramLibraries({ [block.name]: block.source });
    return loaded.refusal ? [{ source: tag, problem: loaded.refusal }] : [];
  });
  const libraries = pageSpaceLibraries(body);
  const runProblems = nornBlocks(body).flatMap(block => {
    const problem = nornBlockProblem(block, Object.keys(libraries).length ? libraries : undefined);
    return problem === undefined ? [] : [{ source: nornBlockSource(block.name, block.edition), problem }];
  });
  return [...libProblems, ...runProblems];
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
