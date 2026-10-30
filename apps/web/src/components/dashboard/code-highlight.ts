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

function loadHighlighter(): Promise<HLJSApi> {
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
