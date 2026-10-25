/** Only normalized assistant text enters this parser; traces and tool output never do. */
const OPEN = "⟦write page:";
const CLOSE = "⟦/write⟧";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

export interface PageOutputParserState { page: string | null; held: string }
export type PageOutputAction = { type: "open"; page: string } | { type: "text"; text: string } | { type: "close" };
export const emptyPageOutputParser = (): PageOutputParserState => ({ page: null, held: "" });

function target(text: string): string | null {
  const value = text.trim().replace(/^["'`]|["'`]$/gu, "");
  return UUID.test(value) ? value.toLowerCase() : null;
}

function suffix(text: string, marker: string): string {
  for (let i = Math.max(0, text.length - marker.length + 1); i < text.length; i++) {
    if (marker.startsWith(text.slice(i))) return text.slice(i);
  }
  return "";
}

function character(state: PageOutputParserState, char: string): PageOutputAction | null {
  const text = state.held + char;
  if (state.page) {
    if (text === CLOSE) { state.held = ""; state.page = null; return { type: "close" }; }
    state.held = suffix(text, CLOSE);
    const emitted = text.slice(0, text.length - state.held.length);
    return emitted ? { type: "text", text: emitted } : null;
  }
  if (text.startsWith(OPEN)) {
    if (char === "⟧") {
      state.held = "";
      state.page = target(text.slice(OPEN.length, -1));
      return state.page ? { type: "open", page: state.page } : null;
    }
    if (text.length <= OPEN.length + 48) { state.held = text; return null; }
  }
  state.held = suffix(text, OPEN);
  return null;
}

/**
 * Plan a prefix with at most one Page operation and ten text characters. The
 * caller commits this state only after the Page acknowledges that operation.
 * No unaccepted assistant text is kept at the Hub: the host resends the suffix.
 */
export function takePageOutput(state: PageOutputParserState, chars: readonly string[], from: number): {
  state: PageOutputParserState; consumed: number; action: PageOutputAction | null;
} {
  let current = { ...state };
  let consumed = 0;
  let action: PageOutputAction | null = null;
  for (let at = from; at < chars.length; at++) {
    const next = { ...current };
    const emitted = character(next, chars[at]);
    if (action && emitted && (action.type !== "text" || emitted.type !== "text" ||
        [...action.text, ...emitted.text].length > 10)) break;
    current = next;
    consumed++;
    if (emitted) {
      const prior: PageOutputAction | null = action as PageOutputAction | null;
      action = prior?.type === "text" && emitted.type === "text"
        ? { type: "text", text: prior.text + emitted.text } : emitted;
      if (action.type !== "text" || [...action.text].length === 10) break;
    }
  }
  return { state: current, consumed, action };
}

export function finishPageOutput(state: PageOutputParserState): {
  state: PageOutputParserState; consumed: number; action: PageOutputAction | null;
} {
  if (!state.page) return { state: emptyPageOutputParser(), consumed: 0, action: null };
  if (state.held) return { state: { ...state, held: "" }, consumed: 0, action: { type: "text", text: state.held } };
  return { state: emptyPageOutputParser(), consumed: 0, action: { type: "close" } };
}
