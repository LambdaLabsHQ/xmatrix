import { staticFace, type PageProgramRequest, type PageProgramStatus, type PageProgramStep } from "@xmatrix/protocol";

/**
 * A program drawn as its flow (docs/architecture/norn-host.md, "What it does
 * next"): the requests it has made with their answers, then what it does
 * from here on, each step joined to the next by a line. A step is a time or
 * an event it waits for, someone it asks with what it asks, something it
 * says, or its end. Where the ways a request can end lead apart, the other
 * ways branch off the request, each under the word for it, and the main way
 * goes on below. The Hub reads the steps off the program; this only draws
 * them. A Page draws it under the program's block, a conversation over the
 * program's text.
 */

export interface ProgramStep {
  /** `answered` and `working` are the ordinary course; `failed` is anything else a request ended as. */
  state: "working" | "answered" | "failed";
  holder: string;
  text: string;
  /** The answer, why it failed, or how long it has left. */
  note: string;
}

const SPAN: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "min"], [1_000, "s"]];
/** A length of time in its largest whole unit: `8 h`, `24 min`. */
export function span(ms: number): string {
  const [size, unit] = SPAN.find(([each]) => ms >= each) ?? SPAN[3]!;
  return `${Math.max(1, Math.round(ms / size))} ${unit}`;
}
const ENDED: Record<Exclude<PageProgramRequest["outcome"], "answered" | null>, string> = {
  refused: "refused", broke: "could not", no_reply: "no reply", cancelled: "called off", revoked: "not allowed any more" };

const left = (until: string | null, now: number, doing: string): string => {
  const ms = until ? Date.parse(until) - now : Number.NaN;
  return Number.isFinite(ms) && ms > 0 ? `${doing} · ${span(ms)} left` : doing;
};

/** A request as a row of the program's steps, at `now`. */
export function programStep(request: PageProgramRequest, now: number): ProgramStep {
  const { holder, text } = request;
  if (request.outcome === null) return { state: "working", holder, text, note: left(request.by, now, "working") };
  if (request.outcome === "answered") return { state: "answered", holder, text, note: request.reply ?? "" };
  return { state: "failed", holder, text, note: [ENDED[request.outcome], request.reply].filter(Boolean).join(" · ") };
}

/** How the program stands below its steps, or null while its steps say it all. */
export function programFooter(program: PageProgramStatus | undefined): { state: "starting" | "running" | "finished" | "stopped" | "problem"; text: string } | null {
  if (program?.problem) return { state: "problem", text: program.problem.split("\n")[0]!.replace(/^\d+:\d+\s+/u, "") };
  if (!program || program.state === "not_started") return { state: "starting", text: "starting…" };
  if (program.state === "completed") return { state: "finished", text: program.result || "finished" };
  if (program.state === "failed") return { state: "stopped", text: program.result || "stopped" };
  return program.next?.length || program.requests.some((request) => request.outcome === null) ? null : { state: "running", text: "running" };
}

type Step<Kind extends PageProgramStep["kind"]> = Extract<PageProgramStep, { kind: Kind }>;
const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";
const anyOf = (words: string[]): string => words.join(", or ");

/** What a wait is for, in words: a time, a beat, or what has to happen outside. `time` writes a moment as its reader's clock shows it. */
export function waitText(step: Step<"wait">, time: (at: string) => string): { title: string; detail: string } {
  const outside = step.on.length ? `when ${anyOf(step.on)}` : "";
  if (step.repeats) {
    const beat = step.every ? `Every ${span(step.every)}` : "";
    return { title: beat && outside ? `${beat}, and ${outside}` : beat || `Each time ${anyOf(step.on)}`, detail: step.at ? `next ${time(step.at)}` : "" };
  }
  if (!step.at) return { title: outside ? `W${outside.slice(1)}` : "Waits", detail: "" };
  return { title: time(step.at), detail: outside ? `or ${outside}` : "" };
}

/** What a participant is asked under: the repository alone, any other condition with its name. */
export const conditionsText = (conditions: Record<string, string>): string =>
  Object.entries(conditions).map(([name, value]) => name === "repo" ? value : `${name} ${value}`).join(" · ");

/** How the program ends at this step. */
export function endText(step: Step<"end">): string {
  if (step.failed) return step.result ? `Stops: ${step.result}` : "Stops without a result";
  return step.result ? `Ends with ${step.result}` : "Ends";
}

/** Where the flow goes back to. */
export const againText = (step: Step<"again">): string => step.text === null ? "Next round" : `Back to “${firstLine(step.text)}”`;

