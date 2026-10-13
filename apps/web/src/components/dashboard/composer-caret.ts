import { isImeKeyDown } from "../../lib/ime-keydown";

export const EMPTY_COMPOSER_PASTE_SENTINEL = "\u200B";

export type ComposerSelectionRange = {
  start: number;
  end: number;
};

/**
 * Move a textarea selection on the next paint only while the exact DOM node
 * and controlled value that requested the move are still current. This keeps
 * an old completion/paste callback from pulling the caret behind text entered
 * during the intervening frame.
 */
export function scheduleTextareaSelection(
  resolveTextarea: () => HTMLTextAreaElement | null,
  expectedValue: string,
  selection: ComposerSelectionRange,
  focusOptions?: FocusOptions
): number {
  const scheduledTextarea = resolveTextarea();
  return window.requestAnimationFrame(() => {
    const textarea = resolveTextarea();
    if (!scheduledTextarea || textarea !== scheduledTextarea || textarea.value !== expectedValue) return;
    textarea.focus(focusOptions);
    textarea.setSelectionRange(selection.start, selection.end);
  });
}

export function stripEmptyPasteSentinel(value: string): string {
  return value.replaceAll(EMPTY_COMPOSER_PASTE_SENTINEL, "");
}

export function composerDraftCursor(value: string, selectionStart: number | null): number {
  const boundedSelection = Math.max(0, Math.min(selectionStart ?? 0, value.length));
  return stripEmptyPasteSentinel(value.slice(0, boundedSelection)).length;
}

export function isComposerImeBeforeInput(input: {
  inputType?: string | null;
  isComposing?: boolean;
}): boolean {
  return Boolean(input.isComposing) || input.inputType === "insertCompositionText";
}

/**
 * Whether the mention/launch-target list owns this keydown. It must not take an
 * IME keystroke: accepting a candidate on the Enter that commits composition
 * runs both, and the text the IME then commits lands after the mention the
 * completion just inserted, leaving drafts like `@agent:claude`.
 */
export function composerCompletionHandlesKeyDown(input: {
  isComposing?: boolean;
  keyCode?: number;
  open: boolean;
  optionCount: number;
}): boolean {
  if (isImeKeyDown(input)) return false;
  if (!input.open) return false;
  return input.optionCount > 0;
}

export function emptyPasteAnchorSelection(draftLength: number): ComposerSelectionRange {
  return draftLength > 0 ? { start: draftLength, end: draftLength } : { start: 0, end: 0 };
}

export function composerPointerFocusSelection(input: {
  draftLength: number;
  textareaValueLength: number;
}): ComposerSelectionRange {
  const cursor = input.draftLength === 0 ? 0 : input.textareaValueLength;
  return { start: cursor, end: cursor };
}
