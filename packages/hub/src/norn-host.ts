import { parseHarnessCapabilityMentions, parseMarkdown, utf8ByteLength } from "@xmatrix/protocol";
import type { NornProgramState, NornProgramWrite, NornStep } from "@xmatrix/db";
import { checkSource, elaborate, hostSources, readInterface, readLibrary, type Form, type ReportForm } from "./vendor/norn/frontend/check/index";
import { NORN_STD } from "./vendor/norn/std";
import { parse } from "./vendor/norn/frontend/parser";
import { compile, type Code } from "./vendor/norn/runtime/code";
import { emptyLedger, evaluate, occur, settle, stop, take, type Ledger, type LedgerRequest, type Reply } from "./vendor/norn/runtime/ledger";
import { eventKey, show, text, type Value } from "./vendor/norn/runtime/value";

/**
 * The xMatrix host of Norn (docs/architecture/norn-host.md): what a program
 * in a message is, how one pass over its ledger goes, and what a request
 * looks like to the Agent that holds it. Nothing here reads or writes: the
 * database layer runs `nornStep` while it holds the program's row.
 */

/**
 * The programs a text carries: its top-level fenced blocks tagged `norn run`,
 * each under the name that follows the tag (`norn run review`), or `main`.
 * A block tagged `norn` alone is only shown, and so is one inside a quote.
 */
export function nornBlocks(body: string): { name: string; source: string }[] {
  const root = parseMarkdown(body) as { children?: { type?: string; lang?: string | null; meta?: string | null; value?: string }[] };
  return (root.children ?? []).flatMap(node => {
    const [run, name, ...rest] = (node.meta ?? "").trim().split(/\s+/u);
    return node.type === "code" && node.lang === "norn" && run === "run" && !rest.length && /^\p{L}[\p{L}\p{N}_-]{0,39}$/u.test(name ?? "main")
      ? [{ name: name ?? "main", source: node.value ?? "" }] : [];
  });
}

