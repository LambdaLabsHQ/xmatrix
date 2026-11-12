import type { HLJSApi, Language } from "highlight.js";

/**
 * Norn (https://github.com/norn-lang/norn), the language of the programs a
 * message or a page runs. The inks follow what a reader looks for: who is
 * asked (`@codex`), what is asked of them (`run`, `ask`, `wait`), the
 * outcomes a program must handle (`Answered`, `Broke`), and its `~labels`.
 */
const EFFECTS = ["ask", "confirm", "choose", "run", "judge", "wait", "waitUntil", "cancel", "handOver", "status", "say",
  "first", "all", "anyOf", "after", "every", "never", "fail", "ignore", "show"];

export default function norn(hljs: HLJSApi): Language {
  const interpolation = { className: "subst", begin: /\$\{/, end: /\}/ };
  return {
    name: "Norn",
    keywords: { keyword: ["let", "rec", "and", "if", "else", "switch", "type", "open", "as", "external"], literal: ["true", "false"],
      built_in: EFFECTS },
    contains: [
      hljs.C_LINE_COMMENT_MODE,
      // A reference to a document or a conversation: doc"ops#machines".
      { className: "string", begin: /\b[a-z][A-Za-z]*"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE] },
      { className: "string", begin: /"/, end: /"/, contains: [hljs.BACKSLASH_ESCAPE] },
      { className: "string", begin: /`/, end: /`/, contains: [hljs.BACKSLASH_ESCAPE, interpolation] },
      // A participant, the way a mention reads everywhere else: @codex, @claude:2.
      { className: "title", begin: /@[A-Za-z][A-Za-z0-9_-]*(?::[0-9]+)?/ },
      { className: "attr", begin: /~[a-z][A-Za-z0-9_]*/ },
      // A duration (30m, 2d) or a number.
      { className: "number", begin: /\b\d+(?:\.\d+)?(?:ms|s|m|h|d|w)?\b/ },
      // A constructor or a module: Answered, Flawed, Std.
      { className: "type", begin: /\b[A-Z][A-Za-z0-9_]*/ },
      { className: "type", begin: /'[a-z][A-Za-z0-9_]*/ },
    ],
  };
}
