// Vendored from norn-lang/norn@8a2e680fa215444fb94b023bf7c1f0e976af4631; Apache-2.0. Regenerate with scripts/vendor-norn-core.mjs.
// The ledger is the only durable state (spec §9, §11). A program keeps no
// snapshot: every pass evaluates it from the top against the ledger and
// reports which requests should exist now. Nothing here dispatches anything.
import type { ReportForm } from "../frontend/check/forms.js";
import type { Code } from "./code.js";
import { mismatch, mismatchAll, type FormPathError } from "./form.js";
import { advance, resume, resumeThrough, runPure, runPureArgs, start, startClosure, type Effect, type Machine, type Through } from "./machine.js";
import { sha256 } from "./sha256.js";
import { equal, eventKey, show, text, unit, variant, type Json, type Value } from "./value.js";

export type Reply =
  | { tag: "Answered"; value: Value }
  | { tag: "Refused" | "Broke"; reason: string }
  | { tag: "NoReply" | "Cancelled" | "Revoked" };

export interface LedgerRequest {
  id: string;
  /**
   * Scoped pass-lookup address (identityScheme 2). Separate from the immutable
   * opaque `id` so renames via `moves` and legacy migrations never break
   * external references, cards, or holder epochs. Absent on legacy v1 requests,
   * where `id` itself serves as the lookup address.
   */
  address?: string;
  /**
   * Digest of the terms a keyed request put to its holder (text, options,
   * participant, `~about`, `~context`, `form`). An answer holds only for the
   * terms it answered: when the program asks the same `~key` on other terms,
   * this request is superseded and a new one is opened.
   */
  terms?: string;
  /** The scope path the request was asked in (`root`, or a loop, round and spawn path): its branch, for hosts that group by it. */
  scope?: string;
  verb: string;
  holder: string;
  /** For a request offered to a group with `anyOf`: who may take it. Null once taken, and for a request to one participant. */
  candidates: string[] | null;
  /** Original candidate pool when offered via `anyOf`, retained so `release()` can return the request to the group. */
  initialCandidates?: string[] | null;
  /** Original group holder string (e.g. `anyOf([...])`) retained for `release()`. */
  initialGroupHolder?: string | null;
  /** Timestamp when a participant took or started the request (or answered it directly); backs `taken(r)`. */
  takenAt?: number | null;
  /** IDs of sub-requests opened with `~about=thisRequest` (visible dependency tracking). */
  waitingOn?: string[];
  /** Explicit host-recorded delivery failure (never silently collapsed into `NoReply`). */
  undelivered?: { at: number; reason: string } | null;
  /** Provenance: who/which scope opened this request. */
  openedBy?: string;
  /** For a `spawn` child task handle: the scope prefix owned by this child task. */
  spawnScope?: string | null;
  /** If opened inside a `spawn` child task, the parent `spawn` request ID (auto-cancelled when that task ends). */
  spawnOwner?: string | null;
  /**
   * Who may never hold the request: the `~except` of the group it was offered
   * to. It stays after one of the group takes the request, and the holder
   * cannot delegate the request to anyone it names. A ledger written before
   * delegation existed lacks it, which means nobody.
   */
  excluded: string[];
  /**
   * While the request is delegated (spec §7): the holder who delegated it,
   * whom it goes back to when the delegate refuses it or cannot do it, and
   * who can take it back. Once the delegate has answered it still names on
   * whose behalf they answered. Null, or missing in a ledger written before
   * delegation existed, when nobody has delegated the request.
   */
  delegatedBy: string | null;
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
  /**
   * For a request of the host itself (`Actions.prepare`, `Actions.perform`,
   * spec §6.3): the connected app and its action. A `prepare` holds the input
   * it fixed; a `perform` names the `prepare` request whose answer it does.
   * Absent on every request of a participant.
   */
  action?: { app: string; name: string; input: Value | null; prepared: string | null };
  by: number | null;
  openedAt: number;
  reply: Reply | null;
  settledAt: number | null;
  /** Open, and no longer reached by the program after an edit. Never cancelled implicitly. */
  detached: boolean;
}
/** Everything else a program consumed: when a wait began, how it ended, what was said, what a status read saw. */
export interface Entry { at: number; value: Json }
/** An explicit address rebinding recorded so a renamed scope or request keeps its immutable `id`. */
export interface MovedAddress { from: string; to: string; at: number }
export interface Ledger {
  /**
   * Identity scheme version:
   * - absent or `1`: legacy positional/stream-hash scheme (kept readable for unmigrated ledgers)
   * - `2`: three-layer scoped identity (`~key` + occurrence-keyed rounds + sealed rounds + `form` out of identity)
   */
  identityScheme?: 1 | 2;
  /**
   * Set on ledgers started since request addresses became unique within a
   * scope: two requests at one address are then a program error. A ledger
   * without it keeps numbering repeats (`#2`, `#3`) so programs already
   * running go on, and every pass reports the repeats in `duplicateAddresses`.
   */
  uniqueAddresses?: true;
  startedAt: number;
  requests: Record<string, LedgerRequest>;
  entries: Record<string, Entry>;
  /** Facts hold once and stay true. */
  facts: Record<string, { at: number; value: Value }>;
  /**
   * What holds now, by `Holds.kind` and the id of what it holds for
   * (`interfaces/holds.norn`). The host keeps it current with `hold`; a
   * program reads it only through `Holds.sample`, which records what it read.
   */
  holds?: Record<string, Record<string, { at: number; value: Value }>>;
  /** Stream occurrences in the order the ledger recorded them; a wait takes the first one after its own beginning. */
  occurrences: { key: string; at: number; value: Value }[];
  /** Answers that settled nothing: late, from a former holder, or outside the request's form. */
  evidence: { request: string; holder: string; at: number; reply: Reply; reason: string }[];
  /** Every change of holder a participant made, in order; a ledger written before delegation existed lacks it. */
  delegations: Delegation[];
  /** Explicit address rebindings so renamed loops or requests continue existing ledger entries. */
  moves?: MovedAddress[];
  /** CloudEvents `(app, kind, source, id)` deduplication map (key -> receivedAt ms). */
  seenEvents?: Record<string, number>;
  /** Structured path errors recorded when an incoming CloudEvent payload failed form validation. */
  eventErrors?: { at: number; app: string; kind: string; source: string; id: string; errors: FormPathError[] }[];
  /** Per-request free-text notes appended by `say(r, text)` or `addNote()`, feeding `r->notes`. */
  requestNotes?: Record<string, { at: number; author: string; text: string }[]>;
  /** The program's result, recorded once with the cancellation of what it left open. A later pass returns it and evaluates nothing. */
  ended: { at: number; status: "completed" | "failed"; result: Value | null; error: string | null } | null;
}

/** A CloudEvents 1.0.2 event delivered into a ledger via the `Events` standard capability interface. */
export interface CloudEventInput {
  specversion?: string;
  app: string;
  kind: string;
  source: string;
  id: string;
  occurredAt?: number | null;
  subject?: string | null;
  data: Value;
}

export interface EventDeliveryResult {
  delivered: boolean;
  deduplicated: boolean;
  errors?: FormPathError[];
}

/**
 * Delivers one CloudEvents 1.0.2 event into the ledger for any `Events.events`
 * listeners: deduplicates idempotently by `(app, kind, source, id)`, records
 * `receivedAt = now` with optional `occurredAt` and `subject`, validates payload
 * against `form` when provided (ignoring extra fields and recording structured
 * path errors instead of silently dropping), and appends matching stream occurrences.
 */
export function deliverEvent(
  ledger: Ledger,
  event: CloudEventInput,
  now: number,
  options: { form?: ReportForm; matchSources?: readonly Value[] } = {},
): EventDeliveryResult {
  const dedupKey = `${event.app}:${event.kind}:${event.source}:${event.id}`;
  ledger.seenEvents ??= {};
  if (Object.hasOwn(ledger.seenEvents, dedupKey)) {
    return { delivered: false, deduplicated: true };
  }
  if (options.form) {
    const errors = mismatchAll(event.data, options.form, { ignoreExtraFields: true });
    if (errors.length > 0) {
      ledger.seenEvents[dedupKey] = now;
      (ledger.eventErrors ??= []).push({ at: now, app: event.app, kind: event.kind, source: event.source, id: event.id, errors });
      return { delivered: false, deduplicated: false, errors };
    }
  }
  ledger.seenEvents[dedupKey] = now;
  const envelope: Value = {
    type: "record",
    fields: {
      specversion: text(event.specversion ?? "1.0"),
      kind: text(event.kind),
      source: text(event.source),
      id: text(event.id),
      occurredAt: event.occurredAt != null ? variant("Some", { type: "time", value: String(event.occurredAt) }) : variant("None"),
      subject: event.subject != null ? variant("Some", text(event.subject)) : variant("None"),
      receivedAt: { type: "time", value: String(now) },
      data: event.data,
    },
  };
  const kindVal = variant("EventKind", text(event.app), text(event.kind));
  const shapes: Value[] = [
    { type: "source", kind: "stream", name: "Events.events", args: [kindVal], labels: {} },
    { type: "source", kind: "stream", name: "Events.events", args: [kindVal], labels: { source: text(event.source) } },
    ...(event.subject != null ? [
      { type: "source", kind: "stream", name: "Events.events", args: [kindVal], labels: { subject: text(event.subject) } } as Value,
      { type: "source", kind: "stream", name: "Events.events", args: [kindVal], labels: { source: text(event.source), subject: text(event.subject) } } as Value,
    ] : []),
  ];
  const seenKeys = new Set<string>();
  for (const src of options.matchSources ?? shapes) {
    const key = eventKey(src);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    ledger.occurrences.push({ key, at: now, value: envelope });
  }
  return { delivered: true, deduplicated: false };
}
/**
 * A change of holder made by a participant, not by the program (spec §7): the
 * holder delegated the request, the delegate gave it back by refusing it or
 * reporting that they could not do it, or the one who delegated it took it
 * back. The program never sees one.
 */
export interface Delegation {
  request: string;
  at: number;
  kind: "delegated" | "returned" | "reclaimed";
  from: string;
  to: string;
  /** In the participant's words: why they delegated it, or why the delegate gave it back. */
  reason: string | null;
  /** For a request given back: the delegate's refusal or report that they could not do it. */
  reply?: Extract<Reply, { tag: "Refused" | "Broke" }>;
}
export const emptyLedger = (startedAt = 0, options: { identityScheme?: 1 | 2 } = {}): Ledger => ({
  identityScheme: options.identityScheme ?? 2,
  ...((options.identityScheme ?? 2) === 2 ? { uniqueAddresses: true as const } : {}),
  startedAt, requests: {}, entries: {}, facts: {}, occurrences: [], evidence: [], delegations: [], ended: null,
});

/** Records an explicit address move so a renamed loop or request continues its existing ledger entry. */
export function recordMove(ledger: Ledger, from: string, to: string, at: number): void {
  if (!from || !to || from === to) throw new Error("A move requires two distinct non-empty addresses");
  (ledger.moves ??= []).push({ from, to, at });
}

type Source = Extract<Value, { type: "source" }>;
/** The `First`/`Second` constructors an `or` puts around a value, outermost first. */
type Path = ("First" | "Second")[];
/** One pure transformation or predicate step on a stream occurrence, innermost first. */
type StreamOp =
  | { kind: "map" | "filter" | "filterMap"; fn: Value }
  | { kind: "wrap"; side: "First" | "Second" }
  | { kind: "timed" }
  | { kind: "scan"; initial: Value; fn: Value; stateKey: string };
/** One thing a wait is for. */
export type Target =
  | { kind: "request"; id: string }
  | { kind: "fact" | "stream"; source: Source; path: Path; /** A stream taken with all that has arrived: `gather`. */ gathered?: true }
  | { kind: "timer"; at: number; path: Path };
interface DetailedTarget {
  target: Target;
  ops: StreamOp[];
  /** Present on `every` timers so filtered ticks can step forward cleanly. */
  timer?: { period: number; anchor: number; kind: "every" | "after" };
}
export interface Waiting { targets: Target[]; until: number | null }

/** Summary of one standing loop observed during a pass (identityScheme 2). */
export interface LoopSummary {
  key: string;
  sealedRounds: number;
  activeRound: string | null;
  nextDue: number | null;
}

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
  /** Open requests whose report form the program text changed. */
  formChanged: { id: string; from: ReportForm | null; to: ReportForm | null }[];
  /** Answered requests whose recorded answer no longer fits the edited program's form. */
  incompatibleAnswers: { id: string; reason: string; form: ReportForm | null }[];
  /** Keyed requests whose terms the program changed: the old request (cancelled if it was open) and the one asked in its place. */
  superseded: { id: string; by: string; wasOpen: boolean }[];
  /** On a ledger without `uniqueAddresses`: addresses a pass reached more than once, still numbered so the program goes on. */
  duplicateAddresses: string[];
  /** The rounds a `~per` loop keeps going, one per partition: the scope each runs in and its partition key. */
  branches: { loop: string; scope: string; partition: string }[];
  /** The `Holds` kinds this pass sampled or listens to the members of: the host sends changes of these kinds only. */
  holding: string[];
  /** Answers rejected by an `accepting` request validator during this pass. */
  validationErrors?: { id: string; reason: string; errors: FormPathError[] }[];
  /** All request IDs (open or answered) reached by this pass. */
  reached: string[];
  /** Loops observed during this pass (identityScheme 2). */
  loops: LoopSummary[];
  said: { to: string; text: string }[];
  /** The wait the pass stopped at. */
  waiting: Waiting | null;
  /**
   * The host's streams the program's loops take occurrences from, whether a
   * loop waits now or its handler is at work: an occurrence recorded on one of
   * them is not lost, the loop takes it when the handler has finished.
   */
  listening: Source[];
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
  /** Optional provenance label recorded as `openedBy` on newly opened requests. */
  openedBy?: string;
}

/** The program's own mistake, found at an effect: it ends the program as a program failure and is never a reply. */
class ProgramError extends Error {}

const VERBS = ["ask", "confirm", "choose", "run", "judge"];
/** The requests a program makes of the host's connected apps (spec §6.3), by the name the ledger keeps as their verb. */
const ACTION_VERBS: Record<string, "prepare" | "perform"> = { "Actions.prepare": "prepare", "Actions.perform": "perform" };
/** Who holds a request of a connected app: the app, never a participant. */
export const appHolder = (app: string): string => `app:${app}`;
/**
 * What `Actions.prepare` answers once the host has admitted the action: the
 * one value `Actions.perform` takes. It names the request, and the ledger is
 * what makes it good: a value of this shape that no admitted `prepare` of the
 * same ledger stands behind performs nothing.
 */
