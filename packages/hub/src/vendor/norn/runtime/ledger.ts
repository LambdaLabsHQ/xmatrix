// Vendored from norn-lang/norn@b082e26527d15f8d5e316326da0d613c6c031405; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
// The ledger is the only durable state (spec §9, §11). A program keeps no
// snapshot: every pass evaluates it from the top against the ledger and
// reports which requests should exist now. Nothing here dispatches anything.
import type { ReportForm } from "../frontend/check/forms.js";
import type { Code } from "./code.js";
import { mismatch } from "./form.js";
import { advance, resume, start, type Effect } from "./machine.js";
import { sha256 } from "./sha256.js";
import { equal, eventKey, show, text, unit, variant, type Json, type Value } from "./value.js";

export type Reply =
  | { tag: "Answered"; value: Value }
  | { tag: "Refused" | "Broke"; reason: string }
  | { tag: "NoReply" | "Cancelled" | "Revoked" };

export interface LedgerRequest {
  id: string;
  verb: string;
  holder: string;
  /** For a request offered to a group with `anyOf`: who may take it. Null once taken, and for a request to one participant. */
  candidates: string[] | null;
  epoch: number;
  text: string;
  /**
   * What the program asked of whoever takes the request, beyond their name: the
   * participant's own labels, as in `@auto(~repo="acme/app")`, each as a message
   * shows it. A host reads them when it chooses or starts the participant.
   */
  conditions: Record<string, string>;
  /** What the request is about (`~about`), as a message shows it; null when the program named nothing. */
  about: string | null;
  /** What a `run` was given to work from (`~context`), as a message shows it. */
  context: string | null;
  /** What `choose` offers; null for every other verb. */
  options: Value[] | null;
  /** What a `run` must report, when the checker decided it (docs/types.md §5a); null means the host's report. */
  form: ReportForm | null;
  by: number | null;
  openedAt: number;
  reply: Reply | null;
  settledAt: number | null;
  /** Open, and no longer reached by the program after an edit. Never cancelled implicitly. */
  detached: boolean;
}
/** Everything else a program consumed: when a wait began, how it ended, what was said, what a status read saw. */
export interface Entry { at: number; value: Json }
export interface Ledger {
  startedAt: number;
  requests: Record<string, LedgerRequest>;
  entries: Record<string, Entry>;
  /** Facts hold once and stay true. */
  facts: Record<string, { at: number; value: Value }>;
  /** Stream occurrences in the order the ledger recorded them; a wait takes the first one after its own beginning. */
  occurrences: { key: string; at: number; value: Value }[];
  /** Answers that settled nothing: late, from a former holder, or outside the request's form. */
  evidence: { request: string; holder: string; at: number; reply: Reply; reason: string }[];
  /** The program's result, recorded once with the cancellation of what it left open. A later pass returns it and evaluates nothing. */
  ended: { at: number; status: "completed" | "failed"; result: Value | null; error: string | null } | null;
}
export const emptyLedger = (startedAt = 0): Ledger => ({ startedAt, requests: {}, entries: {}, facts: {}, occurrences: [], evidence: [], ended: null });

type Source = Extract<Value, { type: "source" }>;
/** The `First`/`Second` constructors an `or` puts around a value, outermost first. */
type Path = ("First" | "Second")[];
/** One thing a wait is for. */
export type Target =
  | { kind: "request"; id: string }
  | { kind: "fact" | "stream"; source: Source; path: Path }
  | { kind: "timer"; at: number; path: Path };
export interface Waiting { targets: Target[]; until: number | null }

/** What a pass did that the ledger did not hold yet. */
export type Step =
  /** The request as it was opened. */
  | { kind: "opened"; request: LedgerRequest }
  | { kind: "handedOver"; id: string; from: string; to: string }
  /** A request ended by something other than its holder: `cancel`, the program's end, lost authority, or a `~by` already past. */
  | { kind: "closed"; id: string; reply: Reply }
  | { kind: "said"; to: string; text: string }
  | ({ kind: "waiting" } & Waiting)
  /** A wait ended at `at`, with `value`; null when its own deadline came first. */
  | ({ kind: "waited"; at: number; value: Value | null } & Waiting)
  /** A `forEach` handler ended with a reply other than `Answered`: the author is told and the duty goes on. */
  | { kind: "handlerFailed"; reply: Value };

