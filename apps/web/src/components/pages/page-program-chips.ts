import type { PageProgramStatus } from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import { Decoration, DecorationSet } from "prosemirror-view";
import { pressOpens } from "./page-automation-chips";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * A page's programs are its code blocks tagged `norn run`. The block stays
 * text people edit; under it the page says how its program stands, from the
 * Hub: whom it waits on, how it ended, or why it does not run as written.
 * Pressing that line opens the conversation the program works in.
 */
export const programsKey = new PluginKey<{ programs: Map<string, PageProgramStatus>; decorations: DecorationSet }>("page-programs");

/** The name a `norn run` block gives its program, or null for any other block. */
export function programBlockName(language: unknown): string | null {
  const [lang, run, name, ...rest] = String(language ?? "").trim().split(/\s+/u);
  return lang === "norn" && run === "run" && !rest.length ? name ?? "main" : null;
}

/** How a program stands, in one line. */
export function programStatusText(program: PageProgramStatus | undefined): string {
  if (!program) return "starting…";
  if (program.problem) return program.problem.split("\n")[0]!;
  if (program.state === "not_started") return "starting…";
  if (program.state === "completed") return `finished: ${program.result ?? ""}`.trim();
  if (program.state === "failed") return `stopped: ${program.result ?? ""}`.trim();
  const waiting = [...new Set(program.requests.filter((request) => request.reply === null).map((request) => request.holder))];
  return waiting.length ? `waiting on ${waiting.join(", ")}` : "running";
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
    const text = programStatusText(program);
    const state = program?.problem ? "problem" : program?.state ?? "not_started";
    decorations.push(Decoration.widget(pos + node.nodeSize, () => {
      const status = document.createElement("button");
      status.type = "button";
      status.className = "page-program-status";
      status.contentEditable = "false";
      status.dataset.state = state;
      status.textContent = text;
      pressOpens(status, program?.channelId, "Open the conversation it works in", openConversation);
      return status;
    }, { side: -1, ignoreSelection: true, key: `program:${name}:${state}:${text}:${program?.channelId ?? ""}` }));
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