export const preparedAction = (request: Pick<LedgerRequest, "id">): Value => variant("Prepared", text(request.id));
const LABELS: Record<string, string[]> = {
  "Actions.prepare": ["by", "about"], "Actions.perform": ["by"],
  ask: ["key", "by", "about"], confirm: ["key", "by", "about"], choose: ["key", "by", "about"], run: ["key", "context", "by", "about", "form"], judge: ["key", "about"],
  wait: [], waitUntil: [], cancel: [], handOver: [], status: [], say: [], first: [], sameAs: [], spawn: ["key"], withinEnter: [], withinExit: [],
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
  if (source.type !== "source" || source.kind !== kind || COMPOSED.includes(source.name)) {
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
/**
 * The first valid answer from the current holder settles a request; anything
 * else is kept as evidence. A delegate's refusal, or their report that they
 * could not do it, settles nothing either: the request goes back to whoever
 * delegated it, because only the participant the program asked can refuse it
 * or fail it (spec §4.1). True only when the request has ended.
 *
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
  const delegator = request.delegatedBy ?? null;
  if (delegator !== null && (reply.tag === "Refused" || reply.tag === "Broke")) {
    (ledger.delegations ??= []).push({ request: id, at: now, kind: "returned", from: holder, to: delegator, reason: reply.reason, reply });
    request.holder = delegator; request.delegatedBy = null; request.epoch++;
    return false;
  }
  if (reply.tag === "Answered" && request.takenAt == null) request.takenAt = now;
  request.reply = reply; request.settledAt = now;
  return true;
}

/** A participant as a program writes one, `@alice` or `@codex:2`: the only kind of delegate. */
const ONE_PARTICIPANT = /^@[A-Za-z_][A-Za-z0-9_]*(?:-[A-Za-z0-9_]+)*(?::[0-9]+)?$/u;
/** Whether `excluded` leaves out `who`: the same participant, or any instance of an agent named without one. */
function excludes(excluded: string, who: string): boolean {
  return excluded === who || (!excluded.includes(":") && who.startsWith(`${excluded}:`));
}

/**
 * The holder delegates the request: `to` holds it and answers it for them
 * (spec §7). It stays the same request, with the same `~by` and form, under a
 * new epoch, and the program does not see the change. Returns null once it is
 * delegated, or else why it cannot be, and then nothing changes.
 *
 * `epoch`, when given, is the holding `from` acts under, as for `settle`. A
 * host admits a delegation only when the program's author may ask `to` and
 * `to` may see the request (spec §10); this function cannot know either.
 */
export function delegate(ledger: Ledger, id: string, from: string, to: string, now: number, options: { epoch?: number; reason?: string } = {}): string | null {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  const refusal = !request ? "No such request"
    : request.reply !== null ? "The request has already ended"
    : request.verb === "judge" ? "Only the host's judge decides a judgement"
    : request.action ? "The host performs an action; it is nobody's to delegate"
    : request.candidates?.length ? "Nobody of the group has taken the request yet"
    : request.holder !== from || (options.epoch !== undefined && options.epoch !== request.epoch) ? "Not the request's holder"
    : (request.delegatedBy ?? null) !== null ? "A delegate answers the request or gives it back; they cannot delegate it again"
    : !ONE_PARTICIPANT.test(to) || to === "@judge" ? "A request is delegated to one participant, as in @alice or @codex:2"
    : to === from ? "The holder already holds the request"
    : (request.excluded ?? []).some(excluded => excludes(excluded, to)) ? `The request leaves out ${to}`
    : null;
  if (refusal !== null) return refusal;
  (ledger.delegations ??= []).push({ request: id, at: now, kind: "delegated", from, to, reason: options.reason ?? null });
  request.holder = to; request.delegatedBy = from; request.epoch++;
  return null;
}

/**
 * Whoever delegated the request takes it back while it is open, and holds it
 * again under a new epoch: an answer the delegate gives afterwards is
 * evidence. Returns null once it is back, or else why it cannot be.
 */
export function reclaim(ledger: Ledger, id: string, by: string, now: number): string | null {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  const refusal = !request ? "No such request"
    : request.reply !== null ? "The request has already ended"
    : (request.delegatedBy ?? null) !== by ? `${by} has not delegated the request`
    : null;
  if (refusal !== null) return refusal;
  (ledger.delegations ??= []).push({ request: id, at: now, kind: "reclaimed", from: request.holder, to: by, reason: null });
  request.holder = by; request.delegatedBy = null; request.epoch++;
  return null;
}
function runFormError(answer: Value, form: ReportForm | null): string | null {
  if (form === null) return answer.type === "record" && answer.fields.text?.type === "string" ? null : "A report must be a record with text";
  return mismatch(answer, form) === null ? null : `The report must be ${form.text}: ${mismatch(answer, form)}`;
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
    // Only the host admits an action, and the answer is the request's own token; what an action answers is the host's to check.
    case "prepare": return equal(answer, preparedAction(request)) ? null : "A prepared action is answered with preparedAction(request)";
    case "perform": return null;
    default: return runFormError(answer, request.form);
  }
}
/** One of a group takes a request offered with `anyOf`: from then on it has exactly that holder. False when someone else has it. */
export function take(ledger: Ledger, id: string, taker: string, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request || request.reply !== null || !request.candidates?.includes(taker)) return false;
  if (request.initialCandidates === undefined) request.initialCandidates = [...request.candidates];
  if (request.initialGroupHolder === undefined) request.initialGroupHolder = request.holder;
  request.holder = taker; request.candidates = null; request.takenAt ??= now; request.epoch++;
  return true;
}

/**
 * Records that a single-participant or Agent request was picked up / started,
 * establishing the implicit `taken(r)` fact without settling the request.
 */
export function markTaken(ledger: Ledger, id: string, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request || request.reply !== null) return false;
  if (request.takenAt == null) request.takenAt = now;
  return true;
}

/**
 * Releases a previously taken group request back to its candidate pool so
 * another group member can take it under a new epoch.
 */
export function release(
  ledger: Ledger,
  id: string,
  holder: string,
  now: number,
  options: { epoch?: number; candidates?: string[]; reason?: string } = {},
): string | null {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  const pool = options.candidates ?? request?.initialCandidates ?? null;
  const refusal = !request ? "No such request"
    : request.reply !== null ? "The request has already ended"
    : request.candidates?.length ? "Nobody of the group has taken the request yet"
    : request.holder !== holder || (options.epoch !== undefined && options.epoch !== request.epoch) ? "Not the request's holder"
    : !pool?.length ? "Only a group request offered with anyOf can be released back to the pool"
    : null;
  if (refusal !== null) return refusal;
  const groupHolder = request.initialGroupHolder ?? `anyOf([${pool!.join(", ")}])`;
  (ledger.delegations ??= []).push({ request: id, at: now, kind: "returned", from: holder, to: groupHolder, reason: options.reason ?? null });
  request.holder = groupHolder;
  request.candidates = [...pool!];
  request.delegatedBy = null;
  request.takenAt = null;
  request.epoch++;
  return null;
}

/** Records an explicit host delivery failure on an open request without collapsing it into `NoReply`. */
export function markUndelivered(ledger: Ledger, id: string, reason: string, now: number): boolean {
  settleDue(ledger, now);
  const request = ledger.requests[id];
  if (!request || request.reply !== null) return false;
  request.undelivered = { at: now, reason };
  return true;
}

/** Appends a free-text note to a request (backing `say(r, text)` and `r->notes`); never settles or extends `~by`. */
export function addNote(ledger: Ledger, id: string, author: string, body: string, now: number): boolean {
  const request = ledger.requests[id];
  if (!request) return false;
  ((ledger.requestNotes ??= {})[id] ??= []).push({ at: now, author, text: body });
  const notesSource: Value = { type: "source", kind: "stream", name: "notes", args: [{ type: "request", id }], labels: {} };
  ledger.occurrences.push({ key: eventKey(notesSource), at: now, value: text(body) });
  return true;
}

/** Result of evaluating a pure Norn admission policy (`request => Allow | Deny(string) | AlsoAsk(participant)`). */
export type AdmissionDecision =
  | { decision: "Allow" }
  | { decision: "Deny"; reason: string }
  | { decision: "AlsoAsk"; participant: string };

/**
 * Evaluates a pure Norn admission policy program (returning a function
 * `requestInfo => Allow | Deny(string) | AlsoAsk(participant)`) against a
 * request record before dispatching it.
 */
export function evaluateAdmissionPolicy(policyCode: Code, request: LedgerRequest, now: number): AdmissionDecision {
  const machine = start(policyCode, now);
  advance(policyCode, machine, 100_000);
  if (machine.control.kind !== "done") {
    throw new Error(machine.control.kind === "error" ? machine.control.message : "Admission policy must evaluate purely to a function");
  }
  const fn = machine.control.value;
  if (fn.type !== "closure" && fn.type !== "builtin") {
    throw new Error("Admission policy must evaluate to a function");
  }
  const reqVal: Value = {
    type: "record",
    fields: {
      id: text(request.id),
      verb: text(request.verb),
      holder: text(request.holder),
      text: text(request.text),
      about: request.about != null ? variant("Some", text(request.about)) : variant("None"),
      context: request.context != null ? variant("Some", text(request.context)) : variant("None"),
      openedBy: text(request.openedBy ?? "program"),
    },
  };
  const verdict = runPure(policyCode, fn, reqVal, machine, now);
  if (verdict.type === "variant" && verdict.name === "Allow" && verdict.args.length === 0) {
    return { decision: "Allow" };
  }
  if (verdict.type === "variant" && verdict.name === "Deny" && verdict.args.length === 1 && verdict.args[0]!.type === "string") {
    return { decision: "Deny", reason: verdict.args[0]!.value };
  }
  if (verdict.type === "variant" && verdict.name === "AlsoAsk" && verdict.args.length === 1 && verdict.args[0]!.type === "participant") {
    return { decision: "AlsoAsk", participant: show(verdict.args[0]!) };
  }
  throw new Error(`Admission policy returned invalid value: ${show(verdict)}`);
}