export interface Pass {
  status: "waiting" | "completed" | "failed";
  result: Value | null;
  error: string | null;
  /** Everything new, in the order the program reached it. The lists below are views of it. */
  log: Step[];
  /** Requests this pass opened. */
  opened: LedgerRequest[];
  /** Open requests the program does not reach any more: the author decides, the runtime never guesses. */
  unreached: LedgerRequest[];
  /** Requests the program itself ended: `cancel`, or the program finished. */
  cancelled: string[];
  /** Requests whose deadline the program text moved. */
  rescheduled: { id: string; from: number | null; to: number | null }[];
  said: { to: string; text: string }[];
  /** The wait the pass stopped at. */
  waiting: Waiting | null;
  /** The earliest time at which another pass could make progress with no new reply or fact. */
  nextDue: number | null;
}
export interface PassOptions {
  /** False gives the preview of spec §11.2: the ledger is left untouched. */
  commit?: boolean;
  /** How long a pass may compute without reaching a wait. */
  steps?: number;
  /**
   * The author's current authority for an effect the ledger does not hold yet
   * (spec §10). Without it, a waited request ends `Revoked` and anything else
   * ends the program `Revoked`. Left out, the host vouches for the whole pass.
   */
  authorize?: (effect: Effect) => boolean;
}

/** The program's own mistake, found at an effect: it ends the program as a program failure and is never a reply. */
class ProgramError extends Error {}

const VERBS = ["ask", "confirm", "choose", "run", "judge"];
const LABELS: Record<string, string[]> = {
  ask: ["by", "about"], confirm: ["by", "about"], choose: ["by", "about"], run: ["context", "by", "about", "form"], judge: ["about"],
  wait: [], waitUntil: [], cancel: [], handOver: [], status: [], say: [], first: [],
};

const replyValue = (reply: Reply): Value =>
  reply.tag === "Answered" ? variant("Answered", reply.value)
    : reply.tag === "Refused" || reply.tag === "Broke" ? variant(reply.tag, text(reply.reason)) : variant(reply.tag);

function instant(value: Value | undefined, from: number): number | null {
  if (!value) return null;
  if (value.type !== "time" && value.type !== "duration") throw new ProgramError("A deadline needs a time or a duration");
  const at = Number(value.value) + (value.type === "duration" ? from : 0);
  if (!Number.isSafeInteger(at) || at < 0) throw new ProgramError("A deadline lies outside the clock's range");
  return at;
}
function participant(value: Value | undefined): string {
  if (value?.type !== "participant") throw new ProgramError("Expected a participant");
  return show(value);
}
function external(source: Value, kind: "fact" | "stream", verb: string): string {
  if (source.type !== "source" || source.kind !== kind || ["or", "never", "after", "every", "map", "filter"].includes(source.name)) {
    throw new Error(`${verb} needs a ${kind} of the host, not a timer or a composition`);
  }
  return eventKey(source);
}

/** The ledger's own clock closes requests whose `~by` has passed; no program does. Returns the requests it closed. */
export function settleDue(ledger: Ledger, now: number): LedgerRequest[] {
  const closed: LedgerRequest[] = [];
  for (const request of Object.values(ledger.requests)) {
    if (request.reply === null && request.by !== null && request.by <= now) {
      request.reply = { tag: "NoReply" }; request.settledAt = request.by; closed.push(request);
    }
  }
  return closed;
}
/** The first valid answer from the current holder settles a request; anything else is kept as evidence. */
/**
 * `epoch` is the one the answer was given under. A host passes it so that an
 * answer from an earlier holding does not count after the request has come
 * back to the same participant.
 */
