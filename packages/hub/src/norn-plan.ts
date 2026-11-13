import type { PageProgramStep } from "@xmatrix/protocol";
import { nornPasses, plainResult } from "./norn-host";
import type { Form, ReportForm } from "./vendor/norn/frontend/check/index";
import type { Code } from "./vendor/norn/runtime/code";
import { occur, settle, type Ledger, type LedgerRequest, type Reply } from "./vendor/norn/runtime/ledger";
import { show, text, variant, type Value } from "./vendor/norn/runtime/value";

/**
 * What a program does from here on, read off the program itself
 * (docs/architecture/norn-host.md, "What it does next"). A program is a pure
 * computation over its ledger, so its future is the same computation on a
 * copy of the ledger: the clock is moved to what it waits for, and each
 * request is answered every way it can end. Nothing here is written anywhere.
 */

/** What stands in for words nobody has written yet: an answer, a report, an event. */
const UNWRITTEN = "…";

type Ask = Extract<PageProgramStep, { kind: "ask" }>;
type Wait = Extract<PageProgramStep, { kind: "wait" }>;
/** One way a request can end: an answer or a failure given now, or silence until `at`. */
type Way = { label: string; failure: boolean } & ({ reply: Reply } | { at: number });
/** A wait the flow stood at: which of the program's waits it was, and how far its loops had come. */
interface Stood { waits: Map<string, number>; rounds: string; step: Wait }
/** The way the flow came: the waits it stood at, what it asked since its loops last began a round, and how far they had come. */
interface Path { stood: Stood[]; asked: string[]; rounds: string | null }
interface Reading {
  code: Code;
  /** The requests that are asked already. */
  open: Set<string>;
  /** How many evaluations are left to read with. */
  passes: number;
}

/** A value of a report's form, for an answer nobody has given yet. */
function sample(form: Form, definitions: ReportForm["definitions"], depth = 0): Value {
  if (form.kind === "list") return { type: "list", values: [] };
  if (form.kind === "tuple") return { type: "tuple", values: form.elements.map(element => sample(element, definitions, depth + 1)) };
  if (form.kind === "base") {
    return form.name === "bool" ? { type: "bool", value: true } : form.name === "unit" ? { type: "unit" }
      : form.name === "int" || form.name === "float" || form.name === "time" || form.name === "duration" ? { type: form.name, value: "0" } : text(UNWRITTEN);
  }
  const definition = form.kind === "named" ? definitions[form.name] : undefined;
  if (definition?.kind === "record") {
    return { type: "record", fields: Object.fromEntries(definition.fields.map(field => [field.name, sample(field.form, definitions, depth + 1)])) };
  }
  if (definition?.kind === "variant") {
    // A type that mentions itself ends at a constructor that carries nothing.
    const constructor = (depth > 4 ? definition.constructors.find(each => !each.args.length) : undefined) ?? definition.constructors[0]!;
    return variant(constructor.name, ...constructor.args.map(arg => sample(arg, definitions, depth + 1)));
  }
  return definition?.kind === "host" ? { type: "record", fields: { text: text(UNWRITTEN) } } : text(UNWRITTEN);
}

/** The answers a request can get, each under the word a reader knows it by. */
function answers(request: LedgerRequest): { label: string; value: Value }[] {
  if (request.verb === "confirm") return ["Yes", "No"].map(name => ({ label: name, value: variant(name) }));
  if (request.verb === "choose") return (request.options ?? []).map(option => ({ label: show(option), value: option }));
  if (request.verb === "judge") return [true, false].map(value => ({ label: String(value), value: { type: "bool", value } }));
  if (request.verb === "ask") return [{ label: "answered", value: text(UNWRITTEN) }];
  const report = request.form;
  if (report === null) return [{ label: "answered", value: { type: "record", fields: { text: text(UNWRITTEN) } } }];
  const definition = report.form.kind === "named" ? report.definitions[report.form.name] : undefined;
  // A report the program reads as one of several cases goes a way for each case.
  if (definition?.kind === "variant") {
    return definition.constructors.map(constructor => ({ label: constructor.name,
      value: variant(constructor.name, ...constructor.args.map(arg => sample(arg, report.definitions, 1))) }));
  }
  return [{ label: "answered", value: sample(report.form, report.definitions) }];
}

