import { AUTOMATION_REFERENCE_SCHEME, type SerializedAutomation } from "@xmatrix/protocol";
import { pageSchema } from "@xmatrix/protocol/page-document";
import type { Node as DocNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import { formatAutomationCadence, formatAutomationNext } from "./page-automation-format";

/**
 * A page's Automations are live references in its text
 * (docs/design/pages-live-document.md §6.1): a link to
 * `xmatrix:automation/<id>` is drawn as a chip that says, from the
 * Automation itself, how often it runs and whether it is running, so the
 * page never restates a schedule in prose. Clicking the chip's state opens
 * the conversation its last occurrence ran in, or its own before it has run.
 */
export const automationsKey = new PluginKey<{
  automations: Map<string, SerializedAutomation>; decorations: DecorationSet;
}>("page-automations");

function state(automation: SerializedAutomation | undefined): "running" | "paused" | "missing" {
  if (!automation) return "missing";
  return automation.enabled ? "running" : "paused";
}

function chipDecorations(doc: DocNode, automations: Map<string, SerializedAutomation>,
  openConversation: (conversationId: string) => void): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const link = pageSchema.marks.link.isInSet(node.marks);
    const href = typeof link?.attrs.href === "string" ? link.attrs.href : "";
    if (!href.startsWith(AUTOMATION_REFERENCE_SCHEME)) return;
    const id = href.slice(AUTOMATION_REFERENCE_SCHEME.length);
    const automation = automations.get(id);
    const current = state(automation);
    decorations.push(Decoration.inline(pos, pos + node.nodeSize, {
      class: "page-automation-chip", "data-state": current, "data-automation": id,
    }));
    decorations.push(Decoration.widget(pos + node.nodeSize, () => {
      const status = document.createElement("button");
      status.type = "button";
      status.className = "page-automation-status";
      status.contentEditable = "false";
      status.dataset.state = current;
      status.textContent = automation
        ? `${formatAutomationCadence(automation.intervalMinutes)} · ${automation.enabled
          ? formatAutomationNext(automation.nextRunAt) : "paused"}`
        : "not found";
      if (automation) {
        status.title = automation.lastChannelId ? "Open its last run" : "Open its conversation";
        status.addEventListener("mousedown", (event) => event.preventDefault());
        status.addEventListener("click", () => openConversation(automation.lastChannelId ?? automation.channelId));
      } else {
        status.disabled = true;
        status.title = "No Automation of this page has this id";
      }
      return status;
    }, { side: 1, ignoreSelection: true,
      key: `automation:${id}:${current}:${automation?.intervalMinutes}:${automation?.nextRunAt}` }));
  });
  return DecorationSet.create(doc, decorations);
}

export function automationChips(openConversation: (conversationId: string) => void): Plugin {
  return new Plugin({
    key: automationsKey,
    state: {
      init: (_config, editor) => ({ automations: new Map<string, SerializedAutomation>(),
        decorations: DecorationSet.create(editor.doc, []) }),
      apply(tr, value, _old, editor) {
        const automations = (tr.getMeta(automationsKey) as Map<string, SerializedAutomation> | undefined)
          ?? value.automations;
        if (automations === value.automations && !tr.docChanged) return value;
        return { automations, decorations: chipDecorations(editor.doc, automations, openConversation) };
      },
    },
    props: { decorations: (editor) => automationsKey.getState(editor)?.decorations },
  });
}