export function settle(ledger: Ledger, id: string, holder: string, reply: Reply, now: number, epoch?: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request) return false;
  // An answer from one of a group takes the request for them in the same step.
  if (request.reply === null && request.candidates?.includes(holder) && (epoch === undefined || epoch === request.epoch) && formError(request, reply) === null) {
    take(ledger, id, holder, now);
    epoch = request.epoch;
  }
  const reason = request.reply !== null ? "The request has already ended"
    : request.holder !== holder || (epoch !== undefined && epoch !== request.epoch) ? "Not the request's holder" : formError(request, reply);
  if (reason !== null) { ledger.evidence.push({ request: id, holder, at: now, reply, reason }); return false; }
  request.reply = reply; request.settledAt = now;
  return true;
}
function formError(request: LedgerRequest, reply: Reply): string | null {
  if (reply.tag === "NoReply") return "NoReply is decided only by the ledger's clock";
  if (reply.tag !== "Answered") return null;
  const answer = reply.value;
  switch (request.verb) {
    case "ask": return answer.type === "string" ? null : "The answer must be text";
    case "confirm": return answer.type === "variant" && ["Yes", "No"].includes(answer.name) && !answer.args.length ? null : "The answer must be Yes or No";
    case "choose": return request.options!.some(option => equal(option, answer)) ? null : "The answer is not one of the options";
    case "judge": return answer.type === "bool" ? null : "A judgement must be true or false";
    default:
      if (request.form === null) return answer.type === "record" && answer.fields.text?.type === "string" ? null : "A report must be a record with text";
      return mismatch(answer, request.form) === null ? null : `The report must be ${request.form.text}: ${mismatch(answer, request.form)}`;
  }
}
/** One of a group takes a request offered with `anyOf`: from then on it has exactly that holder. False when someone else has it. */
export function take(ledger: Ledger, id: string, taker: string, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request || request.reply !== null || !request.candidates?.includes(taker)) return false;
  request.holder = taker; request.candidates = null; request.epoch++;
  return true;
}
function conditionsOf(who: Value | undefined): Record<string, string> {
  if (who?.type !== "participant" || who.name === "anyOf") return {};
  return Object.fromEntries(Object.entries(who.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, value]) => [label, show(value)]));
}
function candidatesOf(who: Value): string[] | null {
  if (who.type !== "participant" || who.name !== "anyOf") return null;
  const except = who.labels.except ? show(who.labels.except) : null;
  const group = (who.labels.of as Extract<Value, { type: "list" | "tuple" }>).values.map(show).filter(name => name !== except);
  if (!group.length) throw new ProgramError("anyOf leaves nobody to take the request");
  return [...new Set(group)];
}
/**
 * Whoever may stop the program stops it from outside: what it left open is
 * cancelled and it ends failed, in one step. Returns the requests it closed;
 * a program that has already ended keeps its result.
 */
export function stop(ledger: Ledger, now: number, reason: string): LedgerRequest[] {
  if (ledger.ended) return [];
  settleDue(ledger, now);
  const closed = Object.values(ledger.requests).filter(request => request.reply === null);
  for (const request of closed) { request.reply = { tag: "Cancelled" }; request.settledAt = now; }
  ledger.ended = { at: now, status: "failed", result: null, error: reason };
  return closed;
}
export function establish(ledger: Ledger, fact: Value, value: Value, now: number): void {
  ledger.facts[external(fact, "fact", "establish")] ??= { at: now, value };
}
export function occur(ledger: Ledger, stream: Value, value: Value, now: number): void {
  ledger.occurrences.push({ key: external(stream, "stream", "occur"), at: now, value });
}

/** What a wait is for, with `or` flattened left to right. A timer counts from when the wait began. */
function targetsOf(ledger: Ledger, waited: Value, began: number): Target[] {
  const targets: Target[] = [];
  const pending: { source: Value; path: Path }[] = [{ source: waited, path: [] }];
  while (pending.length) {
    const { source, path } = pending.pop()!;
    if (source.type === "request") {
      if (!ledger.requests[source.id]) throw new ProgramError("wait needs a request of this program");
      targets.push({ kind: "request", id: source.id });
    } else if (source.type !== "source") throw new ProgramError("wait needs a request, a fact or a stream");
    else if (source.name === "or") pending.push({ source: source.args[1], path: [...path, "Second"] }, { source: source.args[0], path: [...path, "First"] });
    else if (source.name === "map" || source.name === "filter") throw new ProgramError("Stream map/filter are not implemented by the reference host yet");
    else if (source.name === "after" || source.name === "every") {
      if (source.args.length !== 1 || Object.keys(source.labels).length) throw new ProgramError("A timer needs one positional argument");
      const when = source.args[0];
      if (!(source.name === "after" && when.type === "time") && (when.type !== "duration" || BigInt(when.value) <= 0n)) throw new ProgramError("A relative timer needs a positive duration");
      // `after` counts from when the wait began. `every` keeps the program's beat: its ticks fall a whole number
      // of periods after the program started, so work between two waits does not push the next tick back, and
      // ticks that passed while it worked are not made up.
      const period = source.name === "every" ? Number(when.value) : 0;
      const at = period > 0 ? ledger.startedAt + (Math.floor((began - ledger.startedAt) / period) + 1) * period : instant(when, began)!;
      if (!Number.isSafeInteger(at)) throw new ProgramError("A deadline lies outside the clock's range");
      targets.push({ kind: "timer", at, path });
    } else if (source.name !== "never") targets.push({ kind: source.kind, source, path });
  }
  return targets;
}