/** The ways some of a request's endings share, in words: the answers by name, every failure together as "otherwise". */
function waysText(some: Way[], all: Way[]): string {
  const [given, failed] = [some.filter(way => !way.failure), some.filter(way => way.failure)];
  return [
    ...(given.length === 0 ? [] : given.length === all.filter(way => !way.failure).length ? ["answered"] : given.map(way => way.label)),
    ...(failed.length === 0 ? [] : failed.length === all.filter(way => way.failure).length ? ["otherwise"] : failed.map(way => way.label)),
  ].join(", ");
}

/** An outside stream in words: what has to happen for the program to go on. */
function streamText(stream: Extract<Value, { type: "source" }>): string {
  const word = (value: Value | undefined): string => value?.type === "string" ? value.value : "";
  if (stream.name === "ciFailed") return `CI fails on ${word(stream.args[0])}`;
  if (stream.name === "prMerged") return `a pull request merges on ${word(stream.args[0])}`;
  if (stream.name === "appEvent") return `${word(stream.args[0])} reports ${word(stream.labels.feature) || "an event"}`;
  return stream.name;
}

/** The program's waits that have begun and not ended, each by its place in the text and its count there. */
function waitsBegun(ledger: Ledger): Map<string, number> {
  const waits = new Map<string, number>();
  for (const key of Object.keys(ledger.entries)) {
    if (!key.startsWith("wait:") || !key.endsWith("/began") || ledger.entries[key.slice(0, -"/began".length)]) continue;
    const [place = "", count = "0"] = key.slice(0, -"/began".length).split("#");
    waits.set(place, Math.max(waits.get(place) ?? 0, Number(count)));
  }
  return waits;
}
/** How far each loop of the program has come: it changes when a round is over. */
const roundsHandled = (ledger: Ledger): string =>
  JSON.stringify(Object.entries(ledger.entries).filter(([key]) => key.endsWith("/handled")).map(([key, entry]) => [key, entry.value]).sort());

/** Two flows that read the same, whenever they happen and whatever their answers say. */
const sameFlow = (steps: PageProgramStep[]): string =>
  JSON.stringify(steps, (key, value: unknown) => key === "result" || key === "at" || key === "by" ? undefined : value);

