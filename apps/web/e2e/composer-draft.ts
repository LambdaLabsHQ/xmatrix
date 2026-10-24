import { expect, type Locator } from "@playwright/test";

/** The composer's field as its element carries it (composer-editor.tsx): the draft as text, the caret in draft offsets. */
type DraftNode = HTMLElement & {
  composerField?: { value: string; selectionStart: number; selectionEnd: number; setSelectionRange(start: number, end: number): void };
};

export function draftValue(composer: Locator): Promise<string | null> {
  return composer.evaluate((node) => (node as DraftNode).composerField?.value ?? null);
}

export async function expectDraft(composer: Locator, expected: string | RegExp) {
  const value = expect.poll(() => draftValue(composer));
  if (typeof expected === "string") await value.toBe(expected);
  else await value.toMatch(expected);
}

export function draftSelection(composer: Locator) {
  return composer.evaluate((node) => {
    const field = (node as DraftNode).composerField;
    return { active: document.activeElement === node, selectionStart: field?.selectionStart, selectionEnd: field?.selectionEnd,
      value: field?.value };
  });
}

/** Put the caret at a draft offset, or just before the first occurrence of some text. */
export function setDraftSelection(composer: Locator, at: number | string) {
  return composer.evaluate((node, target) => {
    const field = (node as DraftNode).composerField!;
    const offset = typeof target === "number" ? target : field.value.indexOf(target);
    field.setSelectionRange(offset, offset);
  }, at);
}