function conditionsOf(who: Value | undefined): Record<string, string> {
  if (who?.type !== "participant" || who.name === "anyOf") return {};
  return Object.fromEntries(Object.entries(who.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([label, value]) => [label, show(value)]));
}
function resolveExceptParticipant(except: Value | undefined, ledger?: Ledger): string | null {
  if (!except) return null;
  if (except.type === "participant") return show(except);
  if (except.type === "request" && ledger) {
    const req = ledger.requests[except.id];
    if (!req) throw new ProgramError("anyOf ~except request does not exist in this program");
    if (req.candidates?.length) return null;
    return req.holder;
  }
  return show(except);
}
/** Who a group leaves out with `~except`: nobody may hold the request, by taking it or by delegation. */
function excludedOf(who: Value | undefined, ledger?: Ledger): string[] {
  if (who?.type !== "participant" || who.name !== "anyOf" || !who.labels.except) return [];
  const excluded = resolveExceptParticipant(who.labels.except, ledger);
  return excluded ? [excluded] : [];
}
function candidatesOf(who: Value, ledger?: Ledger): string[] | null {
  if (who.type !== "participant" || who.name !== "anyOf") return null;
  const except = resolveExceptParticipant(who.labels.except, ledger);
  const group = (who.labels.of as Extract<Value, { type: "list" | "tuple" }>).values.map(show).filter(name => except === null || !excludes(except, name));
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

/** `Holds.kind(source, type)` as the runtime keeps it. */
export const holdKind = (source: string, type: string): Value => variant("HoldKind", text(source), text(type));
/** The key the ledger keeps a `Holds.kind` under. */
export const holdKindKey = (kind: Value): string => {
  if (kind.type !== "variant" || kind.name !== "HoldKind" || kind.args[0]?.type !== "string" || kind.args[1]?.type !== "string") {
    throw new Error("Expected a Holds.kind value");
  }
  return `${kind.args[0].value}:${kind.args[1].value}`;
};
const membersStream = (kind: Value): Value => ({ type: "source", kind: "stream", name: "Holds.members", args: [kind], labels: {} });
const changesStream = (kind: Value, id: string): Value =>
  ({ type: "source", kind: "stream", name: "Holds.changes", args: [variant("Held", kind, text(id))], labels: {} });
const member = (id: string, present: boolean): Value => ({ type: "record", fields: { id: text(id), present: { type: "bool", value: present } } });

/**
 * The host says what holds now for `id` under `kind` (spec §6.4): a value, or
 * `null` when nothing does any more. A thing that starts or stops having the
 * kind occurs on `Holds.members(kind)`; a changed value occurs on
 * `Holds.changes`, unless `notify` is false, as for a value the program's own
 * work wrote back: the next `Holds.sample` reads it, and nothing is woken.
 * Holding the same value again records nothing.
 */
export function hold(ledger: Ledger, kind: Value, id: string, value: Value | null, now: number, options: { notify?: boolean } = {}): void {
  const key = holdKindKey(kind);
  const held = (ledger.holds ??= {})[key] ??= {};
  const before = held[id];
  if (value === null) {
    if (!before) return;
    delete held[id];
    ledger.occurrences.push({ key: eventKey(membersStream(kind)), at: now, value: member(id, false) });
    if (options.notify !== false) ledger.occurrences.push({ key: eventKey(changesStream(kind, id)), at: now, value: variant("None") });
    return;
  }
  if (before && equal(before.value, value)) return;
  held[id] = { at: now, value };
  if (!before) ledger.occurrences.push({ key: eventKey(membersStream(kind)), at: now, value: member(id, true) });
  if (options.notify !== false) ledger.occurrences.push({ key: eventKey(changesStream(kind, id)), at: now, value: variant("Some", value) });
}

/** Streams the language makes from others, or from the clock: nothing occurs on one of these by a host's word. */
const COMPOSED = ["or", "merge", "never", "after", "every", "map", "filter", "filterMap", "scan", "timed", "gather", "taken", "notes"];
/** The host's streams under a stream a program composed, in the order `or`/`merge` gives them. */
function hostStreams(stream: Value): Source[] {
  if (stream.type !== "source" || stream.kind !== "stream") return [];
  if (stream.name === "or" || stream.name === "merge" || stream.name === "map" || stream.name === "filter" || stream.name === "filterMap" || stream.name === "scan" || stream.name === "timed" || stream.name === "gather") {
    return stream.args.flatMap(hostStreams);
  }
  return COMPOSED.includes(stream.name) ? [] : [stream];
}

/**
 * Strips pure functions (`map`/`filter`/`filterMap`/`scan`) and `or`/`merge` operand order
 * from a source descriptor so wait identity never depends on closure AST
 * positions or operand ordering.
 */
function stripSourceFunctions(value: Value): unknown {
  if (value.type === "request") return { type: "request", id: value.id };
  if (value.type !== "source") return value;
  if (value.name === "map" || value.name === "filter" || value.name === "filterMap" || value.name === "timed") {
    return stripSourceFunctions(value.args[0]);
  }
  if (value.name === "scan") {
    return { type: "source", kind: value.kind, name: "scan", of: stripSourceFunctions(value.args[0]), initial: value.args[1] };
  }
  if (value.name === "or") {
    const parts = [stripSourceFunctions(value.args[0]), stripSourceFunctions(value.args[1])];
    const keys = parts.map(part => eventKey(part as Value)).sort();
    return { type: "source", kind: value.kind, name: "or", parts: keys };
  }
  if (value.name === "merge") {
    const flattenMerge = (v: Value): unknown[] => {
      if (v.type === "source" && v.name === "never") return [];
      if (v.type === "source" && v.name === "merge") return [...flattenMerge(v.args[0]), ...flattenMerge(v.args[1])];
      return [stripSourceFunctions(v)];
    };
    const parts = flattenMerge(value);
    if (parts.length === 0) return { type: "source", kind: "stream", name: "never", args: [], labels: {} };
    if (parts.length === 1) return parts[0];
    const keys = parts.map(part => eventKey(part as Value)).sort();
    return { type: "source", kind: value.kind, name: "merge", parts: keys };
  }
  if (value.name === "gather") return { type: "source", kind: value.kind, name: "gather", of: stripSourceFunctions(value.args[0]) };
  return value;
}

/** What a wait is for, with `or`/`merge` flattened left to right and each leaf's pure stream ops preserved innermost-first. */
function detailedTargetsOf(ledger: Ledger, waited: Value, began: number): DetailedTarget[] {
  const results: DetailedTarget[] = [];
  const pending: { source: Value; path: Path; ops: StreamOp[]; gathered?: true }[] = [{ source: waited, path: [], ops: [] }];
  while (pending.length) {
    const { source, path, ops, gathered } = pending.pop()!;
    if (source.type === "request") {
      if (!ledger.requests[source.id]) throw new ProgramError("wait needs a request of this program");
      results.push({ target: { kind: "request", id: source.id }, ops });
    } else if (source.type !== "source") throw new ProgramError("wait needs a request, a fact or a stream");
    else if (source.name === "or") {
      pending.push(
        { source: source.args[1], path: [...path, "Second"], ops: [{ kind: "wrap", side: "Second" }, ...ops] },
        { source: source.args[0], path: [...path, "First"], ops: [{ kind: "wrap", side: "First" }, ...ops] },
      );
    } else if (source.name === "merge") {
      pending.push(
        { source: source.args[1], path, ops, gathered },
        { source: source.args[0], path, ops, gathered },
      );
    } else if (source.name === "map" || source.name === "filter" || source.name === "filterMap") {
      pending.push({ source: source.args[0], path, ops: [{ kind: source.name, fn: source.args[1] }, ...ops], gathered });
    } else if (source.name === "timed") {
      pending.push({ source: source.args[0], path, ops: [{ kind: "timed" }, ...ops], gathered });
    } else if (source.name === "scan") {
      const stateKey = sha256(eventKey(stripSourceFunctions(source) as Value)).slice(0, 12);
      pending.push({ source: source.args[0], path, ops: [{ kind: "scan", initial: source.args[1], fn: source.args[2], stateKey }, ...ops], gathered });
    } else if (source.name === "gather") {
      const [of] = source.args;
      if (of?.type !== "source" || of.kind !== "stream" || COMPOSED.includes(of.name)) throw new ProgramError("gather takes a stream of the host, as in ciFailed(\"acme/api\")->gather");
      pending.push({ source: of, path, ops, gathered: true });
    } else if (source.name === "after" || source.name === "every") {
      const { from, ...unknown } = source.labels;
      if (source.args.length !== 1 || Object.keys(unknown).length || (from && (source.name !== "every" || from.type !== "time"))) {
        throw new ProgramError("A timer needs one positional argument; every also takes ~from, a time");
      }
      const when = source.args[0];
      if (!(source.name === "after" && when.type === "time") && (when.type !== "duration" || BigInt(when.value) <= 0n)) throw new ProgramError("A relative timer needs a positive duration");
      const period = source.name === "every" ? Number(when.value) : 0;
      const anchor = from ? Number(from.value) : ledger.startedAt;
      const at = period <= 0 ? instant(when, began)! : began < anchor ? anchor : anchor + (Math.floor((began - anchor) / period) + 1) * period;
      if (!Number.isSafeInteger(at)) throw new ProgramError("A deadline lies outside the clock's range");
      results.push({ target: { kind: "timer", at, path }, ops, timer: { period, anchor, kind: source.name } });
    } else if (source.name !== "never") {
      results.push({ target: { kind: source.kind, source, path, ...(gathered ? { gathered } : {}) }, ops });
    }
  }
  return results;
}

/** Canonical description of a stream's timer schedule, independent of `or` operand order and pure functions. */
function timerSpecOf(detailed: DetailedTarget[]): string {
  const parts = detailed
    .filter(item => item.timer !== undefined)
    .map(item => item.timer!.kind === "every"
      ? `every(${item.timer!.period},${item.timer!.anchor})`
      : `after(${item.target.kind === "timer" ? item.target.at : 0})`)
    .sort();
  return parts.join("|");
}

function hasFilterOp(detailed: DetailedTarget[]): boolean {
  return detailed.some(item => item.ops.some(op => op.kind === "filter" || op.kind === "filterMap" || op.kind === "scan" || op.kind === "timed"));
}

/** Applies a leaf target's pure `map`/`filter`/`filterMap`/`scan`/`timed`/`wrap` pipeline. Returns null when filtered out. */
function applyOps(
  code: Code,
  machine: Machine,
  rawValue: Value,
  ops: StreamOp[],
  now: number,
  occurrenceAt: number,
  scanStates?: Map<string, Value>,
): Value | null {
  let current = rawValue;
  for (const op of ops) {
    if (op.kind === "wrap") {
      current = variant(op.side, current);
    } else if (op.kind === "timed") {
      current = { type: "record", fields: { at: { type: "time", value: String(occurrenceAt) }, value: current } };
    } else if (op.kind === "map") {
      try { current = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
    } else if (op.kind === "filter") {
      let verdict: Value;
      try { verdict = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
      if (verdict.type !== "bool") throw new ProgramError("filter predicate must return a bool");
      if (!verdict.value) return null;
    } else if (op.kind === "filterMap") {
      let mapped: Value;
      try { mapped = runPure(code, op.fn, current, machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
      if (mapped.type !== "variant" || (mapped.name !== "None" && (mapped.name !== "Some" || mapped.args.length !== 1))) {
        throw new ProgramError("filterMap function must return Some(value) or None");
      }
      if (mapped.name === "None") return null;
      current = mapped.args[0];
    } else if (op.kind === "scan") {
      const prevState = scanStates?.get(op.stateKey) ?? op.initial;
      let pair: Value;
      try { pair = runPureArgs(code, op.fn, [prevState, current], machine, now); } catch (error) {
        throw new ProgramError(error instanceof Error ? error.message : String(error));
      }
      if (pair.type !== "tuple" || pair.values.length !== 2) {
        throw new ProgramError("scan reducer must return (nextState, option<out>)");
      }
      const [nextState, emitted] = pair.values;
      scanStates?.set(op.stateKey, nextState);
      if (emitted.type !== "variant" || (emitted.name !== "None" && (emitted.name !== "Some" || emitted.args.length !== 1))) {
        throw new ProgramError("scan reducer must return (nextState, Some(value) | None)");
      }
      if (emitted.name === "None") return null;
      current = emitted.args[0];
    }
  }
  return current;
}

/**
 * The functions `map` put on the way from the stream that occurred to what a
 * wait on `waited` gives, innermost first, with the constructors `or` and
 * `waitUntil` put around the value between them. Null: no function is on the
 * way, and the wait gives the recorded value as it stands.
 */
function through(waited: Value, given: Value, name: string): { value: Value; steps: Through[] } | null {
  const steps: Through[] = [];
  const outer: Through[] = [];
  let source = waited, value = given;
  if (name === "waitUntil") {
    if (value.type !== "variant" || value.name !== "Some") return null;
    value = value.args[0]; outer.push({ wrap: "Some" });
  }
  while (source.type === "source" && (source.name === "or" || source.name === "map")) {
    if (source.name === "map") { outer.unshift({ fn: source.args[1] }); source = source.args[0]; continue; }
    if (value.type !== "variant") break;
    outer.unshift({ wrap: value.name });
    source = source.args[value.name === "First" ? 0 : 1]; value = value.args[0];
  }
  steps.push(...outer);
  return steps.some(step => "fn" in step) ? { value, steps } : null;
}

/** At one instant a request's own deadline comes first, then the wait's, then any other reply or occurrence. */
interface Candidate {
  at: number; value: Value; rank: 0 | 1 | 2;
  /** The stream it came from, and how far that stream is then taken. */
  taken?: { stream: string; next: number };
  /** Occurrence-keyed round identifier (identityScheme 2). */
  roundKey?: string;
  /** Timer instant consumed by this occurrence (identityScheme 2). */
  timerAt?: number;
  /** True when `applyOps` already ran on `value` (so `through` must not run again). */
  evaluated?: true;
}
/** Legacy v1 loop cursor. */
interface Taken { from: number; streams: Record<string, number> }
/** Scoped v2 loop checkpoint persisted under `loop:<key>`. */
interface LoopState {
  startedAt: number;
  from: number;
  streams: Record<string, number>;
  lastTimerAt: number | null;
  timerSpec: string | null;
  waitingLogged?: boolean;
  sealedRounds: number;
  sealedTimerInstants: number[];
  active: {
    roundKey: string;
    at: number;
    value: Value;
    streamTaken?: { stream: string; next: number };
    timerAt?: number;
    partKey?: string;
  } | null;
  /** Queued occurrences frozen by `~each=Batch` or partitioned by `~per`. */
  pendingQueue?: { roundKey: string; at: number; value: Value; partKey?: string }[];
  /** Concurrent in-flight rounds driven by `~each=Together`. */
  activeRounds?: { roundKey: string; at: number; value: Value; partKey?: string }[];
}

/** Resolves an address through explicit `moved` entries (including scope prefix moves inside `kind:<scope>/...` keys). */
function resolveAddress(address: string, moves: readonly MovedAddress[] | undefined): string {
  if (!moves?.length) return address;
  const kindPrefix = /^(?:request|wait|say|status|cancel|handOver|first|report):/u.exec(address)?.[0] ?? "";
  let current = kindPrefix ? address.slice(kindPrefix.length) : address;
  const visited = new Set<string>([current]);
  for (;;) {
    let changed = false;
    for (const move of moves) {
      if (current === move.from) {
        current = move.to;
        changed = true;
      } else if (current.startsWith(`${move.from}/`)) {
        current = `${move.to}${current.slice(move.from.length)}`;
        changed = true;
      }
      if (changed) {
        if (visited.has(current)) return kindPrefix + current;
        visited.add(current);
        break;
      }
    }
    if (!changed) return kindPrefix + current;
  }
}

/**
 * One pass, yielding between slices of pure computation so a host can give
 * other work a turn. The ledger is read when the pass starts and written only
 * when it finishes, so it must not change in between; a pass that throws or is
 * abandoned leaves it as it was.
 */
export function* slices(code: Code, source: Ledger, now: number, options: PassOptions = {}): Generator<undefined, Pass> {
  const pass: Pass = {
    status: "waiting", result: null, error: null, log: [], opened: [], unreached: [], cancelled: [],
    rescheduled: [], formChanged: [], incompatibleAnswers: [], superseded: [], duplicateAddresses: [], branches: [], holding: [], reached: [], loops: [], said: [],
    waiting: null, listening: [], nextDue: null,
  };
  if (source.ended) return { ...pass, status: source.ended.status, result: source.ended.result, error: source.ended.error };
  const ledger = structuredClone(source), log = pass.log;
  const v2 = (ledger.identityScheme ?? 1) === 2;
  settleDue(ledger, now);

  // Scoped counters (v2) or flat counters (v1).
  const scopeStack: string[] = [];
  const activeLoopStack: { storageKey: string; displayKey: string }[] = [];
  const deadlineStack: number[] = [];
  const spawnOwnerStack: string[] = [];
  const currentScope = (): string => scopeStack.at(-1) ?? "root";
  const currentSpawnOwner = (): string | null => spawnOwnerStack.at(-1) ?? null;
  const clampBy = (rawBy: number | null): number | null => {
    const cap = deadlineStack.at(-1);
    if (cap === undefined) return rawBy;
    return rawBy === null ? cap : Math.min(rawBy, cap);
  };
  const cancelSpawnChildren = (spawnId: string): void => {
    for (const req of Object.values(ledger.requests)) {
      if (req.reply === null && req.spawnOwner === spawnId) {
        close(req, { tag: "Cancelled" }, now);
        if (req.verb === "spawn") cancelSpawnChildren(req.id);
      }
    }
  };
  const loadScanStates = (scopeKey: string): Map<string, Value> => {
    const map = new Map<string, Value>();
    const raw = ledger.entries[`scan:${scopeKey}`]?.value as unknown as Record<string, Value> | undefined;
    if (raw && typeof raw === "object") {
      for (const [k, v] of Object.entries(raw)) map.set(k, v);
    }
    return map;
  };
  const saveScanStates = (scopeKey: string, map: Map<string, Value>): void => {
    if (map.size === 0) return;
    ledger.entries[`scan:${scopeKey}`] = { at: now, value: Object.fromEntries(map) as unknown as Json };
  };
  const applyRequestTransforms = (
    activeMachine: Machine,
    reqVal: Value,
    request: LedgerRequest,
    rawReply: Reply,
  ): { ok: true; reply: Reply } | { ok: false; reason: string } => {
    const transforms = reqVal.type === "request" ? (reqVal.transforms ?? []) : [];
    if (rawReply.tag !== "Answered" || transforms.length === 0) return { ok: true, reply: rawReply };
    let currentVal = rawReply.value;
    for (const tr of transforms) {
      let res: Value;
      try {
        res = runPure(code, tr.fn, currentVal, activeMachine, now);
      } catch (err) {
        throw new ProgramError(err instanceof Error ? err.message : String(err));
      }
      if (tr.kind === "validate") {
        if (res.type === "variant" && res.name === "Ok" && res.args.length === 1) {
          currentVal = res.args[0]!;
        } else if (res.type === "variant" && res.name === "Error" && res.args.length === 1 && res.args[0]!.type === "string") {
          const reason = res.args[0]!.value;
          const errItem: FormPathError = { path: "$", expected: "accepted value", found: show(rawReply.value) };
          ledger.evidence.push({ request: request.id, holder: request.holder, at: now, reply: rawReply, reason });
          (pass.validationErrors ??= []).push({ id: request.id, reason, errors: [errItem] });
          request.reply = null;
          request.settledAt = null;
          if (request.by !== null) due(request.by);
          return { ok: false, reason };
        } else {
          throw new ProgramError("accepting validator must return Ok(value) or Error(string)");
        }
      } else {
        currentVal = res;
      }
    }
    return { ok: true, reply: { tag: "Answered", value: currentVal } };
  };
  const scopeSeen = new Map<string, Map<string, number>>();
  const loopsUsedInScope = new Map<string, Set<string>>();
  const seenIn = (scope: string): Map<string, number> => {
    let map = scopeSeen.get(scope);
    if (!map) { map = new Map(); scopeSeen.set(scope, map); }
    return map;
  };
  // Legacy flat counter map for v1 ledgers.
  const seen = seenIn("root");

  // Address lookup table for v2: maps resolved address -> LedgerRequest, preserving immutable `id`.
  const byAddress = new Map<string, LedgerRequest>();
  if (v2) {
    for (const request of Object.values(ledger.requests)) {
      const addr = resolveAddress(request.address ?? request.id, ledger.moves);
      byAddress.set(addr, request);
    }
  }
  const resolveEntryKey = (targetKey: string): string => {
    if (!v2 || !ledger.moves?.length || ledger.entries[targetKey]) return targetKey;
    for (const existingKey of Object.keys(ledger.entries)) {
      if (resolveAddress(existingKey, ledger.moves) === targetKey) return existingKey;
    }
    return targetKey;
  };

  // Identity: what is asked of whom, counted in evaluation order within the current scope.
  const identity = (kind: string, content: unknown): string => {
    const digest = sha256(eventKey(content as Value)).slice(0, 16);
    if (!v2) {
      const ordinal = (seen.get(kind + digest) ?? 0) + 1;
      seen.set(kind + digest, ordinal);
      return `${kind}:${digest}#${ordinal}`;
    }
    const scope = currentScope();
    const map = seenIn(scope);
    const ordinal = (map.get(kind + digest) ?? 0) + 1;
    map.set(kind + digest, ordinal);
    return scope === "root" ? `${kind}:${digest}#${ordinal}` : `${kind}:${scope}/${digest}#${ordinal}`;
  };
  // Request addresses (identityScheme 2): one request per address in a scope, whatever the evaluation order.
  // The address is the scope path and either the request's `~key` or what it asks of whom.
  const usedRequestAddresses = new Set<string>();
  const requestAddress = (content: unknown, key: string | null): string => {
    const scope = currentScope();
    const local = key !== null ? `key:${key}` : sha256(eventKey(content as Value)).slice(0, 16);
    const base = scope === "root" ? `request:${local}` : `request:${scope}/${local}`;
    if (!usedRequestAddresses.has(base)) { usedRequestAddresses.add(base); return base; }
    if (ledger.uniqueAddresses) {
      throw new ProgramError(key !== null
        ? `Two requests with ~key="${key}" in the same scope`
        : "Two requests ask the same thing of the same participant in one scope; give each its own ~key");
    }
    let n = 2;
    while (usedRequestAddresses.has(`${base}#${n}`)) n++;
    usedRequestAddresses.add(`${base}#${n}`);
    if (!pass.duplicateAddresses.includes(base)) pass.duplicateAddresses.push(base);
    return `${base}#${n}`;
  };
  // A request recorded before addresses became unique carries a `#1` suffix: it is the same request.
  const requestAt = (address: string): LedgerRequest | undefined => {
    const found = byAddress.get(address);
    if (found || /#\d+$/u.test(address)) return found;
    const legacy = byAddress.get(`${address}#1`);
    if (legacy) { byAddress.delete(`${address}#1`); legacy.address = address; byAddress.set(address, legacy); }
    return legacy;
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
  const nextUniqueRequestId = (address: string): string => {
    const base = `request:${sha256(address).slice(0, 16)}`;
    if (!ledger.requests[base]) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!ledger.requests[candidate]) return candidate;
    }
  };

  const machine = start(code, ledger.startedAt);
  let activeMachine: Machine = machine;
  let lastWaitEvaluated = false;

  /** Answers one effect from the ledger, recording it first when it is new. Null: the pass stops here, waiting or ended. */
  const answer = (effect: Effect): { value: Value; at: number } | null => {
    lastWaitEvaluated = false;
    const { name, args, labels } = effect;
    for (const label of Object.keys(labels)) if (!LABELS[name]?.includes(label)) throw new ProgramError(`Unknown ${name} label ${label}`);
    // Authority is asked only for what the ledger does not hold yet: what is recorded has happened.
    const permitted = (): boolean => options.authorize?.(effect) ?? true;
    const revoked = (): null => end("failed", variant("Revoked"), null);

    if (name === "withinEnter") {
      const limit = instant(args[0], now);
      if (limit === null) throw new ProgramError("within needs a deadline");
      const withinKey = identity("within", { limit: args[0] });
      const anchored = entry(withinKey, () => ({ at: now, value: limit }));
      const anchoredLimit = Number(anchored.value);
      const effective = deadlineStack.length ? Math.min(deadlineStack.at(-1)!, anchoredLimit) : anchoredLimit;
      deadlineStack.push(effective);
      return { value: unit, at: anchored.at };
    }
    if (name === "withinExit") {
      deadlineStack.pop();
      return { value: unit, at: now };
    }
    if (name === "sameAs") {
      if (args.length !== 1) throw new ProgramError("sameAs needs one request");
      const req = handle("sameAs", args[0]);
      if (req.candidates?.length) throw new ProgramError("sameAs needs a request with a resolved single holder");
      const match = /^@([A-Za-z_][A-Za-z0-9_-]*)(?::([0-9]+))?$/u.exec(req.holder);
      if (!match) throw new ProgramError(`Cannot resolve single participant from ${req.holder}`);
      return { value: { type: "participant", name: match[1]!, instance: match[2] ?? null, labels: {} }, at: now };
    }
    if (name === "spawn") {
      if (args.length !== 1 || !["closure", "builtin"].includes(args[0].type)) throw new ProgramError("spawn needs a zero-argument function");
      if (labels.key !== undefined && labels.key.type !== "string") throw new ProgramError("spawn ~key must be a string");
      const spawnLabel = labels.key ? labels.key.value : "$spawn";
      const address = identity("spawn", { key: spawnLabel });
      const resolvedAddress = v2 ? resolveAddress(address, ledger.moves) : address;
      let childReq = v2 ? byAddress.get(resolvedAddress) : ledger.requests[address];
      if (!childReq) {
        if (!permitted()) return revoked();
        const id = v2 ? nextUniqueRequestId(resolvedAddress) : address;
        const childScope = currentScope() === "root" ? `spawn:${id}` : `${currentScope()}/spawn:${id}`;
        childReq = ledger.requests[id] = {
          id, ...(v2 ? { address: resolvedAddress } : {}), verb: "spawn", holder: "@spawn", candidates: null, excluded: [],
          delegatedBy: null, epoch: 0, text: spawnLabel, conditions: {}, about: null, context: null, options: null, form: null,
          by: clampBy(null), openedAt: now, reply: null, settledAt: null, detached: false,
          openedBy: options.openedBy ?? currentScope(), spawnScope: childScope, spawnOwner: currentSpawnOwner(),
        };
        if (v2) byAddress.set(resolvedAddress, childReq);
        log.push({ kind: "opened", request: { ...childReq } });
      } else if (childReq.reply === null) {
        childReq.detached = false;
      }
      reached.add(childReq.id);
      if (childReq.reply === null) {
        const prevMachine = activeMachine;
        const childMachine = startClosure(code, args[0], [], prevMachine, now);
        scopeStack.push(childReq.spawnScope ?? `spawn:${childReq.id}`);
        spawnOwnerStack.push(childReq.id);
        activeMachine = childMachine;
        const childOutcome = driveMachine(childMachine);
        activeMachine = prevMachine;
        spawnOwnerStack.pop();
        scopeStack.pop();
        if (childOutcome.kind === "done") {
          childReq.reply = { tag: "Answered", value: childOutcome.value };
          childReq.settledAt = now;
          cancelSpawnChildren(childReq.id);
        } else if (childOutcome.kind === "failed") {
          const reply: Reply = childOutcome.outcome
            ? outcomeToReply(childOutcome.outcome)
            : { tag: "Broke", reason: childOutcome.error ?? "Child task failed" };
          childReq.reply = reply;
          childReq.settledAt = now;
          cancelSpawnChildren(childReq.id);
        }
      }
      return { value: { type: "request", id: childReq.id }, at: childReq.openedAt };
    }

    if (ACTION_VERBS[name]) {
      const verb = ACTION_VERBS[name];
      let action: NonNullable<LedgerRequest["action"]>;
      if (verb === "prepare") {
        const [named, input] = args;
        if (args.length !== 2 || named?.type !== "variant" || named.name !== "Action" || named.args[0]?.type !== "string" || named.args[1]?.type !== "string") {
          throw new ProgramError("Actions.prepare needs an action and its input");
        }
        action = { app: named.args[0].value, name: named.args[1].value, input: input!, prepared: null };
      } else {
        const [token] = args;
        const admitted = token?.type === "variant" && token.name === "Prepared" && token.args[0]?.type === "string" ? ledger.requests[token.args[0].value] : undefined;
        if (args.length !== 1 || admitted?.verb !== "prepare" || !admitted.action || admitted.reply?.tag !== "Answered") {
          throw new ProgramError("Actions.perform needs what Actions.prepare answered in this program");
        }
        action = { app: admitted.action.app, name: admitted.action.name, input: null, prepared: admitted.id };
      }
      const { by: _by, ...kept } = labels;
      const address = identity("request", { name: verb, who: null, args, labels: kept });
      const resolvedAddress = v2 ? resolveAddress(address, ledger.moves) : address;
      let request = v2 ? byAddress.get(resolvedAddress) : ledger.requests[address];
      if (!request) {
        if (!permitted()) return revoked();
        const id = v2 ? nextUniqueRequestId(resolvedAddress) : address;
        request = ledger.requests[id] = {
          id, ...(v2 ? { address: resolvedAddress } : {}), verb, holder: appHolder(action.app), candidates: null,
          excluded: [], delegatedBy: null, epoch: 0, text: action.name, conditions: {},
          about: labels.about ? show(labels.about) : null, context: action.input === null ? null : show(action.input),
          options: null, form: null, action,
          by: clampBy(instant(labels.by, now)), openedAt: now, reply: null, settledAt: null, detached: false,
          openedBy: options.openedBy ?? currentScope(), spawnOwner: currentSpawnOwner(), ...(v2 ? { scope: currentScope() } : {}),
        };
        if (v2) byAddress.set(resolvedAddress, request);
        log.push({ kind: "opened", request: { ...request } });
      } else if (request.reply === null) {
        // The deadline is not part of what is done: moving it amends the same request.
        const by = clampBy(instant(labels.by, request.openedAt));
        if (by !== request.by) { pass.rescheduled.push({ id: request.id, from: request.by, to: by }); request.by = by; }
        request.detached = false;
      }
      reached.add(request.id);
      if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
      return { value: { type: "request", id: request.id }, at: request.openedAt };
    }

    if (VERBS.includes(name)) {
      let pendingSupersede: { id: string; wasOpen: boolean } | null = null;
      const holder = name === "judge" ? "@judge" : participant(args[0]);
      const question = name === "judge" ? args[0] : args[1];
      if (args.length !== (name === "judge" ? 1 : name === "choose" ? 3 : 2) || question?.type !== "string") {
        throw new ProgramError(name === "judge" ? "judge needs a condition string" : `${name} needs a participant and text${name === "choose" ? ", and its options" : ""}`);
      }
      const choices = name === "choose" ? args[2] : null;
      if (choices && (choices.type !== "list" || !choices.values.length || choices.values.some(v => v.type !== "variant"))) {
        throw new ProgramError("choose options must be a nonempty list of constructors");
      }
      const nextForm = labels.form?.type === "string" && labels.form.value !== "" ? JSON.parse(labels.form.value) as ReportForm : null;
      if (labels.key !== undefined && (labels.key.type !== "string" || labels.key.value === "")) throw new ProgramError(`${name} ~key needs a nonempty string`);
      if (labels.key !== undefined && !v2) throw new ProgramError(`${name} ~key requires an identityScheme 2 ledger; migrate this v1 ledger first`);
      const requestKey = labels.key?.type === "string" ? labels.key.value : null;
      const { by: _by, form: _form, key: _key, ...keptV2 } = labels;
      const { by: _by1, ...keptV1 } = labels;
      const kept = v2 ? keptV2 : keptV1;
      // The participant's own arguments count: @auto(~repo="a") and @auto(~repo="b") are asked different things.
      const content = { name, who: name === "judge" ? null : args[0], args: args.slice(name === "judge" ? 0 : 1), labels: kept };
      const address = v2 ? requestAddress(content, requestKey) : identity("request", content);
      const resolvedAddress = v2 ? resolveAddress(address, ledger.moves) : address;
      let request = v2 ? requestAt(resolvedAddress) : ledger.requests[address];
      // A keyed request names a slot; an answer holds only for the terms it answered.
      const terms = requestKey !== null ? sha256(eventKey(content as unknown as Value) + JSON.stringify(nextForm)).slice(0, 16) : undefined;
      if (request && terms !== undefined && request.terms !== undefined && request.terms !== terms) {
        const wasOpen = request.reply === null;
        if (wasOpen) close(request, { tag: "Cancelled" }, now);
        byAddress.delete(resolvedAddress);
        request.address = `${resolvedAddress}~${request.terms}`;
        byAddress.set(request.address, request);
        reached.add(request.id);
        const previous = request;
        request = undefined;
        pendingSupersede = { id: previous.id, wasOpen };
      }

      // In v2, if an answered `run` no longer fits the edited program's new form, surface it visibly and ask anew under a reform address.
      if (v2 && request && request.reply?.tag === "Answered" && request.verb === "run") {
        const incompatibility = runFormError(request.reply.value, nextForm);
        if (incompatibility !== null) {
          pass.incompatibleAnswers.push({ id: request.id, reason: incompatibility, form: nextForm });
          const reformAddress = `${resolvedAddress}/reform:${sha256(JSON.stringify(nextForm)).slice(0, 8)}`;
          request = byAddress.get(reformAddress);
          if (!request) {
            if (!permitted()) return revoked();
            const id = nextUniqueRequestId(reformAddress);
            const initCandidates = name === "judge" ? null : candidatesOf(args[0], ledger);
            request = ledger.requests[id] = {
              id, address: reformAddress, verb: name, holder, candidates: initCandidates,
              ...(initCandidates ? { initialCandidates: [...initCandidates], initialGroupHolder: holder } : {}),
              excluded: name === "judge" ? [] : excludedOf(args[0], ledger), delegatedBy: null, epoch: 0, text: question.value,
              conditions: conditionsOf(args[0]),
              about: labels.about ? show(labels.about) : null, context: labels.context ? show(labels.context) : null,
              options: choices?.type === "list" ? choices.values : null,
              form: nextForm,
              by: clampBy(instant(labels.by, now)), openedAt: now, reply: null, settledAt: null, detached: false,
              openedBy: options.openedBy ?? currentScope(), spawnOwner: currentSpawnOwner(), ...(v2 ? { scope: currentScope() } : {}),
            };
            if (labels.about?.type === "request") {
              const parentReq = ledger.requests[labels.about.id];
              if (parentReq) {
                parentReq.waitingOn ??= [];
                if (!parentReq.waitingOn.includes(id)) parentReq.waitingOn.push(id);
              }
            }
            byAddress.set(reformAddress, request);
            log.push({ kind: "opened", request: { ...request } });
          } else if (request.reply === null) {
            const by = clampBy(instant(labels.by, request.openedAt));
            if (by !== request.by) { pass.rescheduled.push({ id: request.id, from: request.by, to: by }); request.by = by; }
            request.detached = false;
          }
          reached.add(request.id);
          if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
          return { value: { type: "request", id: request.id }, at: request.openedAt };
        }
      }

      if (!request) {
        if (!permitted()) return revoked();
        const id = v2 ? nextUniqueRequestId(resolvedAddress) : address;
        const initCandidates = name === "judge" ? null : candidatesOf(args[0], ledger);
        request = ledger.requests[id] = {
          id, ...(v2 ? { address: resolvedAddress } : {}), verb: name, holder, candidates: initCandidates,
          ...(initCandidates ? { initialCandidates: [...initCandidates], initialGroupHolder: holder } : {}),
          excluded: name === "judge" ? [] : excludedOf(args[0], ledger), delegatedBy: null, epoch: 0, text: question.value,
          conditions: conditionsOf(args[0]),
          about: labels.about ? show(labels.about) : null, context: labels.context ? show(labels.context) : null,
          options: choices?.type === "list" ? choices.values : null,
          form: nextForm,
          by: clampBy(instant(labels.by, now)), openedAt: now, reply: null, settledAt: null, detached: false,
          openedBy: options.openedBy ?? currentScope(), spawnOwner: currentSpawnOwner(), ...(v2 ? { scope: currentScope() } : {}),
          ...(terms !== undefined ? { terms } : {}),
        };
        if (pendingSupersede) { pass.superseded.push({ ...pendingSupersede, by: id }); pendingSupersede = null; }
        if (labels.about?.type === "request") {
          const parentReq = ledger.requests[labels.about.id];
          if (parentReq) {
            parentReq.waitingOn ??= [];
            if (!parentReq.waitingOn.includes(id)) parentReq.waitingOn.push(id);
          }
        }
        if (v2) byAddress.set(resolvedAddress, request);
        log.push({ kind: "opened", request: { ...request } });
      } else if (request.reply === null) {
        // The deadline and form are not part of who is asked what: moving them amends the same request.
        const by = clampBy(instant(labels.by, request.openedAt));
        if (by !== request.by) { pass.rescheduled.push({ id: request.id, from: request.by, to: by }); request.by = by; }
        if (v2 && JSON.stringify(request.form) !== JSON.stringify(nextForm)) {
          pass.formChanged.push({ id: request.id, from: request.form, to: nextForm });
          request.form = nextForm;
        }
        request.detached = false;
      }
      reached.add(request.id);
      // A deadline already reached when it is recorded has passed: no later scan is needed to say so.
      if (request.reply === null && request.by !== null && request.by <= now) close(request, { tag: "NoReply" }, request.by);
      return { value: { type: "request", id: request.id }, at: request.openedAt };
    }

    // --- Scoped v2 `forEach` loop with occurrence-keyed rounds & sealed rounds ---
    if (v2 && effect.loop) {
      let storageKey: string;
      let displayKey: string;
      if (effect.loop === "begins") {
        const parentScope = currentScope();
        const loopName = effect.loopKey ?? "$default";
        let used = loopsUsedInScope.get(parentScope);
        if (!used) { used = new Set(); loopsUsedInScope.set(parentScope, used); }
        if (used.has(loopName)) {
          throw new ProgramError(effect.loopKey === null
            ? "More than one unnamed forEach loop in the same scope; add ~key=\"...\" to each forEach"
            : `Duplicate forEach ~key="${effect.loopKey}" in the same scope`);
        }
        used.add(loopName);
        displayKey = parentScope === "root" ? `loop:${loopName}` : `loop:${parentScope}/${loopName}`;
        storageKey = resolveEntryKey(displayKey);
        activeLoopStack.push({ storageKey, displayKey });
      } else {
        const frame = activeLoopStack.at(-1);
        if (!frame) throw new ProgramError("Unexpected forEach continuation outside a loop");
        storageKey = frame.storageKey;
        displayKey = frame.displayKey;
      }

      // A loop over `Holds.members` sees the whole held set, not only what changes after it began.
      const heldSets = hostStreams(args[0]!).filter(source => source.name === "Holds.members");
      for (const source of heldSets) {
        const kindKey = holdKindKey(source.args[0]!);
        if (!pass.holding.includes(kindKey)) pass.holding.push(kindKey);
      }
      const rawEntry = entry(storageKey, () => ({
        at: now,
        value: {
          startedAt: now, from: ledger.occurrences.length,
          streams: Object.fromEntries(heldSets.map(source => [eventKey(source as unknown as Value), 0])), lastTimerAt: null,
          timerSpec: null, sealedRounds: 0, sealedTimerInstants: [], active: null,
        } as unknown as Json,
      }));
      const state = structuredClone(rawEntry.value as unknown as LoopState);

      const eachStrategy = effect.eachStrategy ?? "Latest";
      const partitionOf = (val: Value): string | undefined => {
        if (!effect.perKey) return undefined;
        try {
          return show(runPure(code, effect.perKey, val, activeMachine, now));
        } catch (error) {
          throw new ProgramError(error instanceof Error ? error.message : String(error));
        }
      };

      // Concurrent `~each=Together`: ingest every arrived occurrence into `state.activeRounds`
      // and drive each in-flight round in its own isolated scope on every pass.
      if (eachStrategy === "Together") {
        if (!effect.callback) throw new ProgramError("forEach ~each=Together requires a callback");
        const provisionalBegan = state.lastTimerAt ?? state.startedAt;
        let detailed = detailedTargetsOf(ledger, args[0], provisionalBegan);
        const nextSpec = timerSpecOf(detailed);
        let began = provisionalBegan;
        if (state.timerSpec !== null && state.timerSpec !== nextSpec) {
          began = Math.max(provisionalBegan, now);
          state.lastTimerAt = began;
          state.timerSpec = nextSpec;
          detailed = detailedTargetsOf(ledger, args[0], began);
        } else if (state.timerSpec === null) {
          state.timerSpec = nextSpec;
        }
        if (!permitted()) return revoked();
        const targets = detailed.map(item => item.target);
        const scanStates = loadScanStates(storageKey);
        const activeRounds = [...(state.activeRounds ?? [])];
        let loopNextDue: number | null = null;
        const trackDue = (at: number): void => {
          due(at);
          if (at > now && (loopNextDue === null || at < loopNextDue)) loopNextDue = at;
        };
        for (const item of detailed) {
          const { target, ops, timer } = item;
          if (target.kind === "timer") {
            let tickAt = target.at;
            const period = timer?.kind === "every" ? timer.period : 0;
            let guard = 0;
            while (tickAt <= now && guard++ < 10_000) {
              if (!state.sealedTimerInstants.includes(tickAt)) {
                const transformed = applyOps(code, activeMachine, { type: "time", value: String(tickAt) }, ops, now, tickAt, scanStates);
                state.sealedTimerInstants.push(tickAt);
                if (transformed !== null) {
                  activeRounds.push({ roundKey: `timer@${tickAt}`, at: tickAt, value: transformed, partKey: partitionOf(transformed) });
                  log.push({ kind: "waited", targets, until: null, at: tickAt, value: transformed });
                }
              }
              if (period <= 0) { tickAt = Number.POSITIVE_INFINITY; break; }
              tickAt += period;
            }
            if (Number.isFinite(tickAt) && tickAt > now) trackDue(tickAt);
          } else if (target.kind === "stream") {
            const streamKey = eventKey(target.source);
            const from = state.streams[streamKey] ?? state.from;
            const arrived = ledger.occurrences.flatMap((occurrence, index) => index >= from && occurrence.key === streamKey ? [{ ...occurrence, index }] : []);
            if (!arrived.length) continue;
            const streamDigest = sha256(streamKey).slice(0, 12);
            const lastIndex = arrived.at(-1)!.index;
            for (const occurrence of arrived) {
              const transformed = applyOps(code, activeMachine, occurrence.value, ops, now, occurrence.at, scanStates);
              if (transformed !== null) {
                activeRounds.push({
                  roundKey: `stream:${streamDigest}#${occurrence.index}`,
                  at: occurrence.at,
                  value: transformed,
                  partKey: partitionOf(transformed),
                });
                log.push({ kind: "waited", targets, until: null, at: occurrence.at, value: transformed });
              }
            }
            state.streams[streamKey] = Math.max(state.streams[streamKey] ?? state.from, lastIndex + 1);
          }
        }
        saveScanStates(storageKey, scanStates);

        // Under `~per`, a partition keeps one round: a newer occurrence in it takes the place of the round before,
        // and whatever that round left open is cancelled. Other partitions go on untouched.
        if (effect.perKey) {
          const latest = new Map<string, number>();
          activeRounds.forEach((round, index) => { if (round.partKey !== undefined) latest.set(round.partKey, index); });
          const inFlight = new Set((state.activeRounds ?? []).map(round => round.roundKey));
          for (let index = activeRounds.length - 1; index >= 0; index--) {
            const round = activeRounds[index]!;
            if (round.partKey === undefined || latest.get(round.partKey) === index) continue;
            activeRounds.splice(index, 1);
            if (!inFlight.has(round.roundKey)) continue;
            // Requests of the round itself, and of loops and spawns nested in it, whose scope path runs through it.
            const roundScope = `${displayKey}/round:${round.roundKey}`;
            for (const req of Object.values(ledger.requests)) {
              const at = req.scope ?? (req.address ?? req.id).replace(/^request:/u, "");
              if (req.reply === null && (at === roundScope || at.startsWith(`${roundScope}/`) || at.includes(`${roundScope}/`))) {
                close(req, { tag: "Cancelled" }, now);
                if (req.verb === "spawn") cancelSpawnChildren(req.id);
              }
            }
            state.sealedRounds += 1;
          }
        }

        const stillOpenRounds: typeof activeRounds = [];
        for (const round of activeRounds) {
          const prevMachine = activeMachine;
          const childMachine = startClosure(code, effect.callback, [round.value], prevMachine, now);
          scopeStack.push(`${displayKey}/round:${round.roundKey}`);
          activeMachine = childMachine;
          const outcome = driveMachine(childMachine);
          activeMachine = prevMachine;
          scopeStack.pop();
          if (outcome.kind === "done") {
            const isFailureOutcome = outcome.value.type === "variant" &&
              (["NoReply", "Cancelled", "Revoked"].includes(outcome.value.name) ||
               ((outcome.value.name === "Refused" || outcome.value.name === "Broke") && outcome.value.args.length === 1 && outcome.value.args[0]?.type === "string"));
            if (isFailureOutcome) {
              const rKey = identity("report", { round: round.roundKey, outcome: outcome.value });
              if (!ledger.entries[rKey]) log.push({ kind: "handlerFailed", reply: outcome.value });
              entry(rKey, () => ({ at: now, value: outcome.value as unknown as Json }));
            }
            state.sealedRounds += 1;
          } else if (outcome.kind === "failed") {
            const replyVal = outcome.outcome ?? variant("Broke", text(outcome.error ?? "Round failed"));
            const rKey = identity("report", { round: round.roundKey, outcome: replyVal });
            if (!ledger.entries[rKey]) log.push({ kind: "handlerFailed", reply: replyVal });
            entry(rKey, () => ({ at: now, value: replyVal as unknown as Json }));
            state.sealedRounds += 1;
          } else {
            stillOpenRounds.push(round);
          }
        }
        state.activeRounds = stillOpenRounds;
        if (effect.perKey) {
          for (const round of stillOpenRounds) {
            if (round.partKey !== undefined) pass.branches.push({ loop: displayKey, scope: `${displayKey}/round:${round.roundKey}`, partition: round.partKey });
          }
        }
        if (!state.waitingLogged) {
          log.push({ kind: "waiting", targets, until: null });
          state.waitingLogged = true;
        }
        ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        pass.loops.push({
          key: displayKey,
          sealedRounds: state.sealedRounds,
          activeRound: stillOpenRounds[0]?.roundKey ?? null,
          nextDue: loopNextDue,
        });
        pass.waiting = { targets, until: null };
        return null;
      }

      if (effect.loop === "continues") {
        // Seal the finished round atomically before checking for the next occurrence.
        scopeStack.pop();
        if (state.active) {
          state.sealedRounds += 1;
          // Advance timer beat cursor to `now` so ticks that passed while the handler worked are not made up,
          // while `every` still stays aligned to its anchor.
          state.lastTimerAt = Math.max(state.lastTimerAt ?? state.startedAt, state.active.timerAt ?? 0, now);
          if (state.active.timerAt !== undefined && !state.sealedTimerInstants.includes(state.active.timerAt)) {
            state.sealedTimerInstants.push(state.active.timerAt);
          }
          if (state.active.streamTaken) {
            const prev = state.streams[state.active.streamTaken.stream] ?? state.from;
            state.streams[state.active.streamTaken.stream] = Math.max(prev, state.active.streamTaken.next);
          }
          state.active = null;
          state.waitingLogged = false;
          ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        }
      } else if (state.active) {
        // Under `~each=Restart`, if a newer occurrence has arrived on any listened stream
        // (matching `~per` partition when set), cancel the active round and restart.
        let restarted = false;
        if (eachStrategy === "Restart") {
          const checkDetailed = detailedTargetsOf(ledger, args[0], state.lastTimerAt ?? state.startedAt);
          const scanCheck = loadScanStates(storageKey);
          const hasNewer = checkDetailed.some(item => {
            if (item.target.kind !== "stream") return false;
            const streamKey = eventKey(item.target.source);
            const activeNext = state.active?.streamTaken?.stream === streamKey ? state.active.streamTaken.next : (state.streams[streamKey] ?? state.from);
            const newer = ledger.occurrences.filter((occ, idx) => idx >= activeNext && occ.key === streamKey);
            if (!newer.length) return false;
            if (!effect.perKey) return true;
            return newer.some(occ => {
              const transformed = applyOps(code, activeMachine, occ.value, item.ops, now, occ.at, new Map(scanCheck));
              return transformed !== null && partitionOf(transformed) === state.active?.partKey;
            });
          });
          if (hasNewer) {
            const activePrefix = `request:${displayKey}/round:${state.active.roundKey}/`;
            for (const req of Object.values(ledger.requests)) {
              if (req.reply === null && (req.address ?? req.id).startsWith(activePrefix)) {
                close(req, { tag: "Cancelled" }, now);
                if (req.verb === "spawn") cancelSpawnChildren(req.id);
              }
            }
            if (state.active.streamTaken) {
              const prev = state.streams[state.active.streamTaken.stream] ?? state.from;
              state.streams[state.active.streamTaken.stream] = Math.max(prev, state.active.streamTaken.next);
            }
            state.sealedRounds += 1;
            state.active = null;
            state.waitingLogged = false;
            ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
            restarted = true;
          }
        }
        if (!restarted && state.active) {
          // An in-flight round is already active: enter its scope directly without re-evaluating sealed rounds.
          const roundScope = `${displayKey}/round:${state.active.roundKey}`;
          scopeStack.push(roundScope);
          pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: state.active.roundKey, nextDue: null });
          lastWaitEvaluated = true;
          return { value: state.active.value, at: Math.max(state.active.at, state.lastTimerAt ?? state.startedAt) };
        }
      }

      // Drain any frozen `~each=Batch` / partitioned `~per` queue before polling new arrivals.
      if (state.pendingQueue?.length) {
        const nextQueued = state.pendingQueue.shift()!;
        const detailed = detailedTargetsOf(ledger, args[0], state.lastTimerAt ?? state.startedAt);
        const targets = detailed.map(item => item.target);
        if (!state.waitingLogged) log.push({ kind: "waiting", targets, until: null });
        state.waitingLogged = true;
        state.active = {
          roundKey: nextQueued.roundKey,
          at: nextQueued.at,
          value: nextQueued.value,
          ...(nextQueued.partKey !== undefined ? { partKey: nextQueued.partKey } : {}),
        };
        ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        scopeStack.push(`${displayKey}/round:${nextQueued.roundKey}`);
        pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: nextQueued.roundKey, nextDue: null });
        log.push({ kind: "waited", targets, until: null, at: nextQueued.at, value: nextQueued.value });
        lastWaitEvaluated = true;
        return { value: nextQueued.value, at: Math.max(nextQueued.at, state.lastTimerAt ?? state.startedAt) };
      }

      // Select the next occurrence for this loop.
      const provisionalBegan = state.lastTimerAt ?? state.startedAt;
      let detailed = detailedTargetsOf(ledger, args[0], provisionalBegan);
      const nextSpec = timerSpecOf(detailed);
      let began = provisionalBegan;
      if (state.timerSpec !== null && state.timerSpec !== nextSpec) {
        // Schedule edited: never create past rounds; next tick is strictly after max(cursor, edit_time).
        began = Math.max(provisionalBegan, now);
        state.lastTimerAt = began;
        state.timerSpec = nextSpec;
        detailed = detailedTargetsOf(ledger, args[0], began);
      } else if (state.timerSpec === null) {
        state.timerSpec = nextSpec;
      }

      if (!permitted()) return revoked();
      const targets = detailed.map(item => item.target);
      const candidates: (Candidate & { queuedRest?: { roundKey: string; at: number; value: Value; partKey?: string }[]; partKey?: string })[] = [];
      const rejectedStreamProgress = new Map<string, number>();
      const scanStates = loadScanStates(storageKey);
      let loopNextDue: number | null = null;
      const trackDue = (at: number): void => {
        due(at);
        if (at > now && (loopNextDue === null || at < loopNextDue)) loopNextDue = at;
      };

      for (const item of detailed) {
        const { target, ops, timer } = item;
        if (target.kind === "timer") {
          let tickAt = target.at;
          const period = timer?.kind === "every" ? timer.period : 0;
          // Advance past any already-sealed or filtered-out ticks up to `now`.
          let guard = 0;
          while (tickAt <= now && guard++ < 10_000) {
            if (!state.sealedTimerInstants.includes(tickAt)) {
              const transformed = applyOps(code, activeMachine, { type: "time", value: String(tickAt) }, ops, now, tickAt, scanStates);
              if (transformed !== null) {
                candidates.push({ at: tickAt, value: transformed, rank: 2, roundKey: `timer@${tickAt}`, timerAt: tickAt, evaluated: true });
                break;
              }
            }
            if (period <= 0) { tickAt = Number.POSITIVE_INFINITY; break; }
            tickAt += period;
          }
          if (Number.isFinite(tickAt) && tickAt > now) trackDue(tickAt);
        } else if (target.kind === "fact") {
          if (target.source.name === "taken") {
            const reqId = (target.source.args[0] as Extract<Value, { type: "request" }>).id;
            const takenAt = ledger.requests[reqId]?.takenAt ?? null;
            if (takenAt !== null) {
              const transformed = applyOps(code, activeMachine, { type: "time", value: String(takenAt) }, ops, now, takenAt, scanStates);
              if (transformed !== null) {
                candidates.push({ at: Math.max(takenAt, began), value: transformed, rank: 2, roundKey: `taken:${reqId}`, evaluated: true });
              }
            }
          } else {
            const fact = ledger.facts[eventKey(target.source)];
            if (fact) {
              const transformed = applyOps(code, activeMachine, fact.value, ops, now, fact.at, scanStates);
              if (transformed !== null) {
                candidates.push({ at: Math.max(fact.at, began), value: transformed, rank: 2, roundKey: `fact:${sha256(eventKey(target.source)).slice(0, 12)}`, evaluated: true });
              }
            }
          }
        } else if (target.kind === "stream") {
          const streamKey = eventKey(target.source);
          const from = state.streams[streamKey] ?? state.from;
          const arrived = ledger.occurrences.flatMap((occurrence, index) => index >= from && occurrence.key === streamKey ? [{ ...occurrence, index }] : []);
          if (!arrived.length) continue;
          const streamDigest = sha256(streamKey).slice(0, 12);
          const lastIndex = arrived.at(-1)!.index;
          if (target.gathered) {
            const transformed = applyOps(code, activeMachine, { type: "list", values: arrived.map(each => each.value) }, ops, now, arrived[0].at, scanStates);
            if (transformed !== null) {
              candidates.push({
                at: arrived[0].at, value: transformed, rank: 2,
                taken: { stream: streamKey, next: lastIndex + 1 },
                roundKey: `stream:${streamDigest}#${arrived[0].index}-${lastIndex}`,
                evaluated: true,
              });
            } else {
              rejectedStreamProgress.set(streamKey, lastIndex + 1);
            }
          } else {
            const matched: { at: number; index: number; value: Value; partKey?: string }[] = [];
            for (const occurrence of arrived) {
              const transformed = applyOps(code, activeMachine, occurrence.value, ops, now, occurrence.at, scanStates);
              if (transformed !== null) {
                matched.push({ at: occurrence.at, index: occurrence.index, value: transformed, partKey: partitionOf(transformed) });
                if (eachStrategy === "Queue") break;
              }
            }
            if (matched.length) {
              if (eachStrategy === "Batch") {
                const [first, ...rest] = matched;
                candidates.push({
                  at: first!.at, value: first!.value, rank: 2,
                  taken: { stream: streamKey, next: lastIndex + 1 },
                  roundKey: `stream:${streamDigest}#${first!.index}`,
                  partKey: first!.partKey,
                  queuedRest: rest.map(m => ({ roundKey: `stream:${streamDigest}#${m.index}`, at: m.at, value: m.value, ...(m.partKey !== undefined ? { partKey: m.partKey } : {}) })),
                  evaluated: true,
                });
              } else if (effect.perKey && (eachStrategy === "Latest" || eachStrategy === "Restart")) {
                // Collapse burst per partition key so distinct partitions never drop each other's events.
                const byPart = new Map<string, (typeof matched)[number]>();
                for (const m of matched) byPart.set(m.partKey ?? "", m);
                const collapsed = [...byPart.values()].sort((a, b) => a.index - b.index);
                const [first, ...rest] = collapsed;
                candidates.push({
                  at: first!.at, value: first!.value, rank: 2,
                  taken: { stream: streamKey, next: lastIndex + 1 },
                  roundKey: `stream:${streamDigest}#${first!.index}`,
                  partKey: first!.partKey,
                  queuedRest: rest.map(m => ({ roundKey: `stream:${streamDigest}#${m.index}`, at: m.at, value: m.value, ...(m.partKey !== undefined ? { partKey: m.partKey } : {}) })),
                  evaluated: true,
                });
              } else {
                const first = matched[0], latest = matched.at(-1)!;
                const picked = eachStrategy === "Queue" ? first : latest;
                const nextCursor = eachStrategy === "Queue" ? picked.index + 1 : lastIndex + 1;
                candidates.push({
                  at: picked.at, value: picked.value, rank: 2,
                  taken: { stream: streamKey, next: nextCursor },
                  roundKey: `stream:${streamDigest}#${picked.index}`,
                  partKey: picked.partKey,
                  evaluated: true,
                });
              }
            } else {
              rejectedStreamProgress.set(streamKey, lastIndex + 1);
            }
          }
        }
      }

      saveScanStates(storageKey, scanStates);

      candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
      const winner = candidates[0];
      if (!winner) {
        // Advance stream cursors past rejected occurrences (filtering is non-retroactive).
        for (const [streamKey, next] of rejectedStreamProgress) {
          state.streams[streamKey] = Math.max(state.streams[streamKey] ?? state.from, next);
        }
        if (!state.waitingLogged) {
          log.push({ kind: "waiting", targets, until: null });
          state.waitingLogged = true;
        }
        ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
        pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: null, nextDue: loopNextDue });
        pass.waiting = { targets, until: null };
        return null;
      }

      if (!state.waitingLogged) log.push({ kind: "waiting", targets, until: null });
      state.waitingLogged = true;
      if (winner.queuedRest?.length) {
        state.pendingQueue = [...(state.pendingQueue ?? []), ...winner.queuedRest];
      }
      state.active = {
        roundKey: winner.roundKey!,
        at: winner.at,
        value: winner.value,
        ...(winner.taken ? { streamTaken: winner.taken } : {}),
        ...(winner.timerAt !== undefined ? { timerAt: winner.timerAt } : {}),
        ...(winner.partKey !== undefined ? { partKey: winner.partKey } : {}),
      };
      ledger.entries[storageKey] = { at: now, value: state as unknown as Json };
      const roundScope = `${displayKey}/round:${winner.roundKey!}`;
      scopeStack.push(roundScope);
      pass.loops.push({ key: displayKey, sealedRounds: state.sealedRounds, activeRound: winner.roundKey!, nextDue: loopNextDue });
      log.push({ kind: "waited", targets, until: null, at: winner.at, value: winner.value });
      lastWaitEvaluated = true;
      return { value: winner.value, at: Math.max(winner.at, began) };
    }

    // --- Legacy v1 `forEach` bookkeeping (only for unmigrated v1 ledgers) ---
    if (!v2 && effect.loop && ((effect.eachStrategy && effect.eachStrategy !== "Latest") || effect.perKey)) {
      throw new ProgramError(`forEach ~each=${effect.eachStrategy ?? "Latest"}${effect.perKey ? " / ~per" : ""} requires an identityScheme 2 ledger; migrate this v1 ledger first`);
    }
    const loop = !v2 && effect.loop ? `forEach:${sha256(eventKey(args[0])).slice(0, 16)}` : null;
    if (loop) {
      const handled = `${loop}/handled`;
      if (effect.loop === "continues") ledger.entries[handled] = { at: now, value: Object.fromEntries(seen) };
      else for (const [kind, count] of Object.entries((ledger.entries[handled]?.value ?? {}) as Record<string, number>)) {
        seen.set(kind, Math.max(seen.get(kind) ?? 0, count));
      }
    }

    // --- Plain `wait` / `waitUntil` (and v1 `forEach` waits) ---
    if (name === "wait" || name === "waitUntil") {
      if (args.length !== (name === "waitUntil" ? 2 : 1)) throw new ProgramError(`${name} needs a target${name === "waitUntil" ? " and a positional deadline" : ""}`);
      const targetKey = v2 ? stripSourceFunctions(args[0]) : args[0];
      const key = identity("wait", { target: targetKey, until: args[1] ?? null });
      const fresh = !ledger.entries[`${key}/began`];
      const taken = loop ? entry(`${loop}/taken`, () => ({ at: now, value: { from: ledger.occurrences.length, streams: {} } })) : null;
      const beginning = entry(`${key}/began`, () => ({ at: now, value: taken ? structuredClone(taken.value) : ledger.occurrences.length }));
      const began = beginning.at, position = beginning.value as unknown as number | Taken;
      const cursor = (stream: string): number => typeof position === "number" ? position : position.streams[stream] ?? position.from;
      let ended = ledger.entries[key];
      const detailed = detailedTargetsOf(ledger, args[0], began);
      const usePureEval = hasFilterOp(detailed);
      if (!ended) {
        const targets = detailed.map(item => item.target);
        const until = name === "waitUntil" ? instant(args[1], began)! : null;
        const lost = !permitted();
        if (lost && args[0].type !== "request") return revoked();
        if (fresh) log.push({ kind: "waiting", targets, until });
        const candidates: Candidate[] = [];
        const occurred = (at: number, value: Value, path: Path, rank: 0 | 2 = 2, from?: Candidate["taken"], alreadyWrapped = false): void => {
          if (at <= now) {
            const wrapped = alreadyWrapped ? value : path.reduceRight((inner, side) => variant(side, inner), value);
            candidates.push({ at, value: wrapped, rank, ...(from ? { taken: from } : {}), ...(alreadyWrapped ? { evaluated: true } : {}) });
          } else due(at);
        };
        const scanStates = loadScanStates(key);
        for (const item of detailed) {
          const { target, ops, timer } = item;
          if (target.kind === "request") {
            const request = ledger.requests[target.id];
            if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
            if (request.reply) {
              const tr = applyRequestTransforms(activeMachine, args[0], request, request.reply);
              if (tr.ok) {
                occurred(request.settledAt!, replyValue(tr.reply), [], tr.reply.tag === "NoReply" ? 0 : 2);
              }
            }
            else if (request.by !== null) due(request.by);
          } else if (target.kind === "timer") {
            if (!usePureEval) {
              occurred(target.at, { type: "time", value: String(target.at) }, target.path);
            } else {
              let tickAt = target.at;
              const period = timer?.kind === "every" ? timer.period : 0;
              let guard = 0;
              while (tickAt <= now && guard++ < 10_000) {
                const transformed = applyOps(code, activeMachine, { type: "time", value: String(tickAt) }, ops, now, tickAt, scanStates);
                if (transformed !== null) { occurred(tickAt, transformed, target.path, 2, undefined, true); break; }
                if (period <= 0) { tickAt = Number.POSITIVE_INFINITY; break; }
                tickAt += period;
              }
              if (Number.isFinite(tickAt) && tickAt > now) due(tickAt);
            }
          } else if (target.kind === "fact") {
            if (target.source.name === "taken") {
              const reqId = (target.source.args[0] as Extract<Value, { type: "request" }>).id;
              const takenAt = ledger.requests[reqId]?.takenAt ?? null;
              if (takenAt !== null) {
                const rawTime: Value = { type: "time", value: String(takenAt) };
                if (!usePureEval) occurred(Math.max(takenAt, began), rawTime, target.path);
                else {
                  const transformed = applyOps(code, activeMachine, rawTime, ops, now, takenAt, scanStates);
                  if (transformed !== null) occurred(Math.max(takenAt, began), transformed, target.path, 2, undefined, true);
                }
              }
            } else {
              const fact = ledger.facts[eventKey(target.source)];
              if (fact) {
                if (!usePureEval) occurred(Math.max(fact.at, began), fact.value, target.path);
                else {
                  const transformed = applyOps(code, activeMachine, fact.value, ops, now, fact.at, scanStates);
                  if (transformed !== null) occurred(Math.max(fact.at, began), transformed, target.path, 2, undefined, true);
                }
              }
            }
          } else {
            const stream = eventKey(target.source), from = cursor(stream);
            const arrived = ledger.occurrences.flatMap((occurrence, index) => index >= from && occurrence.key === stream ? [{ ...occurrence, index }] : []);
            const [next] = arrived;
            const latest = arrived.at(-1);
            if (!usePureEval) {
              if (next && target.gathered) occurred(next.at, { type: "list", values: arrived.map(each => each.value) }, target.path, 2, { stream, next: latest!.index + 1 });
              else if (next && loop) occurred(next.at, latest!.value, target.path, 2, { stream, next: latest!.index + 1 });
              else if (next) occurred(next.at, next.value, target.path, 2, { stream, next: next.index + 1 });
            } else if (next) {
              if (target.gathered) {
                const transformed = applyOps(code, activeMachine, { type: "list", values: arrived.map(each => each.value) }, ops, now, next.at, scanStates);
                if (transformed !== null) occurred(next.at, transformed, target.path, 2, { stream, next: latest!.index + 1 }, true);
              } else {
                const matched: { at: number; index: number; value: Value }[] = [];
                for (const occurrence of arrived) {
                  const transformed = applyOps(code, activeMachine, occurrence.value, ops, now, occurrence.at, scanStates);
                  if (transformed !== null) {
                    matched.push({ at: occurrence.at, index: occurrence.index, value: transformed });
                    if (!loop) break;
                  }
                }
                if (matched.length) {
                  const picked = loop ? matched.at(-1)! : matched[0];
                  occurred(matched[0].at, picked.value, target.path, 2, { stream, next: loop ? latest!.index + 1 : picked.index + 1 }, true);
                }
              }
            }
          }
        }
        saveScanStates(key, scanStates);
        if (until !== null) { if (until <= now) candidates.push({ at: until, value: unit, rank: 1 }); else due(until); }
        candidates.sort((a, b) => a.at - b.at || a.rank - b.rank);
        const winner = candidates[0];
        if (!winner) { pass.waiting = { targets, until }; return null; }
        const elapsed = winner.rank === 1;
        const value = name === "waitUntil" ? (elapsed ? variant("None") : variant("Some", winner.value)) : winner.value;
        ended = ledger.entries[key] = { at: winner.at, value: value as unknown as Json };
        if (loop && winner.taken) {
          const stands = ledger.entries[`${loop}/taken`].value as unknown as Taken;
          ledger.entries[`${loop}/taken`] = { at: now, value: { from: stands.from, streams: { ...stands.streams, [winner.taken.stream]: winner.taken.next } } };
        }
        log.push({ kind: "waited", targets, until, at: winner.at, value: elapsed ? null : winner.value });
        if (winner.evaluated) lastWaitEvaluated = true;
      } else if (usePureEval) {
        lastWaitEvaluated = true;
      }
      return { value: ended.value as unknown as Value, at: Math.max(ended.at, began) };
    }

    if (name === "first") {
      const list = args[0];
      if (args.length !== 1 || list.type !== "list" || !list.values.length) throw new ProgramError("first needs a nonempty list of requests");
      const reqPairs = list.values.map(value => ({ val: value, req: handle(name, value) }));
      const requests = reqPairs.map(pair => pair.req);
      const key = identity("first", { ids: requests.map(request => request.id) });
      let won = ledger.entries[key];
      if (!won) {
        const lost = !permitted();
        for (const request of requests) if (lost && request.reply === null) close(request, { tag: "Revoked" }, now);
        const ended = reqPairs
          .filter(pair => pair.req.reply !== null && pair.req.settledAt! <= now)
          .sort((a, b) => a.req.settledAt! - b.req.settledAt!);
        let chosen: { req: LedgerRequest; reply: Reply } | null = null;
        for (const item of ended) {
          const tr = applyRequestTransforms(activeMachine, item.val, item.req, item.req.reply!);
          if (tr.ok) { chosen = { req: item.req, reply: tr.reply }; break; }
        }
        if (!chosen) {
          for (const request of requests) if (request.by !== null) due(request.by);
          pass.waiting = { targets: requests.map(request => ({ kind: "request", id: request.id })), until: null };
          return null;
        }
        won = ledger.entries[key] = { at: chosen.req.settledAt!, value: chosen.req.id };
      }
      const winnerPair = reqPairs.find(pair => pair.req.id === (won.value as string));
      const winner = ledger.requests[won.value as string];
      const winnerTr = winnerPair && winner.reply ? applyRequestTransforms(activeMachine, winnerPair.val, winner, winner.reply) : null;
      const finalReply = winnerTr?.ok ? winnerTr.reply : winner.reply!;
      return { value: { type: "tuple", values: [winnerPair?.val ?? { type: "request", id: winner.id }, replyValue(finalReply)] }, at: Math.max(won.at, ledger.startedAt) };
    }

    if (name === "say") {
      if (args.length !== 2 || !["participant", "ref", "request"].includes(args[0].type) || args[1].type !== "string") {
        throw new ProgramError("say needs a participant, a reference or a request, and text");
      }
      const body = args[1].value;
      if (args[0].type === "request") {
        const req = handle("say", args[0]);
        const key = identity("say", { to: req.id, body });
        if (!ledger.entries[key]) {
          if (!permitted()) return revoked();
          addNote(ledger, req.id, options.openedBy ?? currentScope(), body, now);
          log.push({ kind: "said", to: req.id, text: body });
        }
        return { value: unit, at: entry(key, () => ({ at: now, value: null })).at };
      }
      const to = show(args[0]);
      const key = identity("say", { to, body });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        log.push({ kind: "said", to, text: body });
      }
      return { value: unit, at: entry(key, () => ({ at: now, value: null })).at };
    }
    if (name === "Holds.sample") {
      const target = args[0];
      if (args.length !== 1 || target?.type !== "variant" || target.name !== "Held" || target.args[1]?.type !== "string") {
        throw new ProgramError("Holds.sample needs a Holds.held value");
      }
      const kindKey = holdKindKey(target.args[0]!), id = target.args[1].value;
      if (!pass.holding.includes(kindKey)) pass.holding.push(kindKey);
      // Read once in this scope and recorded: a later pass of the same scope reads what this one read.
      const key = `sample:${currentScope()}/${kindKey}/${id}`;
      const read = entry(key, () => {
        const now_ = ledger.holds?.[kindKey]?.[id];
        return { at: now, value: (now_ ? variant("Some", now_.value) : variant("None")) as unknown as Json };
      });
      return { value: read.value as unknown as Value, at: read.at };
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
      if (next !== null && request.action) throw new ProgramError("An action cannot be handed over: the host performs it");
      const key = identity(name, { id: request.id, next });
      if (!ledger.entries[key]) {
        if (!permitted()) return revoked();
        if (request.reply === null && next === null) {
          close(request, { tag: "Cancelled" }, now);
          if (request.verb === "spawn") cancelSpawnChildren(request.id);
        } else if (request.reply === null) {
          log.push({ kind: "handedOver", id: request.id, from: request.holder, to: next! });
          const nextCandidates = candidatesOf(args[1], ledger);
          request.holder = next!; request.candidates = nextCandidates;
          request.initialCandidates = nextCandidates ? [...nextCandidates] : null;
          request.initialGroupHolder = nextCandidates ? next! : null;
          request.excluded = excludedOf(args[1], ledger);
          request.conditions = conditionsOf(args[1]); request.delegatedBy = null; request.takenAt = null; request.epoch++;
        }
      }
      const at = entry(key, () => ({ at: now, value: null })).at;
      return { value: next === null ? unit : { type: "request", id: request.id }, at };
    }
    throw new Error(`The ledger runtime does not implement the effect ${name}`);
  };

  const outcomeToReply = (outcome: Value): Reply => {
    if (outcome.type === "variant") {
      if (outcome.name === "Refused" && outcome.args[0]?.type === "string") return { tag: "Refused", reason: outcome.args[0].value };
      if (outcome.name === "Broke" && outcome.args[0]?.type === "string") return { tag: "Broke", reason: outcome.args[0].value };
      if (outcome.name === "NoReply" || outcome.name === "Cancelled" || outcome.name === "Revoked") return { tag: outcome.name };
    }
    return { tag: "Broke", reason: show(outcome) };
  };

  /** Runs a child (`spawn`) machine to completion, failure, or suspension against the shared ledger. */
  const driveMachine = (target: Machine): { kind: "done"; value: Value } | { kind: "failed"; outcome: Value | null; error: string | null } | { kind: "waiting" } => {
    let childBudget = Math.ceil((options.steps ?? 5_000_000) / 10_000);
    for (;;) {
      advance(code, target, 10_000);
      const control = target.control;
      if (control.kind === "done") return { kind: "done", value: control.value };
      if (control.kind === "error") return { kind: "failed", outcome: null, error: control.message };
      if (control.kind === "failed") return { kind: "failed", outcome: control.outcome, error: null };
      if (control.kind === "report") {
        const key = identity("report", control.outcome);
        if (!ledger.entries[key]) log.push({ kind: "handlerFailed", reply: control.outcome });
        resume(target, unit, entry(key, () => ({ at: now, value: control.outcome as unknown as Json })).at); continue;
      }
      if (control.kind !== "effect") {
        if (--childBudget <= 0) return { kind: "failed", outcome: null, error: "The spawned task computed for too long without waiting or finishing" };
        continue;
      }
      let resumption: { value: Value; at: number } | null;
      try { resumption = answer(control.effect); } catch (error) {
        if (!(error instanceof ProgramError)) throw error;
        return { kind: "failed", outcome: null, error: error.message };
      }
      if (!resumption) return { kind: "waiting" };
      const { name, args } = control.effect;
      const mapped = !lastWaitEvaluated && (name === "wait" || name === "waitUntil") ? through(args[0], resumption.value, name) : null;
      if (mapped) resumeThrough(target, mapped.value, mapped.steps, resumption.at);
      else resume(target, resumption.value, resumption.at);
    }
  };

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
      if (--budget <= 0) { end("failed", null, "The program computed for too long without waiting or finishing"); break; }
      yield; continue;
    }
    let resumption: { value: Value; at: number } | null;
    try { resumption = answer(control.effect); } catch (error) {
      if (!(error instanceof ProgramError)) throw error;
      end("failed", null, error.message); break;
    }
    if (!resumption) break;
    const { name, args } = control.effect;
    const mapped = !lastWaitEvaluated && (name === "wait" || name === "waitUntil") ? through(args[0], resumption.value, name) : null;
    if (mapped) resumeThrough(machine, mapped.value, mapped.steps, resumption.at);
    else resume(machine, resumption.value, resumption.at);
  }

  pass.reached = [...reached];
  if (pass.status === "waiting") pass.listening = machine.frames.flatMap(frame => frame.kind === "forEach" ? hostStreams(frame.stream) : []);
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
 * the difference the pass would make.
 */