/** The program a message starts: its one `norn run` block. */
export function nornProgramIn(body: string): { source: string } | { refusal: string } | undefined {
  const blocks = nornBlocks(body);
  if (!blocks.length) return undefined;
  return blocks.length === 1 ? { source: blocks[0]!.source } : { refusal: "A message starts one program: it has more than one `norn run` block." };
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
/** The standard library, for a program that writes `open Std`: `routine`, `decide`, `remind`, `followUp`, `schedule`, `all`. */
const STD = readLibrary(NORN_STD, "std.norn", HOST);

type Checked = { code: Code; targets: string[] } | { refusal: string };
/** Checks a program against this host: the built-ins alone, with no standard library and no facts yet. */
export function checkNornProgram(source: string): Checked {
  const checked = checkSource(source, { host: HOST, std: STD });
  const errors = checked.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (!checked.ok || !checked.program || errors.length) {
    return { refusal: errors.slice(0, 20).map(({ message, span }) => `${span.start.line}:${span.start.column} ${message}`).join("\n") };
  }
  return { code: compile(elaborate(checked.program, checked.reports), { std: STD.program, sources: SOURCES }),
    targets: [...new Set((checked.effects ?? []).flatMap(effect => effect.targets))].sort() };
}

/** A holder that names an Agent this host starts: a harness by its name, or `@auto`. */
const agentHolder = (holder: string): boolean =>
  holder === "@auto" || (!holder.includes(":") && parseHarnessCapabilityMentions(holder).length === 1);
/**
 * A holder that can only be a person: a name that is no harness and no
 * Instance address. Who that is, and whether anyone is, is known only where
 * the request is delivered: the conversation's people are read there.
 */
export const personHolder = (holder: string): boolean => holder.startsWith("@") && !holder.includes(":") && !agentHolder(holder);
/**
 * Whom this host can deliver a request to: a harness by its name or `@auto`,
 * each delivery starting a new Run of it, or a person by name. An Instance by
 * its address is not delivered to yet.
 */
const deliverable = (holder: string): boolean => agentHolder(holder) || personHolder(holder);

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

/**
 * The message that delivers a request to its holder. What the program wrote
 * is quoted as literal text, so nothing in it summons or commands anyone;
 * the only summon is the holder's own, on the first line.
 */
export function nornDeliveryBody(request: LedgerRequest, requestRef: string, to: {
  /** The Instance already there that the request goes to, by its address; without one the holder's summon starts a Run. */
  there?: string;
  /** Its Instance stays for the program's next request, instead of ending with this one. */
  kept?: boolean } = {}): string {
  const [answer, ...types] = answerText(request).split("\n");
  return [to.there ?? [request.holder, ...summonConditions(request).words, "launch:force"].join(" "), "",
    `**Request \`${requestRef}\`** from a program. Your answer goes back to the program, not to this conversation.`, "",
    fence(request.text),
    ...(request.about === null ? [] : ["", "About:", fence(request.about)]),
    ...(request.context === null ? [] : ["", "Given:", fence(request.context)]),
    "", to.kept ? "End this turn with exactly one of these, and say nothing else in the conversation. The program may ask you again here:"
      : "End this turn with exactly one of these. It ends your Run, so say nothing in the conversation and do it last:", "",
    `- \`xmatrix reply ${requestRef} '<answer>'\` when it is done. The answer must be ${answer}`,
    ...(types.length ? ["", fence(types.join("\n")), ""] : []),
    `- \`xmatrix refuse ${requestRef} '<why>'\` when you will not do it.`,
    `- \`xmatrix broke ${requestRef} '<why>'\` when you tried and could not.`,
    "", `A turn that ends without one of these is recorded as failed.${request.by === null ? "" : ` The request closes at ${new Date(request.by).toISOString()}.`}`,
  ].join("\n");
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
}
export const nornRequestCard = (request: LedgerRequest, requestRef: string, holderUserId: string): NornRequestCard => ({
  ref: requestRef, verb: request.verb, holder: request.holder, holderUserId, text: request.text, about: request.about,
  context: request.context, options: (request.options ?? []).map(show),
  by: request.by === null ? null : new Date(request.by).toISOString() });
/**
 * The same request in words, for whoever reads the conversation without the
 * card: the person's name first, so it tells them as a mention does.
 */
export function nornPersonBody(request: LedgerRequest, requestRef: string): string {
  // What is asked comes first: a list of conversations shows the start of the message, and that is what its
  // reader needs. The first line is plain words; the rest of a longer question follows as the program wrote it.
  const [first = "", ...more] = request.text.split("\n");
  return [`${request.holder} ${first.replace(/[`*_\[\]]/gu, "").trim()}`,
    ...(more.join("").trim() ? ["", fence(request.text)] : []),
    ...(request.about === null ? [] : ["", "About:", fence(request.about)]),
    ...(request.context === null ? [] : ["", "Given:", fence(request.context)]),
    "", `Answer on this card: ${answerText(request).split("\n")[0]}.${request.by === null ? "" : ` It closes at ${new Date(request.by).toISOString()}.`} A program asks (request \`${requestRef}\`).`,
  ].join("\n");
}
/** How a person's request ended, in a line under its card. */
export function nornOutcomeText(holder: string, reply: Reply): string {
  switch (reply.tag) {
    case "Answered": return `${holder} answered: ${reply.value.type === "string" ? reply.value.value : show(reply.value)}`;
    case "Refused": return `${holder} declined: ${reply.reason}`;
    case "NoReply": return "It closed without an answer.";
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

/** How a program ended, as its Channel reads it. */
export function nornEndBody(ended: Ledger["ended"]): string {
  if (!ended) return "The program ended.";
  if (ended.status === "completed") return `The program finished: ${ended.result ? show(ended.result) : "()"}`;
  return ended.error ? `The program stopped: ${ended.error}` : `The program ended without its result: ${ended.result ? show(ended.result) : "failed"}`;
}

/** How long a pass waits before trying again a program this build cannot check. */
const NORN_RECHECK_MS = 5 * 60_000;
export interface NornPassResult {
  status: "running" | "completed" | "failed";
  /** Why the answer this pass carried was not taken; absent when it settled its request. */
  refusal?: string;
}
const reference = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `r${[...bytes].map(byte => "abcdefghijkmnpqrstuvwxyz23456789"[byte % 32]).join("")}`;
};

/**
 * One pass over a program's ledger: a stop, the answer this call carries,
 * the requests nobody works on any more, then the program from the top.
 * Requests this host cannot deliver end at once, so the program reads why.
 */
export function nornStep(answer?: { requestId: string; epoch: number; reply: Reply | { typed: string } },
  /** An outside event the program waits for: the stream as the program named it, and what happened. */
  occurred?: { stream: unknown; what: string }): NornStep<NornPassResult> {
  return (state: NornProgramState) => {
    const ledger = state.ledger as Ledger;
    const now = Math.max(state.nowMs, ledger.startedAt);
    const checked = checkNornProgram(state.source);
    let refusal: string | undefined, nextDue: number | null = null, taken = false;
    // What the program says is new to the ledger in the pass that says it, so it is collected here and nowhere else.
    const said: { to: string; text: string }[] = [];
    let waits: unknown[] = [];
    // A program is checked where it is written, so text that does not check here was written for another
    // build of the Hub: one being rolled out, or one rolled back. The program is left as it is and the pass is
    // tried again later, on a build that reads it. Stopping it would end work that nothing is wrong with.
    // A stop needs no reading of the text, so it is taken either way.
    if (state.stopReason !== null) stop(ledger, now, state.stopReason);
    else if ("refusal" in checked) {
      return { write: { retryAtMs: now + NORN_RECHECK_MS }, result: { status: "running", refusal: `The program does not check on this build of the Hub yet:\n${checked.refusal}` } };
    } else {
      const asked = answer ? ledger.requests[answer.requestId] : undefined;
      if (answer && asked) {
        const read = "typed" in answer.reply ? readNornAnswer(asked, answer.reply.typed) : undefined;
        if (read && "refusal" in read) refusal = read.refusal;
        else {
          const reply: Reply = read ? { tag: "Answered", value: read.value } : answer.reply as Reply;
          taken = settle(ledger, asked.id, asked.holder, reply, now, answer.epoch);
          if (!taken) refusal = ledger.evidence.at(-1)?.reason ?? "The answer was not taken";
        }
      }
      if (occurred) occur(ledger, occurred.stream as Value, text(occurred.what), now);
      for (const row of state.requests) {
        const request = ledger.requests[row.requestId];
        if (row.abandoned && request?.reply === null && request.epoch === row.epoch) {
          settle(ledger, request.id, request.holder, { tag: "Broke", reason: personHolder(request.holder)
            ? `${request.holder} can no longer read this conversation` : "The Agent's work on this request ended without an answer" }, now, row.epoch);
        }
      }
      // Each round ends at least one request this host cannot deliver, so the rounds end.
      for (let undelivered = true; undelivered;) {
        undelivered = false;
        const pass = evaluate(checked.code, ledger, now);
        nextDue = pass.nextDue;
        // The streams a plain wait is on, and those the program's loops take from while a handler works:
        // an event on one of the latter is kept for the loop, which handles it when the round is over.
        const streams = [...(pass.waiting?.targets ?? []).flatMap(target => target.kind === "stream" ? [target.source] : []), ...pass.listening];
        waits = streams.filter((stream, index) => streams.findIndex(other => eventKey(other) === eventKey(stream)) === index);
        said.push(...pass.said);
        // A round whose handler ended in anything but an answer is told in the program's conversation, once.
        // A request the program's changed text no longer makes is called off, so nobody goes on working for a
        // program that will not read the answer: its Agent is let go, and a person's card says it is no longer asked.
        for (const left of pass.unreached) settle(ledger, left.id, left.holder, { tag: "Cancelled" }, now, left.epoch);
        for (const entry of pass.log) {
          if (entry.kind === "handlerFailed") said.push({ to: "", text: `A round of this program did not succeed: ${show(entry.reply)}` });
        }
        for (const request of Object.values(ledger.requests)) {
          if (request.reply !== null) continue;
          // One of a group takes the request for the group: the first this host can reach.
          const taker = request.candidates?.find(deliverable);
          if (taker) take(ledger, request.id, taker, now);
          const reason = !deliverable(request.holder) ? `This host cannot deliver a request to ${request.holder} yet`
            : personHolder(request.holder) && Object.keys(request.conditions ?? {}).length ? `${request.holder} is a person: conditions such as ~repo apply to an Agent`
            : (personHolder(request.holder) ? undefined : summonConditions(request).refusal)
              ?? (utf8ByteLength(nornDeliveryBody(request, reference())) > MAX_DELIVERY_BYTES ? "The request is too large to deliver in one message" : null);
          if (reason === null) continue;
          settle(ledger, request.id, request.holder, { tag: "Broke", reason }, now, request.epoch);
          undelivered = true;
        }
      }
    }
    if (answer && !taken && refusal === undefined) refusal = "The request has already ended";
    const refs = new Map(state.requests.map(row => [row.requestId, row.requestRef]));
    const status = ledger.ended ? ledger.ended.status : "running";
    const write: NornProgramWrite = { ledger, state: status, nextDueMs: ledger.ended ? null : nextDue,
      // Only requests that were or will be delivered are indexed: the rest ended in the pass that opened them.
      requests: Object.values(ledger.requests).filter(request => refs.has(request.id) || request.reply === null)
        .map(request => ({ requestId: request.id, requestRef: refs.get(request.id) ?? reference(), epoch: request.epoch,
          holder: request.holder, settled: request.reply !== null })),
      waits, notices: said.map(({ to, text: body }) => ({ noticeId: reference(), recipient: to, body })) };
    return { write, result: { status, ...(refusal === undefined ? {} : { refusal }) } };
  };
}

/**
 * Each `norn run` block of a text that does not run as written, and why:
 * what whoever just wrote the text is told at once.
 */
export function nornProgramProblems(body: string): { source: string; problem: string }[] {
  const blocks = nornBlocks(body);
  return blocks.flatMap(block => {
    const checked = blocks.filter(other => other.name === block.name).length > 1
      ? { refusal: `Two blocks are named ${block.name}; rename one.` } : checkNornProgram(block.source);
    return "refusal" in checked ? [{ source: `\`\`\`norn run ${block.name}`, problem: checked.refusal }] : [];
  });
}

/** The ledger a program starts from. */
export const nornStartLedger = (nowMs: number): Ledger => emptyLedger(nowMs);

/** An outside stream as a program named it: `ciFailed("acme/app")`, `appEvent("sentry", ~feature="issue.created")`. */
export interface NornStream { name: string; args: { type: string; value?: unknown }[]; labels: Record<string, { type: string; value?: unknown }> }

export const isNornStream = (value: unknown): value is NornStream => Boolean(value) && typeof value === "object" &&
  typeof (value as NornStream).name === "string" && Array.isArray((value as NornStream).args);
/** The text a program wrote in a stream's position or label, when it wrote text there. */
const streamText = (value: { type: string; value?: unknown } | undefined): string | undefined =>
  value?.type === "string" && typeof value.value === "string" ? value.value : undefined;

/** Which streams a GitHub event on a repository's default branch is an occurrence of. */
export const githubStream = (kind: "ci-failed" | "merged", repository: string) => (stream: NornStream): boolean =>
  stream.name === (kind === "ci-failed" ? "ciFailed" : "prMerged") && streamText(stream.args[0]) === repository;
/** Which streams a connected app's event is an occurrence of: the app, and its feature when the program named one. */
export const appStream = (provider: string, feature: string) => (stream: NornStream): boolean =>
  stream.name === "appEvent" && streamText(stream.args[0]) === provider &&
  (stream.labels?.feature === undefined || streamText(stream.labels.feature) === feature);