function flow(reading: Reading, ledger: Ledger, from: number, path: Path): PageProgramStep[] {
  const steps: PageProgramStep[] = [];
  let { stood, asked } = path;
  for (let now = from, last = path.rounds; ;) {
    if (reading.passes-- <= 0) return [...steps, { kind: "more" }];
    const pass = nornPasses(reading.code, ledger, now, each => {
      for (const entry of each.log) {
        if (entry.kind === "said") steps.push({ kind: "say", to: entry.to, text: entry.text });
        else if (entry.kind === "handlerFailed") steps.push({ kind: "say", to: "", text: "This round did not succeed." });
      }
    }, { steps: 200_000 });
    if (pass.status !== "waiting" || !pass.waiting) {
      // What it ends with is words nobody has written yet, unless the program wrote them itself.
      const result = pass.error ?? (pass.result && pass.result.type !== "unit" ? plainResult(pass.result) : "");
      return [...steps, { kind: "end", failed: pass.status === "failed", result: result === UNWRITTEN ? "the answer" : result.includes(UNWRITTEN) ? "" : result }];
    }
    const { targets, until } = pass.waiting;
    const timers = [...targets.flatMap(target => target.kind === "timer" ? [target.at] : []), ...(until === null ? [] : [until])];
    const at = timers.length ? Math.min(...timers) : null;
    // A wait of a loop, reached again after a round: the flow has come back to where it stood.
    const waits = waitsBegun(ledger), rounds = roundsHandled(ledger);
    const before = stood.find(each => each.rounds !== rounds && [...waits].some(([place, count]) => count > (each.waits.get(place) ?? Infinity)));
    if (before) {
      before.step.repeats = true;
      if (at !== null && before.step.at !== null) before.step.every = at - Date.parse(before.step.at);
      return [...steps, { kind: "again", text: null }];
    }
    // A new round asks anew: what an earlier round asked is not where this one comes back to.
    if (last !== null && last !== rounds) asked = [];
    last = rounds;
    const request = targets.flatMap(target => target.kind === "request" ? [ledger.requests[target.id]!] : []).find(each => each.reply === null);
    if (!request) {
      const outside = targets.flatMap(target => target.kind === "stream" || target.kind === "fact" ? [target.source] : []);
      const step: Wait = { kind: "wait", at: at === null ? null : new Date(at).toISOString(), on: outside.map(streamText), repeats: false, every: null };
      steps.push(step);
      stood = [...stood, { waits, rounds, step }];
      const stream = outside.find(source => source.kind === "stream");
      if (at !== null) now = at;
      else if (stream) occur(ledger, stream, text(UNWRITTEN), now);
      else return [...steps, { kind: "more" }];
      continue;
    }
    const open = reading.open.has(request.id);
    // The same asked of the same participant as before on this way: a function that calls itself has come round.
    const asking = JSON.stringify([request.verb, request.holder, request.conditions, request.text]);
    if (!open && asked.includes(asking)) return [...steps, { kind: "again", text: request.text }];
    const ask: Ask = { kind: "ask", verb: request.verb, holder: request.holder, conditions: request.conditions ?? {}, text: request.text,
      options: (request.options ?? []).map(show), open, by: open && request.by !== null ? new Date(request.by).toISOString() : null,
      within: open || request.by === null ? null : request.by - request.openedAt, then: null, otherwise: [] };
    const late = [request.by, until].filter((each): each is number => each !== null);
    const ways: Way[] = [
      ...answers(request).map(answer => ({ label: answer.label, failure: false, reply: { tag: "Answered" as const, value: answer.value } })),
      { label: "declined", failure: true, reply: { tag: "Refused", reason: UNWRITTEN } },
      { label: "could not", failure: true, reply: { tag: "Broke", reason: UNWRITTEN } },
      ...(late.length ? [{ label: "no answer in time", failure: true, at: Math.min(...late) }] : []),
    ];
    // The first answer is followed before the other ways, so what is left to read goes to the flow's main line.
    const groups: { same: string; ways: Way[]; steps: PageProgramStep[] }[] = [];
    for (const [index, way] of ways.entries()) {
      const copy = structuredClone(ledger);
      const on: Path = { stood, asked: [...asked, asking], rounds };
      const led = "at" in way ? flow(reading, copy, way.at, on)
        : settle(copy, request.id, request.holder, way.reply, now) ? flow(reading, copy, now, on) : null;
      if (index === 0 && !led) return [...steps, ask, { kind: "more" }];
      if (!led || (index > 0 && led[0]?.kind === "more")) continue;
      const same = sameFlow(led), group = groups.find(each => each.same === same);
      if (group) group.ways.push(way);
      else groups.push({ same, ways: [way], steps: led });
    }
    const [main, ...others] = groups;
    ask.then = others.length ? waysText(main!.ways, ways) : null;
    ask.otherwise = others.map(group => ({ when: waysText(group.ways, ways), steps: group.steps }));
    return [...steps, ask, ...main!.steps];
  }
}

/**
 * The program's flow from `now`: what it waits for, whom it asks what, what
 * follows each way a request can end, and where a round of a loop comes back
 * to. It begins with what the program waits for at this moment. Each
 * evaluation copies the ledger, so the reading is given a number of them that
 * shrinks as the ledger grows; it follows the main line first, and where it
 * stopped the flow says that it goes on.
 */
export function nornFlow(code: Code, ledger: Ledger, now: number): PageProgramStep[] {
  if (ledger.ended) return [];
  const copy = structuredClone(ledger);
  const open = new Set(Object.values(copy.requests).filter(request => request.reply === null).map(request => request.id));
  const passes = Math.max(24, Math.min(300, Math.floor(20_000_000 / JSON.stringify(copy).length)));
  try {
    return flow({ code, open, passes }, copy, Math.max(now, copy.startedAt), { stood: [], asked: [], rounds: null });
  } catch {
    // The flow is a reading aid: a program it cannot be read from still runs and still shows how it stands.
    return [];
  }
}
