import { pageSchedules, type PageSchedule, type SerializedAutomation } from "@xmatrix/protocol";
import { pageDocToMarkdown, pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey, TextSelection } from "prosemirror-state";
import { triggersKey } from "./page-triggers";
import { scheduleTimingRange } from "./page-schedule-editing";
import { Decoration, DecorationSet } from "prosemirror-view";
import { formatAutomationNext } from "./page-automation-format";

/**
 * A page's schedules are lines of its text, written as Obsidian Tasks writes
 * a recurring or scheduled task (docs/design/pages-live-document.md §6.1):
 * `- [ ] <what to do> 🔁 every 12 hours`. The editor leaves the line as text
 * people edit like any other, quiets its timing (from 🔁 or ⏳ on), and says
 * after it, from the Automation the line is, when it runs next; clicking that
 * opens the conversation its last occurrence ran in. A line that cannot run
 * as written says why instead.
 */
export const automationsKey = new PluginKey<{
  automations: Map<string, SerializedAutomation>; decorations: DecorationSet;
}>("page-automations");

const SIGNIFIER = /[🔁⏳]/u;

/** The list item as the page's markdown writes it, the line its schedule is known by. */
function itemLine(item: DocNode): string {
  const list = pageSchema.nodes.bullet_list.create(null, item);
  return pageDocToMarkdown(pageSchema.nodes.doc.create(null, list)).split("\n")[0]!.trim();
}

function statusText(line: PageSchedule, automation: SerializedAutomation | undefined): string {
  if (line.error) return line.error;
  if (!automation) return "starting…";
  if (automation.problem) return automation.problem;
  if (line.status === "done") return "done";
  if (!automation.enabled) return "paused";
  return formatAutomationNext(automation.nextRunAt);
}

function chipDecorations(doc: DocNode, automations: Map<string, SerializedAutomation>,
  openConversation: (conversationId: string) => void): DecorationSet {
  const bySource = new Map([...automations.values()].flatMap((automation) =>
    automation.source ? [[automation.source, automation] as const] : []));
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type !== pageSchema.nodes.list_item) return true;
    const paragraph = node.firstChild;
    if (!paragraph?.isTextblock || !SIGNIFIER.test(paragraph.textContent)) return true;
    const line = pageSchedules(itemLine(node))[0];
    if (!line) return true;
    const automation = bySource.get(line.source);
    const problem = Boolean(line.error || automation?.problem);
    const state = problem ? "problem" : line.status === "running" && automation && !automation.enabled ? "paused"
      : line.status;
    const start = pos + 2;
    const timing = paragraph.textContent.search(SIGNIFIER);
    const end = start + paragraph.content.size;
    decorations.push(Decoration.inline(start + timing, end, { class: "page-schedule-timing" }));
    decorations.push(Decoration.widget(end, () => {
      const status = document.createElement("button");
      status.type = "button";
      status.className = "page-automation-status";
      status.contentEditable = "false";
      status.dataset.state = state;
      status.textContent = statusText(line, automation);
      const target = automation?.lastChannelId;
      if (target && !problem) {
        status.title = "Open its last run";
        status.addEventListener("mousedown", (event) => event.preventDefault());
        status.addEventListener("click", () => openConversation(target));
      } else status.disabled = true;
      return status;
    }, { side: 1, ignoreSelection: true, key: `schedule:${line.source}:${state}:${automation?.version ?? 0}:${
      automation?.nextRunAt ?? ""}` }));
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

export function automationChips(openConversation: (conversationId: string) => void): Plugin {
  return new Plugin({
    key: automationsKey,
    state: {
      init: (_config, editor) => ({ automations: new Map<string, SerializedAutomation>(),
        decorations: chipDecorations(editor.doc, new Map(), openConversation) }),
      apply(tr, value, _old, editor) {
        const automations = (tr.getMeta(automationsKey) as Map<string, SerializedAutomation> | undefined)
          ?? value.automations;
        if (automations === value.automations && !tr.docChanged) return value;
        return { automations, decorations: chipDecorations(editor.doc, automations, openConversation) };
      },
    },
    props: {
      decorations: (editor) => automationsKey.getState(editor)?.decorations,
      // Pressing a line's timing offers what it can be instead, as Obsidian's task editor does.
      handleDOMEvents: {
        mousedown(view, event) {
          if (!view.editable || event.button !== 0 || !(event.target instanceof Element)) return false;
          const timing = event.target.closest(".page-schedule-timing");
          if (!timing) return false;
          const pos = view.posAtDOM(timing, 0);
          const $pos = view.state.doc.resolve(pos);
          const range = scheduleTimingRange($pos.parent, $pos.start());
          event.preventDefault();
          view.focus();
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, range.to))
            .setMeta(triggersKey, { kind: "schedule", from: range.from, to: range.to, query: "" }));
          return true;
        },
      },
    },
  });
}
