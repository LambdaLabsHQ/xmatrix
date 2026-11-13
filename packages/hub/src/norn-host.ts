import { parseHarnessCapabilityMentions, parseMarkdown, utf8ByteLength } from "@xmatrix/protocol";
import type { NornProgramState, NornProgramWrite, NornStep } from "@xmatrix/db";
import { builtinInterface, checkSource, elaborate, type Form, type ReportForm } from "./vendor/norn/frontend/check/index";
import { parse } from "./vendor/norn/frontend/parser";
import { compile, type Code } from "./vendor/norn/runtime/code";
import { emptyLedger, evaluate, settle, stop, take, type Ledger, type LedgerRequest, type Reply } from "./vendor/norn/runtime/ledger";
import { show, text, type Value } from "./vendor/norn/runtime/value";

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
    return node.type === "code" && node.lang === "norn" && run === "run" && !rest.length && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u.test(name ?? "main")
      ? [{ name: name ?? "main", source: node.value ?? "" }] : [];
  });
}

/** The program a message starts: its one `norn run` block. */
export function nornProgramIn(body: string): { source: string } | { refusal: string } | undefined {
  const blocks = nornBlocks(body);
  if (!blocks.length) return undefined;
  return blocks.length === 1 ? { source: blocks[0]!.source } : { refusal: "A message starts one program: it has more than one `norn run` block." };
}

type Checked = { code: Code; targets: string[] } | { refusal: string };
/** Checks a program against this host: the built-ins alone, with no standard library and no facts yet. */
export function checkNornProgram(source: string): Checked {
  const checked = checkSource(source, { host: builtinInterface(), std: null });
  const errors = checked.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (!checked.ok || !checked.program || errors.length) {
    return { refusal: errors.slice(0, 20).map(({ message, span }) => `${span.start.line}:${span.start.column} ${message}`).join("\n") };
  }
  return { code: compile(elaborate(checked.program, checked.reports)),
    targets: [...new Set((checked.effects ?? []).flatMap(effect => effect.targets))].sort() };
}

/**
 * Whom this host can deliver a request to: a harness by its name, or `@auto`.
 * Each delivery starts a new Run of it. People, and an Instance by its
 * address, are not delivered to yet.
 */
function deliverable(holder: string): boolean {
  return holder === "@auto" || (!holder.includes(":") && parseHarnessCapabilityMentions(holder).length === 1);
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
/** Message bodies are refused above this size, so a request that cannot fit is never delivered. */
const MAX_DELIVERY_BYTES = 60 * 1024;

/** How a program ended, as its Channel reads it. */
export function nornEndBody(ended: Ledger["ended"]): string {
  if (!ended) return "The program ended.";
  if (ended.status === "completed") return `The program finished: ${ended.result ? show(ended.result) : "()"}`;
  return ended.error ? `The program stopped: ${ended.error}` : `The program ended without its result: ${ended.result ? show(ended.result) : "failed"}`;
}

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
export function nornStep(answer?: { requestId: string; epoch: number; reply: Reply | { typed: string } }): NornStep<NornPassResult> {
  return (state: NornProgramState) => {
    const ledger = state.ledger as Ledger;
    const now = Math.max(state.nowMs, ledger.startedAt);
    const checked = checkNornProgram(state.source);
    let refusal: string | undefined, nextDue: number | null = null, taken = false;
    // What the program says is new to the ledger in the pass that says it, so it is collected here and nowhere else.
    const said: { to: string; text: string }[] = [];
    if ("refusal" in checked) stop(ledger, now, `The program no longer checks: ${checked.refusal}`);
    else if (state.stopReason !== null) stop(ledger, now, state.stopReason);
    else {
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
      for (const row of state.requests) {
        const request = ledger.requests[row.requestId];
        if (row.abandoned && request?.reply === null && request.epoch === row.epoch) {
          settle(ledger, request.id, request.holder, { tag: "Broke", reason: "The Agent's work on this request ended without an answer" }, now, row.epoch);
        }
      }
      // Each round ends at least one request this host cannot deliver, so the rounds end.
      for (let undelivered = true; undelivered;) {
        undelivered = false;
        const pass = evaluate(checked.code, ledger, now);
        nextDue = pass.nextDue;
        said.push(...pass.said);
        for (const request of Object.values(ledger.requests)) {
          if (request.reply !== null) continue;
          // One of a group takes the request for the group: the first this host can reach.
          const taker = request.candidates?.find(deliverable);
          if (taker) take(ledger, request.id, taker, now);
          const reason = !deliverable(request.holder) ? `This host cannot deliver a request to ${request.holder} yet`
            : summonConditions(request).refusal
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
      notices: said.map(({ to, text: body }) => ({ noticeId: reference(), recipient: to, body })) };
    return { write, result: { status, ...(refusal === undefined ? {} : { refusal }) } };
  };
}

/** The ledger a program starts from. */
export const nornStartLedger = (nowMs: number): Ledger => emptyLedger(nowMs);
