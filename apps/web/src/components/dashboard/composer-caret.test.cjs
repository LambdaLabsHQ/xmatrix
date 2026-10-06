const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  EMPTY_COMPOSER_PASTE_SENTINEL,
  composerCompletionHandlesKeyDown,
  composerDraftCursor,
  composerPointerFocusSelection,
  emptyPasteAnchorSelection,
  isComposerImeBeforeInput,
  isComposerImeKeyDown,
  scheduleTextareaSelection,
  stripEmptyPasteSentinel,
} = require("./composer-caret.ts");

test("empty composer paste anchor keeps a collapsed caret instead of selecting the sentinel", () => {
  assert.equal(EMPTY_COMPOSER_PASTE_SENTINEL.length, 1);
  assert.deepEqual(emptyPasteAnchorSelection(0), { start: 0, end: 0 });
  assert.notDeepEqual(
    emptyPasteAnchorSelection(0),
    { start: 0, end: EMPTY_COMPOSER_PASTE_SENTINEL.length },
    "selecting the zero-width sentinel reproduces the focused-without-visible-caret state"
  );
});

test("composer shell focus places the caret at real draft position when the textarea contains only the sentinel", () => {
  assert.deepEqual(
    composerPointerFocusSelection({
      draftLength: 0,
      textareaValueLength: EMPTY_COMPOSER_PASTE_SENTINEL.length,
    }),
    { start: 0, end: 0 }
  );
});

test("composer shell focus still moves to the end for real draft text", () => {
  assert.deepEqual(
    composerPointerFocusSelection({
      draftLength: 5,
      textareaValueLength: 5,
    }),
    { start: 5, end: 5 }
  );
});

test("composer paste handling strips sentinel characters before inserting text", () => {
  assert.equal(stripEmptyPasteSentinel(`${EMPTY_COMPOSER_PASTE_SENTINEL}hello`), "hello");
});

test("composer input cursor excludes the empty-paste sentinel on either side of typed text", () => {
  assert.equal(composerDraftCursor(`@${EMPTY_COMPOSER_PASTE_SENTINEL}`, 1), 1);
  assert.equal(composerDraftCursor(`${EMPTY_COMPOSER_PASTE_SENTINEL}@`, 2), 1);
});

/** Run `check` with a window whose next animation frame runs only when `runFrame` is called. */
function withDeferredFrame(check) {
  const originalWindow = global.window;
  let callback = null;
  global.window = {
    requestAnimationFrame: (next) => { callback = next; return 1; },
  };
  try {
    check(() => callback());
  } finally {
    global.window = originalWindow;
  }
}

test("a delayed selection cannot overwrite input entered during the intervening frame", () => {
  let focused = false;
  let selection = null;
  const textarea = {
    value: "@agent",
    focus: () => { focused = true; },
    setSelectionRange: (start, end) => { selection = { start, end }; },
  };
  withDeferredFrame((runFrame) => {
    scheduleTextareaSelection(() => textarea, "@agent", { start: 6, end: 6 });
    textarea.value = "@agent typed";
    runFrame();
    assert.equal(focused, false);
    assert.equal(selection, null);
  });
});

test("a delayed selection only applies to the textarea that scheduled it", () => {
  let currentTextarea;
  let replacementFocused = false;
  const textarea = {
    value: "@agent",
    focus: () => {},
    setSelectionRange: () => {},
  };
  const replacement = {
    value: "@agent",
    focus: () => { replacementFocused = true; },
    setSelectionRange: () => {},
  };
  currentTextarea = textarea;
  withDeferredFrame((runFrame) => {
    scheduleTextareaSelection(() => currentTextarea, "@agent", { start: 6, end: 6 });
    currentTextarea = replacement;
    runFrame();
    assert.equal(replacementFocused, false);
  });
});

test("a delayed selection applies while its textarea and value are still current", () => {
  let selection = null;
  let focusOptions = null;
  const textarea = {
    value: "@agent",
    focus: (options) => { focusOptions = options; },
    setSelectionRange: (start, end) => { selection = { start, end }; },
  };
  withDeferredFrame((runFrame) => {
    scheduleTextareaSelection(
      () => textarea,
      "@agent",
      { start: 6, end: 6 },
      { preventScroll: true }
    );
    runFrame();
    assert.deepEqual(focusOptions, { preventScroll: true });
    assert.deepEqual(selection, { start: 6, end: 6 });
  });
});

test("composer IME beforeinput detection recognizes composition text", () => {
  assert.equal(isComposerImeBeforeInput({ inputType: "insertCompositionText" }), true);
  assert.equal(isComposerImeBeforeInput({ isComposing: true }), true);
  assert.equal(isComposerImeBeforeInput({ inputType: "insertText" }), false);
});

test("composer IME keydown detection covers browsers that only report the IME key code", () => {
  assert.equal(isComposerImeKeyDown({ isComposing: true }), true);
  assert.equal(isComposerImeKeyDown({ keyCode: 229 }), true);
  assert.equal(isComposerImeKeyDown({ isComposing: false, keyCode: 13 }), false);
  assert.equal(isComposerImeKeyDown({}), false);
});

test("the completion list never takes a keystroke away from an input method", () => {
  /* Pinyin for an agent name puts the mention list on screen while the IME is
     still composing. Taking that Enter accepted the mention AND let the IME
     commit, so the typed text landed after the inserted mention — the reported
     `@claude-…-pro:claude`. Every navigation key is the candidate window's too. */
  const open = { open: true, optionCount: 3 };

  assert.equal(composerCompletionHandlesKeyDown({ ...open, isComposing: true }), false);
  assert.equal(composerCompletionHandlesKeyDown({ ...open, keyCode: 229 }), false);

  // Composition over: the list owns the same keys again.
  assert.equal(composerCompletionHandlesKeyDown({ ...open, isComposing: false }), true);
  assert.equal(composerCompletionHandlesKeyDown({ ...open }), true);
});

test("the completion list only takes keystrokes while it has something to offer", () => {
  assert.equal(composerCompletionHandlesKeyDown({ open: false, optionCount: 3 }), false);
  assert.equal(composerCompletionHandlesKeyDown({ open: true, optionCount: 0 }), false);
});
