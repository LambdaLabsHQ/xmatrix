import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

// The app root must not infer its state from the mutable message tree. The
// scroll budget covers whole-app restyles, but a narrowly targeted descendant
// can pass that budget while reintroducing this global DOM dependency (#1414).
test("app root style state is explicit rather than inferred from descendants", async () => {
  const directory = new URL("./src/app/", import.meta.url);
  const violations = [];
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith(".css")) continue;
    const css = postcss.parse(await readFile(new URL(file, directory), "utf8"));
    css.walkRules(rule => {
      selectorParser(selectors => selectors.walkPseudos(pseudo => {
        if (pseudo.value !== ":has") return;
        // A combinator starts a new subject: local :has() on a control or
        // panel remains valid even when its selector begins at the app root.
        const nodes = pseudo.parent.nodes;
        const at = nodes.indexOf(pseudo);
        let start = at;
        while (start > 0 && nodes[start - 1].type !== "combinator") start -= 1;
        let end = at + 1;
        while (end < nodes.length && nodes[end].type !== "combinator") end += 1;
        const compound = nodes.slice(start, end);
        if (compound.some(node => node.type === "class" &&
            ["xmatrix-app", "xmatrix-app-shell"].includes(node.value))) {
          violations.push(`${file}:${rule.source.start.line} ${rule.selector}`);
        }
      })).processSync(rule.selector);
    });
  }
  assert.deepEqual(violations, [], "derive app state from its model, not its descendant DOM");
});