function el(className: string, text?: string): HTMLElement {
  const node = document.createElement("span");
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An Agent by the harness its request names (`@claude`): its face, or its first letter where it has none. */
function holderFace(holder: string): HTMLElement {
  const name = holder.replace(/^@/u, "");
  const face = staticFace({ kind: "agent", harness: name, name });
  if (!face?.imageUrl) return el("program-flow-mark program-flow-face", face?.initials ?? name.slice(0, 1).toUpperCase());
  const image = document.createElement("img");
  image.className = "program-flow-mark program-flow-face";
  image.src = face.imageUrl;
  image.alt = "";
  return image;
}

export interface ProgramFlowOptions {
  now?: number;
  /** A moment as the reader's clock shows it. */
  time?: (at: string) => string;
  /** On a Page the program's text stands right above, so what is asked is kept to a line or two. */
  compact?: boolean;
  /** Leaves what is asked for the caller to draw in each place of `texts`, as its surface draws words. */
  richText?: boolean;
}
export interface DrawnProgramFlow {
  root: HTMLElement;
  /** Where each request's words go, when the caller draws them. */
  texts: { at: HTMLElement; text: string }[];
}

const localTime = (at: string): string => new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** The program's flow as elements: its past requests, its steps from here on, and how it ended. */
export function drawProgramFlow(program: PageProgramStatus | undefined, options: ProgramFlowOptions = {}): DrawnProgramFlow {
  const now = options.now ?? Date.now(), time = options.time ?? localTime;
  const texts: DrawnProgramFlow["texts"] = [];
  const next = program?.problem ? [] : program?.next ?? [];

  const step = (kind: string, state: string, mark: HTMLElement, head: (HTMLElement | null)[], ...rest: (HTMLElement | null)[]): HTMLElement => {
    const row = el("program-flow-step");
    row.dataset.kind = kind;
    row.dataset.state = state;
    const top = el("program-flow-head");
    top.append(...head.filter((part): part is HTMLElement => part !== null));
    const body = el("program-flow-body");
    body.append(top, ...rest.filter((part): part is HTMLElement => part !== null));
    row.append(mark, body);
    return row;
  };
  const icon = (name: string): HTMLElement => { const mark = el("program-flow-mark program-flow-icon"); mark.dataset.icon = name; return mark; };
  const note = (text: string): HTMLElement | null => text ? el("program-flow-note", text) : null;
  /** What a step says in a line, for a way that leads to nothing more than that. */
  const leaf = (each: PageProgramStep): string | null =>
    each.kind === "end" ? endText(each) : each.kind === "again" ? againText(each) : each.kind === "more" ? "and on from there" : null;

  /** `under` is what the request this branch leaves asked: asked again of someone else, it is not written out twice. */
  const draw = (steps: PageProgramStep[], into: HTMLElement, current: boolean, under?: string): void => {
    steps.forEach((each, index) => {
      const state = current && index === 0 ? "now" : "next";
      const told = leaf(each);
      if (each.kind === "wait") {
        const { title, detail } = waitText(each, time);
        into.append(step("wait", state, icon(each.at ? "clock" : "event"), [el("program-flow-title", title), detail ? el("program-flow-meta", detail) : null,
          note(state === "now" ? left(each.at, now, "waiting") : "")]));
      } else if (each.kind === "ask") {
        const words = el("program-flow-text");
        if (each.text === under) { words.textContent = "the same request"; words.dataset.same = "true"; }
        else if (options.richText) texts.push({ at: words, text: each.text });
        else words.textContent = each.text.trim();
        const branches = each.otherwise.map((way) => {
          const branch = el("program-flow-branch");
          branch.append(el("program-flow-when", way.when));
          // A way that only ends, or only goes back, is said on its own line beside its word.
          const only = way.steps.length === 1 ? leaf(way.steps[0]!) : null;
          if (only !== null) branch.append(el("program-flow-leads", only));
          else {
            const led = el("program-flow-steps");
            draw(way.steps, led, false, each.text);
            branch.append(led);
          }
          return branch;
        });
        const conditions = conditionsText(each.conditions);
        const offered = each.verb === "confirm" ? "Yes / No" : each.options.join(" / ");
        into.append(step("ask", state, holderFace(each.holder), [el("program-flow-title", each.holder.replace(/^@/u, "")),
          conditions ? el("program-flow-meta", conditions) : null,
          note(each.open ? left(each.by, now, "working") : each.within ? `within ${span(each.within)}` : "")],
        words, offered ? el("program-flow-meta program-flow-offered", offered) : null, ...branches));
        if (each.then) {
          const then = el("program-flow-step");
          then.dataset.kind = "then";
          then.append(el("program-flow-when", each.then));
          into.append(then);
        }
      } else if (each.kind === "say") {
        into.append(step("say", state, icon("say"), [el("program-flow-title", each.to ? `Tells ${each.to.replace(/^@/u, "")}` : "Tells the conversation")],
          el("program-flow-text", each.text.trim())));
      } else if (told !== null) {
        into.append(step(each.kind, each.kind === "end" && each.failed ? "stopped" : each.kind === "end" ? "finished" : state,
          icon(each.kind === "end" ? (each.failed ? "stop" : "done") : each.kind), [el("program-flow-title", told)]));
      }
    });
  };

  const root = el("program-flow");
  if (options.compact) root.dataset.compact = "true";
  const steps = el("program-flow-steps");
  // Without its flow (a Hub that does not read one yet), a request that is open is still a step.
  for (const request of program?.problem ? [] : program?.requests ?? []) {
    if (request.outcome === null && next.length) continue;
    const past = programStep(request, now);
    // A request that has ended is history: its first line names it.
    steps.append(step("ask", past.state, holderFace(past.holder), [el("program-flow-title", past.holder.replace(/^@/u, "")),
      el("program-flow-text", firstLine(past.text)), note(firstLine(past.note))]));
  }
  draw(next, steps, program?.state === "running");
  const footer = programFooter(program);
  if (footer) {
    steps.append(step("ended", footer.state, icon(footer.state === "finished" ? "done" : footer.state === "stopped" || footer.state === "problem" ? "stop" : "clock"),
      [el("program-flow-title", footer.text)]));
  }
  root.append(steps);
  return { root, texts };
}
