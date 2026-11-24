// The page as an Agent reads it (`xmatrix browse`): its accessibility
// snapshot, as Playwright's `locator.ariaSnapshot()` writes it (Daniel
// 2026-11-24: not a file, not Markdown; align with Playwright, without a
// dependency on it). The tree and its YAML come from Playwright's own code,
// copied into ./playwright under its Apache-2.0 license (see README.md there):
// roles and accessible names by the ARIA and accname specifications, nothing
// hidden, link addresses as `/url`. Read only, so no `[ref=…]` handles.
//
// package.mjs bundles this into the extension's src/page-snapshot.js; the side
// panel injects that into the tab it reads, then calls the function it leaves.
import { generateAriaTree, renderAriaTree } from "./playwright/injected/ariaSnapshot";

declare global {
  // eslint-disable-next-line no-var
  var __xmatrixPageSnapshot: ((maxChars: number) => string) | undefined;
}

/** The page's snapshot, at most `maxChars` characters, cut at a line. */
globalThis.__xmatrixPageSnapshot = (maxChars: number) => {
  const tree = generateAriaTree(document.body, { mode: "default" });
  const text = renderAriaTree(tree, { mode: "default" }).text;
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return `${text.slice(0, cut > 0 ? cut : maxChars)}\n- text: … (the page goes on; the snapshot was cut at ${maxChars} characters)`;
};
