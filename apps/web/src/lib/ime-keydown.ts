/**
 * Whether a keydown belongs to an input method rather than to the field.
 * While an IME is composing, Enter and Tab commit its candidate, the arrows
 * walk its candidate list and Escape cancels it, so every one of those keys is
 * already spoken for. Pass the native event: `event.nativeEvent` in React.
 */
export function isImeKeyDown(input: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  // Some WebKit builds clear `isComposing` on the very keydown that commits the
  // candidate while still reporting the IME's own key code, so both are checked.
  return Boolean(input.isComposing) || input.keyCode === 229;
}
