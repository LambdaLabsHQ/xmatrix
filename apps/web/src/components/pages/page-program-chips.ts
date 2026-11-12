import { staticFace, type PageProgramRequest, type PageProgramStatus } from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import { Decoration, DecorationSet } from "prosemirror-view";
import { pressOpens } from "./page-automation-chips";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * A page's programs are its code blocks tagged `norn run`. The block stays
 * text people edit. Joined under it, from the Hub, are the program's steps:
 * each request as a row with who holds it, what was asked, and the answer or
 * how long it has left; then how the program ended. A block that does not
 * run as written says why there, and the code is marked where. Pressing the
 * steps opens the conversation the program works in.
 */
export const programsKey = new PluginKey<{ programs: Map<string, PageProgramStatus>; decorations: DecorationSet }>("page-programs");

/** The name a `norn run` block gives its program, or null for any other block. */
export function programBlockName(language: unknown): string | null {
  const [lang, run, name, ...rest] = String(language ?? "").trim().split(/\s+/u);
  return lang === "norn" && run === "run" && !rest.length ? name ?? "main" : null;
}

export interface ProgramStep {
  /** `answered` and `working` are the ordinary course; `failed` is anything else a request ended as. */
  state: "working" | "answered" | "failed";
  holder: string;
  text: string;
  /** The answer, why it failed, or how long it has left. */
  note: string;
}

const SPAN: [number, string][] = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "min"], [1_000, "s"]];
function span(ms: number): string {
  const [size, unit] = SPAN.find(([each]) => ms >= each) ?? SPAN[3]!;
  return `${Math.max(1, Math.round(ms / size))} ${unit}`;
}
const ENDED: Record<Exclude<PageProgramRequest["outcome"], "answered" | null>, string> = {
  refused: "refused", broke: "could not", no_reply: "no reply", cancelled: "called off", revoked: "not allowed any more" };

/** A request as a row of the program's steps, at `now`. */
export function programStep(request: PageProgramRequest, now: number): ProgramStep {
  const { holder, text } = request;
  if (request.outcome === null) {
    const left = request.by ? Date.parse(request.by) - now : Number.NaN;
    return { state: "working", holder, text, note: Number.isFinite(left) && left > 0 ? `working · ${span(left)} left` : "working" };
  }
  if (request.outcome === "answered") return { state: "answered", holder, text, note: request.reply ?? "" };
  return { state: "failed", holder, text, note: [ENDED[request.outcome], request.reply].filter(Boolean).join(" · ") };
}

/** How the program stands below its steps, or null while its steps say it all. */
export function programFooter(program: PageProgramStatus | undefined): { state: "starting" | "running" | "finished" | "stopped" | "problem"; text: string } | null {
  if (program?.problem) return { state: "problem", text: program.problem.split("\n")[0]!.replace(/^\d+:\d+\s+/u, "") };
  if (!program || program.state === "not_started") return { state: "starting", text: "starting…" };
  if (program.state === "completed") return { state: "finished", text: program.result || "finished" };
  if (program.state === "failed") return { state: "stopped", text: program.result || "stopped" };
  return program.requests.some((request) => request.outcome === null) ? null : { state: "running", text: "running" };
}

