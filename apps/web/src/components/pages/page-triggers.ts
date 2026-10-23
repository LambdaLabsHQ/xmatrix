import { pageSchema } from "@xmatrix/protocol/page-document";
import { type Command, type EditorState, Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { findActiveReference } from "../dashboard/reference-complete";

/**
 * What typing at the caret has opened on a page, as in the composer: `/` the
 * insert menu, `[[` a page or `[[page#` one of its sections, `#` a channel, and
 * `@` an Agent to write here. `【【`, `＃` and `＠` are the same triggers as a
 * Chinese input method types them. `from`…`to` is the typed trigger.
 */
export type PageTrigger =
  | { kind: "insert"; from: number; to: number; query: string }
  | { kind: "channel"; from: number; to: number; query: string }
  | { kind: "page"; from: number; to: number; query: string; section: string | null }
  | { kind: "agent"; from: number; to: number; query: string };

export const triggersKey = new PluginKey<PageTrigger | null>("page-triggers");

/** `@claude` after a space or a CJK character; an email's `@` follows a letter or digit. */
const AGENT_TRIGGER = /(^|[^A-Za-z0-9_.@＠/])[@＠]([\p{L}\p{N}_.:-]{0,32})$/u;
const INSERT_TRIGGER = /(?:^|\s)\/([^\s/]{0,24})$/u;

/** The trigger at an empty caret in a textblock that is not code, if one is being typed. */
export function pageTriggerAt(state: EditorState): PageTrigger | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  if (state.storedMarks?.some((mark) => mark.type === pageSchema.marks.code)
    || $from.marks().some((mark) => mark.type === pageSchema.marks.code)) return null;
  // One character per inline leaf, so text offsets are positions in the block.
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const at = (offset: number) => $from.pos - before.length + offset;
  const insert = INSERT_TRIGGER.exec(before);
  if (insert) return { kind: "insert", from: $from.pos - insert[1]!.length - 1, to: $from.pos, query: insert[1]! };
  const agent = AGENT_TRIGGER.exec(before);
  if (agent) {
    return { kind: "agent", from: at(agent.index + agent[1]!.length), to: $from.pos, query: agent[2]! };
  }
  const reference = findActiveReference(before, before.length);
  if (!reference) return null;
  // `#` opening a paragraph is the heading being typed.
  if (reference.kind === "channel" && reference.start === 0 && $from.parent.type === pageSchema.nodes.paragraph) return null;
  return reference.kind === "page"
    ? { kind: "page", from: at(reference.start), to: $from.pos, query: reference.query, section: reference.section }
    : { kind: "channel", from: at(reference.start), to: $from.pos, query: reference.query };
}

export function pageTriggers(): Plugin<PageTrigger | null> {
  return new Plugin<PageTrigger | null>({
    key: triggersKey,
    state: {
      init: () => null,
      apply: (tr, _value, _old, state) => tr.getMeta(triggersKey) === "close" ? null : pageTriggerAt(state),
    },
  });
}

/**
 * Puts a pick where its trigger was typed: the `page:<id>` or `channel:<id>` the page keeps (and draws
 * as a chip), or the `@<agent>` mention, then a space. A `[[` typed inside `[[…]]` takes the closing brackets with it.
 */
export function insertReference(trigger: PageTrigger, token: string): Command {
  return (state, dispatch) => {
    if (dispatch) {
      const $to = state.doc.resolve(trigger.to);
      const after = $to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, "￼");
      const closing = trigger.kind === "page" ? /^\s*(\]\]|】】)/u.exec(after)?.[0].length ?? 0 : 0;
      const spacer = /^\s/u.test(after.slice(closing)) ? "" : " ";
      const tr = state.tr.insertText(token + spacer, trigger.from, trigger.to + closing);
      // Past the space, so the reference reads as its chip.
      tr.setSelection(TextSelection.create(tr.doc, trigger.from + token.length + 1));
      dispatch(tr.setMeta(triggersKey, "close").scrollIntoView());
    }
    return true;
  };
}
