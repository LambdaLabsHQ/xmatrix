import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

/** Every style rule in the stylesheets under `directory`, with the file it is in. */
async function styleRules(directory) {
  const root = new URL(directory, import.meta.url);
  const rules = [];
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith(".css")) continue;
    postcss.parse(await readFile(new URL(file, root), "utf8")).walkRules(rule => rules.push({ file, rule }));
  }
  return rules;
}

/** A selector as its compounds, left to right: the nodes between combinators. */
function compoundsOf(selector) {
  const compounds = [[]];
  for (const node of selector.nodes) {
    if (node.type === "combinator") compounds.push([]);
    else compounds.at(-1).push(node);
  }
  return compounds;
}

/** `file:line selector` for each of the app's selectors that `breaks` the rule. */
async function selectorViolations(breaks) {
  const violations = [];
  for (const { file, rule } of await styleRules("./src/app/")) {
    selectorParser(selectors => selectors.each(selector => {
      if (breaks(compoundsOf(selector), String(selector))) {
        violations.push(`${file}:${rule.source.start.line} ${String(selector).trim()}`);
      }
    })).processSync(rule.selector);
  }
  return violations;
}

const isPseudo = (node, ...values) => node.type === "pseudo" && values.includes(node.value);

// The app root must not infer its state from the mutable message tree. The
// scroll budget covers whole-app restyles, but a narrowly targeted descendant
// can pass that budget while reintroducing this global DOM dependency (#1414).
// A combinator starts a new subject: local :has() on a control or panel
// remains valid even when its selector begins at the app root.
test("app root style state is explicit rather than inferred from descendants", async () => {
  const violations = await selectorViolations(compounds => compounds.some(compound =>
    compound.some(node => isPseudo(node, ":has")) &&
    compound.some(node => node.type === "class" && ["xmatrix-app", "xmatrix-app-shell"].includes(node.value))));
  assert.deepEqual(violations, [], "derive app state from its model, not its descendant DOM");
});

// A `:has()` that is not on the rule's own subject makes everything after it
// part of what the browser restyles when it re-checks that `:has()`, and it
// re-checks on every node inserted under an ancestor any such rule watches.
// Blink keeps one such set for the whole page: a subject named only by its tag
// (`... :has(x) article > button`) puts every button in the app into it, and
// each row a scrolling timeline mounts then restyled all of them.
test("a rule behind someone else's :has() names its subject by more than a tag", async () => {
  const violations = await selectorViolations(compounds => {
    const subject = compounds.at(-1);
    if (!compounds.slice(0, -1).some(compound => compound.some(node => isPseudo(node, ":has")))) return false;
    // A negation names nothing: `input:not([type=file])` is still every input.
    // Form fields may stand by their tag: a screen holds a handful, and a
    // field's wrapper styling it through `:has(> input) > input` is local.
    return !subject.some(node => ["class", "id", "attribute"].includes(node.type) ||
      (node.type === "tag" && ["input", "textarea", "select"].includes(node.value)));
  });
  assert.deepEqual(violations, [], "give the subject a class or attribute, or put the state on an ancestor as one");
});

// A selection or highlight rule that matches every element costs each one a
// second style whenever it is styled: four of them made a message row five
// times as expensive to mount. Where highlights inherit, name one ancestor;
// the every-element form is only for the engines that need it.
test("a selection or highlight rule matches every element only where highlights do not inherit", async () => {
  const violations = await selectorViolations((compounds, text) => {
    const subject = compounds.at(-1);
    if (!subject.some(node => isPseudo(node, "::selection", "::highlight"))) return false;
    if (text.includes(":not([data-highlight-inherit])")) return false;
    // `:is(body, .a)` names its elements; `:not(...)` and `*` name none.
    return !subject.some(node => ["class", "id", "attribute", "tag"].includes(node.type) ||
      isPseudo(node, ":is", ":where", ":root"));
  });
  assert.deepEqual(violations, [], "name one ancestor under [data-highlight-inherit]; keep the every-element form under :not([data-highlight-inherit])");
});

// No new global CSS. A rule in a stylesheet is matched against every element
// the app ever styles, and nothing in it says which component it belongs to;
// both causes of the timeline's scroll cost were single rules here. New styling
// goes on the element as utility classes or a theme variable. Variables added
// to an existing rule, @keyframes and @font-face are not counted. The number
// only goes down: moving a rule out of a stylesheet lowers it in the same change.
test("the stylesheets hold no more rules than css-rule-budget.json records", async () => {
  const rules = (await styleRules("./src/")).filter(({ rule }) =>
    !(rule.parent.type === "atrule" && rule.parent.name.endsWith("keyframes"))).length;
  const { rules: budget } = JSON.parse(await readFile(new URL("./css-rule-budget.json", import.meta.url), "utf8"));
  assert.ok(rules <= budget, `${rules} rules, ${rules - budget} over the budget: style the element with utility classes instead of adding a rule`);
  assert.equal(rules, budget, `${budget - rules} rules were removed: lower css-rule-budget.json to ${rules}`);
});