export function evaluate(code: Code, ledger: Ledger, now: number, options: PassOptions = {}): Pass {
  const pass = slices(code, ledger, now, options);
  for (;;) {
    const slice = pass.next();
    if (slice.done) return slice.value;
  }
}

/** Two-text edit preview: evaluates both old and new program texts against the same ledger without mutating it. */
export interface EditPreview {
  before: Pass;
  after: Pass;
  /** Open requests reached by both old and new texts. */
  kept: LedgerRequest[];
  /** Requests the new text would open now that the old text did not. */
  opened: LedgerRequest[];
  /** Open requests reached by the old text that the new text no longer reaches. */
  unreached: LedgerRequest[];
  /** Already-answered requests reached by the old text that the new text no longer uses. */
  answeredUnused: LedgerRequest[];
  rescheduled: { id: string; from: number | null; to: number | null }[];
  formChanged: { id: string; from: ReportForm | null; to: ReportForm | null }[];
  incompatibleAnswers: { id: string; reason: string; form: ReportForm | null }[];
  loops: {
    key: string;
    beforeNextDue: number | null;
    afterNextDue: number | null;
    sealedRounds: number;
    status: "kept" | "added" | "removed" | "rescheduled";
  }[];
  nextDue: { before: number | null; after: number | null };
  /** True when the edit makes no observable request or loop-structure difference. */
  empty: boolean;
}

