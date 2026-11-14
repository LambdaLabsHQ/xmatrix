import { nornRunBlockName, type PageProgramStatus } from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import { Decoration, DecorationSet } from "prosemirror-view";
import { pressOpens } from "./page-automation-chips";
import { drawProgramFlow } from "./program-flow";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";

/**
 * A page's programs are its code blocks tagged `norn run`. The block stays
 * text people edit. Joined under it, from the Hub, is the program's flow
 * (program-flow.ts): each request it made with its answer, what it waits for
 * now, what it does after that, and how it ended. A block that does not run
 * as written says why there, and the code is marked where. Pressing the flow
 * opens the conversation the program works in.
 */
export const programsKey = new PluginKey<{ programs: Map<string, PageProgramStatus>; decorations: DecorationSet }>("page-programs");

/** The name a `norn run` block gives its program, or null for any other block. */
export function programBlockName(language: unknown): string | null {
  return nornRunBlockName(String(language ?? ""));
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

function steps(program: PageProgramStatus | undefined, openConversation: (conversationId: string) => void): HTMLElement {
  const box = document.createElement("button");
  box.className = "page-program-steps";
  box.type = "button";
  box.contentEditable = "false";
  pressOpens(box, program?.channelId, "Open the conversation it works in", openConversation);
  box.append(drawProgramFlow(program, { compact: true }).root);
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