/** Where a problem that names its place (`3:14 …`) is in the block's text, to the end of that word. */
export function problemRange(source: string, problem: string | undefined): { from: number; to: number } | null {
  const place = /^(\d+):(\d+)\s/u.exec(problem ?? "");
  if (!place) return null;
  const lines = source.split("\n");
  const line = Number(place[1]) - 1, column = Number(place[2]) - 1;
  if (line >= lines.length || column > lines[line]!.length) return null;
  const from = lines.slice(0, line).reduce((sum, each) => sum + each.length + 1, 0) + column;
  const word = /^[\w@~]+|^\S/u.exec(source.slice(from))?.[0].length ?? 0;
  return word ? { from, to: from + word } : null;
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** An Agent by the harness its request names (`@claude`): its face, or its first letter where it has none. */
function holderFace(holder: string): HTMLElement {
  const name = holder.replace(/^@/u, "");
  const face = staticFace({ kind: "agent", harness: name, name });
  if (!face?.imageUrl) return el("span", "page-program-face", face?.initials ?? name.slice(0, 1).toUpperCase());
  const image = el("img", "page-program-face") as HTMLImageElement;
  image.src = face.imageUrl;
  image.alt = "";
  return image;
}

function steps(program: PageProgramStatus | undefined, openConversation: (conversationId: string) => void): HTMLElement {
  const box = el("button", "page-program-steps") as HTMLButtonElement;
  box.type = "button";
  box.contentEditable = "false";
  pressOpens(box, program?.channelId, "Open the conversation it works in", openConversation);
  const now = Date.now();
  for (const request of program?.problem ? [] : program?.requests ?? []) {
    const step = programStep(request, now);
    const row = el("span", "page-program-step");
    row.dataset.state = step.state;
    row.append(holderFace(step.holder), el("span", "page-program-holder", step.holder.replace(/^@/u, "")),
      el("span", "page-program-ask", step.text.split("\n")[0]), el("span", "page-program-note", step.note.split("\n")[0]));
    box.append(row);
  }
  const footer = programFooter(program);
  if (footer) {
    const row = el("span", "page-program-end", footer.text);
    row.dataset.state = footer.state;
    box.append(row);
  }
  return box;
}

function chipDecorations(doc: DocNode, programs: Map<string, PageProgramStatus>,
  openConversation: (conversationId: string) => void): DecorationSet {
  const decorations: Decoration[] = [];
  // Only a block at the top of the page is a program, as the Hub reads it.
  doc.forEach((node, pos) => {
    if (node.type !== pageSchema.nodes.code_block) return;
    const name = programBlockName(node.attrs.language);
    if (name === null) return;
    const program = programs.get(name);
    // The block and its steps are one surface.
    decorations.push(Decoration.node(pos, pos + node.nodeSize, { class: "page-program-code" }));
    const wrong = problemRange(node.textContent, program?.problem);
    if (wrong) decorations.push(Decoration.inline(pos + 1 + wrong.from, pos + 1 + wrong.to, { class: "page-program-wrong" }));
    decorations.push(Decoration.widget(pos + node.nodeSize, () => steps(program, openConversation),
      { side: -1, ignoreSelection: true, key: `program:${name}:${JSON.stringify(program ?? null)}:${Math.floor(Date.now() / 60_000)}` }));
  });
  return DecorationSet.create(doc, decorations);
}

/** Whether the page holds a program block: whether its programs are worth asking the Hub about. */
function holdsProgram(doc: DocNode): boolean {
  let found = false;
  doc.forEach((node) => {
    found ||= node.type === pageSchema.nodes.code_block && programBlockName(node.attrs.language) !== null;
  });
  return found;
}

export function programChips(openConversation: (conversationId: string) => void, onPresent: (present: boolean) => void): Plugin {
  return new Plugin({
    view(editor) {
      let present = holdsProgram(editor.state.doc);
      onPresent(present);
      return { update(view, previous) {
        if (view.state.doc === previous.doc) return;
        const now = holdsProgram(view.state.doc);
        if (now !== present) onPresent(present = now);
      } };
    },
    key: programsKey,
    state: {
      init: (_config, editor) => ({ programs: new Map<string, PageProgramStatus>(),
        decorations: chipDecorations(editor.doc, new Map(), openConversation) }),
      apply(tr, value, _old, editor) {
        const programs = (tr.getMeta(programsKey) as Map<string, PageProgramStatus> | undefined) ?? value.programs;
        if (programs === value.programs && !tr.docChanged) return value;
        return { programs, decorations: chipDecorations(editor.doc, programs, openConversation) };
      },
    },
    props: { decorations: (editor) => programsKey.getState(editor)?.decorations },
  });
}