export function previewEdit(beforeCode: Code, afterCode: Code, ledger: Ledger, now: number, options: PassOptions = {}): EditPreview {
  const before = evaluate(beforeCode, ledger, now, { ...options, commit: false });
  const after = evaluate(afterCode, ledger, now, { ...options, commit: false });
  const beforeReached = new Set(before.reached);
  const afterReached = new Set(after.reached);
  const beforeOpenedIds = new Set(before.opened.map(r => r.id));

  const kept: LedgerRequest[] = [];
  const unreached: LedgerRequest[] = [];
  const answeredUnused: LedgerRequest[] = [];
  for (const id of beforeReached) {
    const request = ledger.requests[id];
    if (!request) continue;
    if (afterReached.has(id)) {
      if (request.reply === null) kept.push(request);
    } else if (request.reply === null) {
      unreached.push(request);
    } else if (request.reply.tag === "Answered") {
      answeredUnused.push(request);
    }
  }
  const opened = after.opened.filter(request => !beforeOpenedIds.has(request.id));

  const beforeLoops = new Map(before.loops.map(loop => [loop.key, loop]));
  const afterLoops = new Map(after.loops.map(loop => [loop.key, loop]));
  const allLoopKeys = [...new Set([...beforeLoops.keys(), ...afterLoops.keys()])];
  const loops = allLoopKeys.map(key => {
    const b = beforeLoops.get(key);
    const a = afterLoops.get(key);
    const status: "kept" | "added" | "removed" | "rescheduled" =
      !b ? "added" : !a ? "removed" : b.nextDue !== a.nextDue ? "rescheduled" : "kept";
    return {
      key,
      beforeNextDue: b?.nextDue ?? null,
      afterNextDue: a?.nextDue ?? null,
      sealedRounds: a?.sealedRounds ?? b?.sealedRounds ?? 0,
      status,
    };
  });

  const empty =
    opened.length === 0 &&
    unreached.length === 0 &&
    answeredUnused.length === 0 &&
    after.rescheduled.length === 0 &&
    after.formChanged.length === 0 &&
    after.incompatibleAnswers.length === 0 &&
    after.cancelled.length === 0 &&
    after.said.length === 0 &&
    loops.every(loop => loop.status === "kept") &&
    before.status === after.status;

  return {
    before, after, kept, opened, unreached, answeredUnused,
    rescheduled: after.rescheduled,
    formChanged: after.formChanged,
    incompatibleAnswers: after.incompatibleAnswers,
    loops,
    nextDue: { before: before.nextDue, after: after.nextDue },
    empty,
  };
}