/** At one instant a request's own deadline comes first, then the wait's, then any other reply or occurrence. */
interface Candidate { at: number; value: Value; rank: 0 | 1 | 2 }

/**
 * One pass, yielding between slices of pure computation so a host can give
 * other work a turn. The ledger is read when the pass starts and written only
 * when it finishes, so it must not change in between; a pass that throws or is
 * abandoned leaves it as it was.
 */
export function* slices(code: Code, source: Ledger, now: number, options: PassOptions = {}): Generator<undefined, Pass> {
  const pass: Pass = { status: "waiting", result: null, error: null, log: [], opened: [], unreached: [], cancelled: [], rescheduled: [], said: [], waiting: null, nextDue: null };
  if (source.ended) return { ...pass, status: source.ended.status, result: source.ended.result, error: source.ended.error };
  const ledger = structuredClone(source), log = pass.log;
  settleDue(ledger, now);
  const seen = new Map<string, number>();
  // Identity: what is asked of whom, counted in evaluation order among identical contents.
  const identity = (kind: string, content: unknown): string => {
    const digest = sha256(eventKey(content as Value)).slice(0, 16);
    const ordinal = (seen.get(kind + digest) ?? 0) + 1;
    seen.set(kind + digest, ordinal);
    return `${kind}:${digest}#${ordinal}`;
  };
  const entry = (key: string, make: () => Entry): Entry => ledger.entries[key] ??= make();
  const reached = new Set<string>();
  const due = (at: number): void => { if (at > now && (pass.nextDue === null || at < pass.nextDue)) pass.nextDue = at; };
  const end = (status: "completed" | "failed", result: Value | null, error: string | null): null => {
    pass.status = status; pass.result = result; pass.error = error;
    return null;
  };
  const close = (request: LedgerRequest, reply: Reply, at: number): void => {
    request.reply = reply; request.settledAt = at; log.push({ kind: "closed", id: request.id, reply });
  };
  const handle = (name: string, value: Value | undefined): LedgerRequest => {
    const request = value?.type === "request" ? ledger.requests[value.id] : undefined;
    if (!request) throw new ProgramError(`${name} needs a request of this program`);
    return request;
  };

  /** Answers one effect from the ledger, recording it first when it is new. Null: the pass stops here, waiting or ended. */
  const answer = (effect: Effect): { value: Value; at: number } | null => {
    const { name, args, labels } = effect;
    for (const label of Object.keys(labels)) if (!LABELS[name]?.includes(label)) throw new ProgramError(`Unknown ${name} label ${label}`);
    // Authority is asked only for what the ledger does not hold yet: what is recorded has happened.
    const permitted = (): boolean => options.authorize?.(effect) ?? true;
    const revoked = (): null => end("failed", variant("Revoked"), null);

    if (VERBS.includes(name)) {
      const holder = name === "judge" ? "@judge" : participant(args[0]);
      const question = name === "judge" ? args[0] : args[1];
      if (args.length !== (name === "judge" ? 1 : name === "choose" ? 3 : 2) || question?.type !== "string") {
        throw new ProgramError(name === "judge" ? "judge needs a condition string" : `${name} needs a participant and text${name === "choose" ? ", and its options" : ""}`);
      }
      const choices = name === "choose" ? args[2] : null;
      if (choices && (choices.type !== "list" || !choices.values.length || choices.values.some(v => v.type !== "variant"))) {
        throw new ProgramError("choose options must be a nonempty list of constructors");
      }
      const { by: _by, ...kept } = labels;
      // The participant's own arguments count: @auto(~repo="a") and @auto(~repo="b") are asked different things.
      const id = identity("request", { name, who: name === "judge" ? null : args[0], args: args.slice(name === "judge" ? 0 : 1), labels: kept });
      reached.add(id);
      let request = ledger.requests[id];
      if (!request) {
        if (!permitted()) return revoked();
        request = ledger.requests[id] = {
          id, verb: name, holder, candidates: name === "judge" ? null : candidatesOf(args[0]), epoch: 0, text: question.value,
          conditions: conditionsOf(args[0]),
          about: labels.about ? show(labels.about) : null, context: labels.context ? show(labels.context) : null,
          options: choices?.type === "list" ? choices.values : null,
          form: labels.form?.type === "string" ? JSON.parse(labels.form.value) as ReportForm : null,
          by: instant(labels.by, now), openedAt: now, reply: null, settledAt: null, detached: false,
        };
        log.push({ kind: "opened", request: { ...request } });
      } else if (request.reply === null) {
        // The deadline is not part of who is asked what: moving it amends the same request.
        const by = instant(labels.by, request.openedAt);
        if (by !== request.by) { pass.rescheduled.push({ id, from: request.by, to: by }); request.by = by; }
        request.detached = false;
      }
      // A deadline already reached when it is recorded has passed: no later scan is needed to say so.
      if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
      return { value: { type: "request", id }, at: request.openedAt };
    }

    if (name === "wait" || name === "waitUntil") {
      if (args.length !== (name === "waitUntil" ? 2 : 1)) throw new ProgramError(`${name} needs a target${name === "waitUntil" ? " and a positional deadline" : ""}`);
      const key = identity("wait", { target: args[0], until: args[1] ?? null });
      const fresh = !ledger.entries[`${key}/began`];
      const beginning = entry(`${key}/began`, () => ({ at: now, value: ledger.occurrences.length }));
      const began = beginning.at, cursor = beginning.value as number;
      let ended = ledger.entries[key];
      if (!ended) {
        const targets = targetsOf(ledger, args[0], began);
        const until = name === "waitUntil" ? instant(args[1], began)! : null;
        const lost = !permitted();
        // Without authority nothing can be observed: a wait on a fact or a stream ends the program.
        if (lost && args[0].type !== "request") return revoked();
        if (fresh) log.push({ kind: "waiting", targets, until });
        const candidates: Candidate[] = [];
        const occurred = (at: number, value: Value, path: Path, rank: 0 | 2 = 2): void => {
          if (at <= now) candidates.push({ at, value: path.reduceRight((inner, side) => variant(side, inner), value), rank });
          else due(at);
        };
        for (const target of targets) {
          if (target.kind === "request") {
            const request = ledger.requests[target.id];
            if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
            if (request.reply) occurred(request.settledAt!, replyValue(request.reply), [], request.reply.tag === "NoReply" ? 0 : 2);
            else if (request.by !== null) due(request.by);
          } else if (target.kind === "timer") occurred(target.at, { type: "time", value: String(target.at) }, target.path);
          else if (target.kind === "fact") {
            const fact = ledger.facts[eventKey(target.source)];
            if (fact) occurred(Math.max(fact.at, began), fact.value, target.path); // A fact may already hold.
          } else {
            const stream = eventKey(target.source);
            const next = ledger.occurrences.find((occurrence, index) => index >= cursor && occurrence.key === stream);
            if (next) occurred(next.at, next.value, target.path);
          }
        }
        if (until !== null) { if (until <= now) candidates.push({ at: until, value: unit, rank: 1 }); else due(until); }
        candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
        const winner = candidates[0];
        if (!winner) { pass.waiting = { targets, until }; return null; } // Nothing has happened yet: this is all "waiting" means.
        const elapsed = winner.rank === 1;
        const value = name === "waitUntil" ? (elapsed ? variant("None") : variant("Some", winner.value)) : winner.value;
        ended = ledger.entries[key] = { at: winner.at, value: value as unknown as Json };
        log.push({ kind: "waited", targets, until, at: winner.at, value: elapsed ? null : winner.value });
      }
      return { value: ended.value as unknown as Value, at: Math.max(ended.at, began) };
    }

    if (name === "first") {
      const list = args[0];
      if (args.length !== 1 || list.type !== "list" || !list.values.length) throw new ProgramError("first needs a nonempty list of requests");
      const requests = list.values.map(value => handle(name, value));
      const key = identity("first", { ids: requests.map(request => request.id) });
      let won = ledger.entries[key];
      if (!won) {
        const lost = !permitted();
        for (const request of requests) if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
        // The earliest reply wins; at one instant, the request written first.
        const ended = requests.filter(request => request.reply !== null && request.settledAt! <= now).sort((a, b) => a.settledAt! - b.settledAt!);
        if (!ended.length) {
          for (const request of requests) if (request.by !== null) due(request.by);
          pass.waiting = { targets: requests.map(request => ({ kind: "request", id: request.id })), until: null };
          return null;
        }
        won = ledger.entries[key] = { at: ended[0].settledAt!, value: ended[0].id };
      }
      const winner = ledger.requests[won.value as string];
      return { value: { type: "tuple", values: [{ type: "request", id: winner.id }, replyValue(winner.reply!)] }, at: Math.max(won.at, ledger.startedAt) };
    }

    if (name === "say") {
      if (args.length !== 2 || !["participant", "ref"].includes(args[0].type) || args[1].type !== "string") throw new ProgramError("say needs a participant or a reference, and text");
      const to = show(args[0]), body = args[1].value;
      const key = identity("say", { to, body });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        log.push({ kind: "said", to, text: body });
      }
      return { value: unit, at: entry(key, () => ({ at: now, value: null })).at };
    }
    if (name === "status") {
      if (args.length !== 1) throw new ProgramError("status needs one request");
      const request = handle(name, args[0]), key = identity("status", { id: request.id });
      if (!ledger.entries[key] && !permitted()) return revoked();
      const read = entry(key, () => ({ at: now, value: (request.reply ? variant("Some", replyValue(request.reply)) : variant("None")) as unknown as Json }));
      return { value: read.value as unknown as Value, at: read.at };
    }
    if (name === "cancel" || name === "handOver") {
      if (args.length !== (name === "handOver" ? 2 : 1)) throw new ProgramError(`${name} needs a request${name === "handOver" ? " and its next holder" : ""}`);
      const request = handle(name, args[0]), next = name === "handOver" ? participant(args[1]) : null;
      const key = identity(name, { id: request.id, next });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        // On a request that has already ended both do nothing; the earlier reply stands.
        if (request.reply === null && next === null) close(request, { tag: "Cancelled" }, now);
        else if (request.reply === null) {
          log.push({ kind: "handedOver", id: request.id, from: request.holder, to: next! });
          request.holder = next!; request.candidates = candidatesOf(args[1]); request.conditions = conditionsOf(args[1]); request.epoch++;
        }
      }
      const at = entry(key, () => ({ at: now, value: null })).at;
      return { value: next === null ? unit : { type: "request", id: request.id }, at };
    }
    throw new Error(`The ledger runtime does not implement the effect ${name}`);
  };

  const machine = start(code, ledger.startedAt);
  // A pass that never reaches a wait is a bug in the program; it fails in the open instead of spinning.
  let budget = Math.ceil((options.steps ?? 5_000_000) / 10_000);
  for (;;) {
    advance(code, machine, 10_000);
    const control = machine.control;
    if (control.kind === "done") { end("completed", control.value, null); break; }
    if (control.kind === "error") { end("failed", null, control.message); break; }
    if (control.kind === "failed") { end("failed", control.outcome, null); break; }
    if (control.kind === "report") {
      const key = identity("report", control.outcome);
      if (!ledger.entries[key]) log.push({ kind: "handlerFailed", reply: control.outcome });
      resume(machine, unit, entry(key, () => ({ at: now, value: control.outcome as unknown as Json })).at); continue;
    }
    if (control.kind !== "effect") {
      // The slice ran out. Only whole slices count, so replaying a long history of effects costs none of the budget.
      if (--budget <= 0) { end("failed", null, "The program computed for too long without waiting or finishing"); break; }
      yield; continue;
    }
    let resumption: { value: Value; at: number } | null;
    try { resumption = answer(control.effect); } catch (error) {
      if (!(error instanceof ProgramError)) throw error;
      end("failed", null, error.message); break;
    }
    if (!resumption) break;
    resume(machine, resumption.value, resumption.at);
  }

  for (const request of Object.values(ledger.requests)) {
    if (request.reply !== null) continue;
    // Ending a program cancels what it left open, in the same commit that records its result.
    if (pass.status !== "waiting") close(request, { tag: "Cancelled" }, now);
    else if (!reached.has(request.id)) { request.detached = true; pass.unreached.push(request); }
  }
  if (pass.status !== "waiting") ledger.ended = { at: now, status: pass.status, result: pass.result, error: pass.error };
  for (const step of log) {
    if (step.kind === "opened") pass.opened.push(step.request);
    else if (step.kind === "said") pass.said.push({ to: step.to, text: step.text });
    else if (step.kind === "closed" && step.reply.tag === "Cancelled") pass.cancelled.push(step.id);
  }
  if (options.commit ?? true) Object.assign(source, ledger);
  return pass;
}

/**
 * One pass. With `commit: false` the ledger is left untouched and the result is
 * the difference the pass would make: the preview shown before an edit applies.
 */
export function evaluate(code: Code, ledger: Ledger, now: number, options: PassOptions = {}): Pass {
  const pass = slices(code, ledger, now, options);
  for (;;) {
    const slice = pass.next();
    if (slice.done) return slice.value;
  }
}
