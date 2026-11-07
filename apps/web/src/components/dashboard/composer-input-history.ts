/**
 * The composer's input history (Daniel 2026-11-07: 上箭头, 输入历史, 把历史预览出来): what the reader sent in this
 * Space, newest first. ↑ in an empty composer shows it as a list in the composer's own panel, the newest beside
 * the field, and the highlighted entry goes into the composer to be sent again or edited. Kept on this device
 * only, like recent searches.
 */
import {
  isAgentBinding,
  updateComposerInvocationDraft,
  type ComposerInvocationDraft,
  type ComposerReferenceBinding,
} from "./composer-invocation-bindings";
import { draftPictures } from "./inline-attachments";
import { userSpaceLocalState, type UserSpaceLocalScope } from "@/lib/user-space-local-state";

/** A sent draft as the composer shows it again: its text and the channels and pages picked in it. */
export type ComposerInputHistoryEntry = { body: string; references: ComposerReferenceBinding[] };

export const INPUT_HISTORY_LIMIT = 50;
const history = userSpaceLocalState<ComposerInputHistoryEntry[]>("input-history", (stored) =>
  Array.isArray(stored) ? stored.filter(isEntry).slice(0, INPUT_HISTORY_LIMIT) : undefined);

export function readInputHistory(scope: UserSpaceLocalScope):
  ComposerInputHistoryEntry[] {
  return history.read(scope) ?? [];
}

/**
 * Remembers a sent draft. Its pictures are left out, since their files went with the message; an Agent picked in
 * it is kept as the written `@name`, resolved again when it is sent, never bound to an Instance that may be gone.
 */
export function rememberInput(scope: UserSpaceLocalScope,
  draft: ComposerInvocationDraft | undefined, body: string): void {
  const entry = historyEntryOf(draft, body);
  if (!entry) return;
  const next = [entry, ...readInputHistory(scope).filter((item) => item.body !== entry.body)]
    .slice(0, INPUT_HISTORY_LIMIT);
  history.write(scope, next);
}

export function historyEntryOf(draft: ComposerInvocationDraft | undefined, body: string):
  ComposerInputHistoryEntry | null {
  let current = updateComposerInvocationDraft(draft, body);
  // Bottom up, so the lines above keep their offsets.
  for (const picture of draftPictures(body).reverse()) {
    const lines = current.body.split("\n");
    lines.splice(picture.line, 1);
    current = updateComposerInvocationDraft(current, lines.join("\n"));
  }
  const text = current.body.trim();
  if (!text) return null;
  current = updateComposerInvocationDraft(current, current.body.trimEnd());
  current = updateComposerInvocationDraft(current, current.body.trimStart());
  return {
    body: current.body,
    references: current.bindings.filter((binding): binding is ComposerReferenceBinding => !isAgentBinding(binding))
      .map(({ start, end, text: name, reference }) => ({ start, end, text: name, reference })),
  };
}

/**
 * What a key does to the history list: ↑ in an empty composer opens it on the newest entry; then ↑ goes older,
 * ↓ newer and past the newest closes it, Enter or Tab puts the highlighted entry in the composer, Escape closes.
 * `active` counts from the newest; null leaves the key to the composer.
 */
export function inputHistoryKey(input: {
  entries: readonly ComposerInputHistoryEntry[];
  /** The highlighted entry while the list is open; null while it is closed. */
  active: number | null;
  draft: string;
  /** Whether the caret is collapsed (no text selected). */
  collapsed: boolean;
  key: string;
}): { active: number | null; pick?: ComposerInputHistoryEntry } | null {
  const { entries, active, draft, collapsed, key } = input;
  if (active === null || draft) {
    return key === "ArrowUp" && !draft && collapsed && entries.length > 0 ? { active: 0 } : null;
  }
  if (key === "ArrowUp") return { active: Math.min(active + 1, entries.length - 1) };
  if (key === "ArrowDown") return { active: active > 0 ? active - 1 : null };
  if (key === "Escape") return { active: null };
  if (key === "Enter" || key === "Tab") {
    const pick = entries[active];
    return pick ? { active: null, pick } : { active: null };
  }
  return null;
}

function isEntry(value: unknown): value is ComposerInputHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const { body, references } = value as Partial<ComposerInputHistoryEntry>;
  return typeof body === "string" && body.length > 0 && Array.isArray(references) && references.every((reference) =>
    reference && typeof reference.start === "number" && typeof reference.end === "number"
    && typeof reference.text === "string" && typeof reference.reference === "string"
    && body.slice(reference.start, reference.end) === reference.text);
}