/** Result of a read-only migration attempt from a legacy v1 ledger to identityScheme 2. */
export type MigrationResult =
  | { ok: true; ledger: Ledger; keepLegacy: false; migratedRequests: number; migratedLoops: number }
  | { ok: false; keepLegacy: true; reason: string };

/**
 * Read-only migration prototype: converts a legacy v1 ledger into an
 * `identityScheme: 2` ledger without mutating the input. Preserves every
 * existing request's immutable `id`, `epoch`, `holder`, `delegations`, and
 * delivery fields. Fails closed (`keepLegacy: true`) whenever loop or open
 * request ownership is ambiguous.
 */
export function migrateLedger(code: Code, legacy: Ledger, now: number): MigrationResult {
  if ((legacy.identityScheme ?? 1) === 2) {
    return { ok: true, ledger: structuredClone(legacy), keepLegacy: false, migratedRequests: 0, migratedLoops: 0 };
  }
  const v1Pass = evaluate(code, legacy, now, { commit: false });
  if (v1Pass.status === "failed" && v1Pass.error) {
    return { ok: false, keepLegacy: true, reason: `Legacy pass fails before migration: ${v1Pass.error}` };
  }

  // Inspect legacy loop checkpoints.
  const legacyLoopKeys = [...new Set(
    Object.keys(legacy.entries)
      .filter(key => key.startsWith("forEach:") && (key.endsWith("/taken") || key.endsWith("/handled")))
      .map(key => key.replace(/\/(?:taken|handled)$/u, "")),
  )];
  if (legacyLoopKeys.length > 1) {
    return { ok: false, keepLegacy: true, reason: `Ambiguous ownership: ledger holds ${legacyLoopKeys.length} legacy loops; keep on v1 evaluator` };
  }

  // Probe what loop key(s) the program declares under v2 on a fresh ledger at `legacy.startedAt`.
  const probe = emptyLedger(legacy.startedAt, { identityScheme: 2 });
  const probePass = evaluate(code, probe, legacy.startedAt, { commit: false });
  if (probePass.loops.length > 1 && legacyLoopKeys.length > 0) {
    return { ok: false, keepLegacy: true, reason: "Program declares multiple loops and legacy loop ownership is ambiguous; keep on v1 evaluator" };
  }

  const migrated = structuredClone(legacy);
  migrated.identityScheme = 2;
  let migratedLoops = 0;
  let migratedRequests = 0;

  // Migrate the single unambiguous loop (if present).
  if (legacyLoopKeys.length === 1 && probePass.loops.length === 1) {
    const oldPrefix = legacyLoopKeys[0]!;
    const newLoopKey = probePass.loops[0]!.key;
    const takenEntry = legacy.entries[`${oldPrefix}/taken`];
    const takenVal = takenEntry?.value as unknown as Taken | undefined;

    // Find the latest settled wait timestamp in legacy entries to seed `lastTimerAt` accurately.
    let lastWaitAt: number | null = null;
    const sealedTimerInstants: number[] = [];
    for (const [key, item] of Object.entries(legacy.entries)) {
      if (!key.startsWith("wait:") || key.endsWith("/began")) continue;
      if (lastWaitAt === null || item.at > lastWaitAt) lastWaitAt = item.at;
      const val = item.value as unknown as Value | undefined;
      if (val && typeof val === "object") {
        const unwrapTime = (v: Value): number | null => {
          if (v.type === "time") return Number(v.value);
          if (v.type === "variant" && (v.name === "First" || v.name === "Second") && v.args.length === 1) return unwrapTime(v.args[0]);
          return null;
        };
        const t = unwrapTime(val);
        if (t !== null && !sealedTimerInstants.includes(t)) sealedTimerInstants.push(t);
      }
    }

    const openRequests = Object.values(migrated.requests).filter(r => r.reply === null && v1Pass.reached.includes(r.id));
    if (openRequests.length > 1) {
      return { ok: false, keepLegacy: true, reason: "Multiple simultaneous open requests inside a legacy loop cannot be attributed unambiguously; keep on v1 evaluator" };
    }

    const activeRequest = openRequests[0];
    let active: LoopState["active"] = null;
    if (activeRequest) {
      // Find the latest settled loop wait that started this active round.
      const waitEntries = Object.entries(legacy.entries)
        .filter(([key]) => key.startsWith("wait:") && !key.endsWith("/began"))
        .sort(([, a], [, b]) => b.at - a.at);
      const latestWait = waitEntries[0]?.[1];
      if (!latestWait) {
        return { ok: false, keepLegacy: true, reason: "Open request inside legacy loop has no triggering wait entry; keep on v1 evaluator" };
      }
      const roundKey = `migrated@${latestWait.at}`;
      active = { roundKey, at: latestWait.at, value: latestWait.value as unknown as Value };
      // Re-index this open request at its new v2 round address while keeping its immutable `id` and `epoch`.
      const roundProbe = structuredClone(migrated);
      const stateForProbe: LoopState = {
        startedAt: takenEntry?.at ?? legacy.startedAt,
        from: takenVal?.from ?? legacy.occurrences.length,
        streams: takenVal?.streams ? { ...takenVal.streams } : {},
        lastTimerAt: lastWaitAt,
        timerSpec: null,
        sealedRounds: Object.values(legacy.requests).filter(r => r.reply !== null).length,
        sealedTimerInstants,
        active,
      };
      roundProbe.entries[newLoopKey] = { at: now, value: stateForProbe as unknown as Json };
      // Temporarily hide requests so probe reveals the exact v2 address the code expects for the active request.
      roundProbe.requests = {};
      const probeRound = evaluate(code, roundProbe, now, { commit: false });
      const matching = probeRound.opened.find(r => r.verb === activeRequest.verb && r.holder === activeRequest.holder && r.text === activeRequest.text);
      if (!matching?.address) {
        return { ok: false, keepLegacy: true, reason: "Could not align open legacy loop request to a v2 round address; keep on v1 evaluator" };
      }
      activeRequest.address = matching.address;
      migratedRequests += 1;
    }

    const loopState: LoopState = {
      startedAt: takenEntry?.at ?? legacy.startedAt,
      from: takenVal?.from ?? legacy.occurrences.length,
      streams: takenVal?.streams ? { ...takenVal.streams } : {},
      lastTimerAt: lastWaitAt,
      timerSpec: null,
      sealedRounds: Object.values(legacy.requests).filter(r => r.reply !== null).length,
      sealedTimerInstants,
      active,
    };
    migrated.entries[newLoopKey] = { at: now, value: loopState as unknown as Json };
    delete migrated.entries[`${oldPrefix}/taken`];
    delete migrated.entries[`${oldPrefix}/handled`];
    migratedLoops += 1;
  } else if (legacyLoopKeys.length === 0) {
    // Non-loop program: align each reached request (open or answered) to its v2 address while preserving immutable `id`.
    const probeV2 = emptyLedger(legacy.startedAt, { identityScheme: 2 });
    probeV2.facts = structuredClone(legacy.facts);
    probeV2.occurrences = structuredClone(legacy.occurrences);
    for (const request of Object.values(migrated.requests)) {
      if (request.address) continue;
      // Top-level v1 request IDs differ from v2 only when `~form` was previously hashed into `id`.
      // Compute the v2 content digest directly from the request's fields for unambiguous single-occurrence matching.
      request.address = request.id;
    }
    // Check if evaluating under v2 re-opens anything that is already in the ledger; if so, map by (verb, holder, text, about).
    const testPass = evaluate(code, migrated, now, { commit: false });
    if (testPass.opened.length > 0) {
      const legacyByShape = new Map<string, LedgerRequest[]>();
      for (const req of Object.values(migrated.requests)) {
        const shape = `${req.verb}\0${req.holder}\0${req.text}\0${req.about ?? ""}`;
        const list = legacyByShape.get(shape) ?? [];
        list.push(req);
        legacyByShape.set(shape, list);
      }
      for (const newlyOpened of testPass.opened) {
        const shape = `${newlyOpened.verb}\0${newlyOpened.holder}\0${newlyOpened.text}\0${newlyOpened.about ?? ""}`;
        const matches = legacyByShape.get(shape) ?? [];
        if (matches.length !== 1 || !newlyOpened.address) {
          return { ok: false, keepLegacy: true, reason: `Ambiguous top-level request mapping for "${newlyOpened.text}"; keep on v1 evaluator` };
        }
        matches[0]!.address = newlyOpened.address;
        migratedRequests += 1;
      }
    }
  }

  // Final sanity check at migration instant: migrated v2 pass must not spuriously open or drop any request that v1 did not.
  const v2Check = evaluate(code, migrated, now, { commit: false });
  if (v2Check.status === "failed" && v1Pass.status !== "failed") {
    return { ok: false, keepLegacy: true, reason: `Migrated pass failed at snapshot: ${v2Check.error ?? "unknown"}` };
  }
  if (v2Check.opened.length !== v1Pass.opened.length || v2Check.unreached.length !== v1Pass.unreached.length) {
    return {
      ok: false, keepLegacy: true,
      reason: `Snapshot parity failed (v1 opened=${v1Pass.opened.length}/unreached=${v1Pass.unreached.length}, v2 opened=${v2Check.opened.length}/unreached=${v2Check.unreached.length}); keep on v1 evaluator`,
    };
  }
  return { ok: true, ledger: migrated, keepLegacy: false, migratedRequests, migratedLoops };
}

