"use client";

import { useEffect, useMemo, useState } from "react";
import type { HLJSApi } from "highlight.js";

// highlight.js and its grammars load after the first code block appears, so a conversation without code never
// downloads them; a block draws as plain ink until they arrive and then takes its colours in place.
let highlighter: HLJSApi | null = null;
let loading: Promise<HLJSApi> | null = null;

const GRAMMARS = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  shell: () => import("highlight.js/lib/languages/shell"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

// A fence that names no language is coloured only when one of these clearly claims it; a table, a log or prose
// in a fence stays plain ink rather than taking a guess's colours.
const DETECTED = ["bash", "json", "typescript", "python", "yaml", "sql", "diff", "swift", "rust", "go", "css", "xml"];
const DETECTION_RELEVANCE = 4;

/** highlight.js once it has loaded, else null. */
export function loadedHighlighter(): HLJSApi | null {
  return highlighter;
}

export function loadHighlighter(): Promise<HLJSApi> {
  loading ??= (async () => {
    const [{ default: hljs }, grammars] = await Promise.all([
      import("highlight.js/lib/core"),
      Promise.all(Object.entries(GRAMMARS).map(async ([name, load]) => [name, (await load()).default] as const)),
    ]);
    for (const [name, grammar] of grammars) hljs.registerLanguage(name, grammar);
    highlighter = hljs;
    return hljs;
  })();
  return loading;
}

export function highlightCode(hljs: HLJSApi, text: string, language: string): string | null {
  if (language) {
    return hljs.getLanguage(language) ? hljs.highlight(text, { language, ignoreIllegals: true }).value : null;
  }
  const detected = hljs.highlightAuto(text, DETECTED);
  return detected.relevance >= DETECTION_RELEVANCE ? detected.value : null;
}

export type CodeInkRun = { from: number; to: number; className: string };

/** The coloured runs of a highlighted text as offsets into it, for an editor that draws them as decorations. */
export function highlightRuns(hljs: HLJSApi, text: string, language: string): CodeInkRun[] | null {
  const html = highlightCode(hljs, text, language);
  if (html === null) return null;
  const template = document.createElement("template");
  template.innerHTML = html;
  const runs: CodeInkRun[] = [];
  let offset = 0;
  const walk = (node: Node, className: string) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const length = child.textContent?.length ?? 0;
        if (className && length) runs.push({ from: offset, to: offset + length, className });
        offset += length;
      } else if (child instanceof Element) {
        walk(child, [className, child.className].filter(Boolean).join(" "));
      }
    }
  };
  walk(template.content, "");
  return runs;
}

/** The block's highlighted markup (escaped by highlight.js), or null while loading or when nothing claims it. */
export function useHighlightedCode(text: string, language: string): string | null {
  const [hljs, setHljs] = useState(highlighter);
  useEffect(() => {
    if (hljs) return;
    let live = true;
    void loadHighlighter().then((loaded) => {
      if (live) setHljs(() => loaded);
    });
    return () => {
      live = false;
    };
  }, [hljs]);
  return useMemo(() => (hljs ? highlightCode(hljs, text, language) : null), [hljs, text, language]);
}

const LANGUAGE_NAMES: Record<string, string> = {
  bash: "Bash", sh: "Shell", shell: "Shell", zsh: "Zsh", console: "Terminal", shellsession: "Terminal",
  js: "JavaScript", javascript: "JavaScript", jsx: "JSX", ts: "TypeScript", typescript: "TypeScript", tsx: "TSX",
  json: "JSON", jsonc: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", ini: "INI",
  py: "Python", python: "Python", rb: "Ruby", ruby: "Ruby", go: "Go", golang: "Go", rs: "Rust", rust: "Rust",
  swift: "Swift", kotlin: "Kotlin", kt: "Kotlin", java: "Java", c: "C", cpp: "C++", php: "PHP",
  sql: "SQL", diff: "Diff", patch: "Diff", css: "CSS", html: "HTML", xml: "XML", svg: "SVG",
  md: "Markdown", markdown: "Markdown", dockerfile: "Dockerfile", docker: "Dockerfile", text: "Text", txt: "Text",
};
const TERMINAL_LANGUAGES = new Set(["bash", "sh", "shell", "zsh", "console", "shellsession", "powershell", "ps1", "fish"]);
const DATA_LANGUAGES = new Set(["json", "jsonc", "yaml", "yml", "toml", "ini"]);

/** How a fence's language reads above its code: a proper name, and whether it is a terminal, data or source. */
export function codeLanguageLabel(language: string): { name: string; kind: "terminal" | "data" | "source" } {
  const key = language.toLowerCase();
  const kind = TERMINAL_LANGUAGES.has(key) ? "terminal" : DATA_LANGUAGES.has(key) ? "data" : "source";
  return { name: LANGUAGE_NAMES[key] ?? language, kind };
}
