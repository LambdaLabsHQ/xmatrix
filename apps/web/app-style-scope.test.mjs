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

// A `:has()` that is not on the rule's own subject makes everything after it
// part of what the browser restyles when it re-checks that `:has()`, and it
// re-checks on every node inserted under an ancestor any such rule watches.
// Blink keeps one such set for the whole page: a subject named only by its tag
// (`... :has(x) article > button`) puts every button in the app into it, and
// each row a scrolling timeline mounts then restyled all of them.
test("a rule behind someone else's :has() names its subject by more than a tag", async () => {
  const directory = new URL("./src/app/", import.meta.url);
  const violations = [];
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith(".css")) continue;
    const css = postcss.parse(await readFile(new URL(file, directory), "utf8"));
    css.walkRules(rule => {
      selectorParser(selectors => selectors.each(selector => {
        const compounds = [[]];
        for (const node of selector.nodes) {
          if (node.type === "combinator") compounds.push([]);
          else compounds.at(-1).push(node);
        }
        const subject = compounds.pop();
        const hasAhead = compounds.some(compound => compound.some(node => node.type === "pseudo" && node.value === ":has"));
        if (!hasAhead) return;
        // A negation names nothing: `input:not([type=file])` is still every input.
        // Form fields may stand by their tag: a screen holds a handful, and a
        // field's wrapper styling it through `:has(> input) > input` is local.
        const named = subject.some(node => ["class", "id", "attribute"].includes(node.type) ||
          (node.type === "tag" && ["input", "textarea", "select"].includes(node.value)));
        if (!named) violations.push(`${file}:${rule.source.start.line} ${String(selector).trim()}`);
      })).processSync(rule.selector);
    });
  }
  assert.deepEqual(violations, [], "give the subject a class or attribute, or put the state on an ancestor as one");
});

// A selection or highlight rule that matches every element costs each one a
// second style whenever it is styled: four of them made a message row five
// times as expensive to mount. Where highlights inherit, name one ancestor;
// the every-element form is only for the engines that need it.
test("a selection or highlight rule matches every element only where highlights do not inherit", async () => {
  const directory = new URL("./src/app/", import.meta.url);
  const violations = [];
  for (const file of await readdir(directory, { recursive: true })) {
    if (!file.endsWith(".css")) continue;
    const css = postcss.parse(await readFile(new URL(file, directory), "utf8"));
    css.walkRules(rule => {
      selectorParser(selectors => selectors.each(selector => {
        const compounds = [[]];
        for (const node of selector.nodes) {
          if (node.type === "combinator") compounds.push([]);
          else compounds.at(-1).push(node);
        }
        const subject = compounds.at(-1);
        if (!subject.some(node => node.type === "pseudo" && ["::selection", "::highlight"].includes(node.value))) return;
        const text = String(selector);
        if (text.includes(":not([data-highlight-inherit])")) return;
        // `:is(body, .a)` names its elements; `:not(...)` and `*` name none.
        const named = subject.some(node => ["class", "id", "attribute", "tag"].includes(node.type) ||
          (node.type === "pseudo" && [":is", ":where", ":root"].includes(node.value)));
        if (!named) violations.push(`${file}:${rule.source.start.line} ${text.trim()}`);
      })).processSync(rule.selector);
    });
  }
  assert.deepEqual(violations, [], "name one ancestor under [data-highlight-inherit]; keep the every-element form under :not([data-highlight-inherit])");
});

// No new global CSS. A rule in a stylesheet is matched against every element
// the app ever styles, and nothing in it says which component it belongs to;
// both causes of the timeline's scroll cost were single rules here. New styling
// goes on the element as utility classes or a theme variable. Variables added
// to an existing rule, @keyframes and @font-face are not counted. The number
// only goes down: moving a rule out of a stylesheet lowers it in the same change.
test("the stylesheets hold no more rules than css-rule-budget.json records", async () => {
  const source = new URL("./src/", import.meta.url);
  let rules = 0;
  for (const file of await readdir(source, { recursive: true })) {
    if (!file.endsWith(".css")) continue;
    postcss.parse(await readFile(new URL(file, source), "utf8")).walkRules(rule => {
      if (rule.parent.type === "atrule" && /keyframes$/u.test(rule.parent.name)) return;
      rules += 1;
    });
  }
  const { rules: budget } = JSON.parse(await readFile(new URL("./css-rule-budget.json", import.meta.url), "utf8"));
  assert.ok(rules <= budget, `${rules} rules, ${rules - budget} over the budget: style the element with utility classes instead of adding a rule`);
  assert.equal(rules, budget, `${budget - rules} rules were removed: lower css-rule-budget.json to ${rules}`);
});