export type MigrationStep =
  | { kind: "advance"; at: number }
  | { kind: "occur"; stream: Value; value: Value; at: number }
  | { kind: "reply"; requestId: string; holder?: string; reply: Reply; at: number; epoch?: number }
  | { kind: "settleAll"; reply: Reply; at: number }
  | { kind: "edit"; code: Code; at: number }
  | { kind: "restart"; at: number };

export interface DispatchedRecord { step: number; at: number; id: string; verb: string; holder: string; text: string }
export interface MigrationReport {
  ok: boolean;
  /** False when no forward-advancing steps were executed (never claim verified on an empty trace). */
  verified: boolean;
  stepsExecuted: number;
  migration: MigrationResult;
  legacyDispatched: DispatchedRecord[];
  migratedDispatched: DispatchedRecord[];
  differences: string[];
}

/**
 * Forward-advancing migration verifier: starts from one legacy snapshot and
 * drives both the legacy v1 evaluator and the migrated v2 evaluator through
 * clock advances, events, replies (by original request ID & epoch), edits, and
 * JSON restarts, comparing actual dispatched requests and status at every step.
 * Empty step traces fail closed (`ok: false, verified: false`).
 */
export function verifyMigration(initialCode: Code, legacySnapshot: Ledger, at: number, steps: readonly MigrationStep[]): MigrationReport {
  const migration = migrateLedger(initialCode, legacySnapshot, at);
  if (!migration.ok) {
    return { ok: false, verified: false, stepsExecuted: 0, migration, legacyDispatched: [], migratedDispatched: [], differences: [migration.reason] };
  }
  if (steps.length === 0) {
    return {
      ok: false,
      verified: false,
      stepsExecuted: 0,
      migration,
      legacyDispatched: [],
      migratedDispatched: [],
      differences: ["Unverified: no forward-advancing replay steps were provided"],
    };
  }
  let legacyLedger = structuredClone(legacySnapshot);
  let migratedLedger = structuredClone(migration.ledger);
  let currentCode = initialCode;
  const legacyDispatched: DispatchedRecord[] = [];
  const migratedDispatched: DispatchedRecord[] = [];
  const differences: string[] = [];

  const runBoth = (stepIndex: number, now: number) => {
    const p1 = evaluate(currentCode, legacyLedger, now);
    const p2 = evaluate(currentCode, migratedLedger, now);
    for (const req of p1.opened) legacyDispatched.push({ step: stepIndex, at: now, id: req.id, verb: req.verb, holder: req.holder, text: req.text });
    for (const req of p2.opened) migratedDispatched.push({ step: stepIndex, at: now, id: req.id, verb: req.verb, holder: req.holder, text: req.text });
    const sig = (list: LedgerRequest[]) => list.map(r => `${r.verb}:${r.holder}:${r.text}`).sort().join("|");
    if (sig(p1.opened) !== sig(p2.opened)) {
      differences.push(`step ${stepIndex} (at ${now}): legacy opened [${sig(p1.opened)}], migrated opened [${sig(p2.opened)}]`);
    }
    if (p1.status !== p2.status) {
      differences.push(`step ${stepIndex} (at ${now}): legacy status=${p1.status}, migrated status=${p2.status}`);
    }
  };

  let stepsExecuted = 0;
  steps.forEach((step, index) => {
    if (step.kind === "advance") {
      stepsExecuted += 1;
      runBoth(index, step.at);
    } else if (step.kind === "occur") {
      stepsExecuted += 1;
      occur(legacyLedger, step.stream, step.value, step.at);
      occur(migratedLedger, step.stream, step.value, step.at);
      runBoth(index, step.at);
    } else if (step.kind === "reply") {
      stepsExecuted += 1;
      const r1 = legacyLedger.requests[step.requestId];
      const r2 = migratedLedger.requests[step.requestId];
      const h1 = step.holder ?? r1?.candidates?.[0] ?? r1?.holder ?? "";
      const h2 = step.holder ?? r2?.candidates?.[0] ?? r2?.holder ?? "";
      const e1 = step.epoch ?? r1?.epoch;
      const e2 = step.epoch ?? r2?.epoch;
      const s1 = r1 ? settle(legacyLedger, step.requestId, h1, step.reply, step.at, e1) : false;
      const s2 = r2 ? settle(migratedLedger, step.requestId, h2, step.reply, step.at, e2) : false;
      if (s1 !== s2 || !r1 || !r2) {
        differences.push(`step ${index} (reply ${step.requestId} at ${step.at}): legacy settled=${s1}, migrated settled=${s2}`);
      }
      runBoth(index, step.at);
    } else if (step.kind === "settleAll") {
      stepsExecuted += 1;
      for (const req of Object.values(legacyLedger.requests)) {
        if (req.reply === null && !req.detached) settle(legacyLedger, req.id, req.candidates?.[0] ?? req.holder, step.reply, step.at, req.epoch);
      }
      for (const req of Object.values(migratedLedger.requests)) {
        if (req.reply === null && !req.detached) settle(migratedLedger, req.id, req.candidates?.[0] ?? req.holder, step.reply, step.at, req.epoch);
      }
      runBoth(index, step.at);
    } else if (step.kind === "edit") {
      stepsExecuted += 1;
      currentCode = step.code;
      runBoth(index, step.at);
    } else if (step.kind === "restart") {
      stepsExecuted += 1;
      legacyLedger = JSON.parse(JSON.stringify(legacyLedger)) as Ledger;
      migratedLedger = JSON.parse(JSON.stringify(migratedLedger)) as Ledger;
      runBoth(index, step.at);
    } else {
      differences.push(`step ${index}: unknown migration replay step kind "${String((step as { kind?: unknown }).kind)}"`);
    }
  });

  const verified = stepsExecuted > 0;
  return { ok: verified && differences.length === 0, verified, stepsExecuted, migration, legacyDispatched, migratedDispatched, differences };
}
