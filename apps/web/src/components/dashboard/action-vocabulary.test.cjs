"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webSourceTree, strippedOfComments } = require("./source-scan-fixture.cjs");

/* Every action on the board is one shape in one material. The theme layer has
   painted them that way for a while, but it did it by guessing at whatever
   utilities the call site happened to write, so the *geometry* stayed with
   150 hand-copied class strings and drifted: "New agent" shipped 40px tall
   with 12px of padding, "New secret" beside it was 36px, "Connect GitHub"
   carried 16px. Nothing chose any of that.

   Guessing at utilities also decides who is in the vocabulary at all. The
   radius rule is scoped to `.app-tool-surface`, so the setup cards on
   Projects and Security — the same buttons, one wrapper out — rendered at 4px
   while the board was at 12px.

   None of that fails anything. A hand-written button looks approximately
   right, and only a measurement tells you it is 4px off. So this is the thing
   that fails. */

const tree = webSourceTree();
const APP_CSS = "app/globals.css";
const MATERIALS_CSS = "app/themes/materials.css";
const ACTION_TONE = "components/ui/action-tone.ts";

/* Chat chrome is a different vocabulary on purpose: the sidebar, the message
   timeline, the composer and the dialog shell each have their own material,
   and dialog buttons are explicitly exempted from the board rules in CSS. */
const NOT_THE_BOARD = new Set([
  "workspace-channel-sidebar.tsx",
  "workspace-message-timeline.tsx",
  "workspace-shell-chrome.tsx",
  "workspace-composer-dialogs.tsx",
  "composer-input.tsx",
  "composer-completion.tsx",
  "sidebar-pane.tsx",
  "centered-dialog-shell.tsx",
  "workspace-shell-formatters.tsx",
  "workspace-shell-recovered.tsx",
]);

/* A hand-written action: a sized box that also names its own material. */
const SIZED = /\b(?:h-(?:7|8|9|10|11)|size-(?:7|8|9|10|11))\b/;
const MATERIAL = /\b(?:border-border|bg-foreground|bg-primary|bg-destructive|border-destructive\/40)\b/;

/** Every `<button>`/`<Link>` opening tag, with braces and strings respected. */
function openingTags(source) {
  const tags = [];
  const re = /<(?:button|Link)\b/g;
  let match;
  while ((match = re.exec(source))) {
    let index = match.index;
    let brace = 0;
    let quote = null;
    for (; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") quote = char;
      else if (char === "{") brace += 1;
      else if (char === "}") brace -= 1;
      else if (char === ">" && brace === 0) break;
    }
    tags.push({ text: source.slice(match.index, index), at: match.index });
  }
  return tags;
}

test("no action on the board writes its own size and material", () => {
  const offenders = [];
  for (const file of tree.files( /\.tsx$/)) {
    if (NOT_THE_BOARD.has(tree.basename(file))) continue;
    const source = strippedOfComments(tree.read(file));
    for (const tag of openingTags(source)) {
      const written = /className="([^"]+)"/.exec(tag.text);
      if (!written) continue;
      const classes = written[1];
      /* A dialog button is a different vocabulary and says so by name; the
         board's CSS exempts `.app-dialog-button` explicitly. */
      if (classes.includes("app-dialog-button")) continue;
      if (!SIZED.test(classes) || !MATERIAL.test(classes)) continue;
      const line = source.slice(0, tag.at).split("\n").length;
      offenders.push(`${tree.relative(file)}:${line}: ${classes.slice(0, 110)}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `Actions must ask for the shared vocabulary — actionClass({ variant, size }) from ` +
      `components/ui/action-tone — instead of writing a height and a material by hand:\n${offenders.join("\n")}`
  );
});

test("the action scale has one entry per step and no second material", () => {
  const source = tree.readRelative(ACTION_TONE);
  for (const variant of ["primary", "secondary", "danger", "quiet"]) {
    assert.match(source, new RegExp(`${variant}: "app-action-${variant}"`));
  }
  /* Geometry is here and nowhere else, so a size cannot be half-adopted. */
  for (const [size, geometry] of [
    ["sm", "h-7 gap-1.5 px-2.5 text-xs"],
    ["md", "h-9 gap-2 px-3 text-sm"],
    ["lg", "h-10 gap-2 px-4 text-sm"],
    ["icon-sm", "size-7"],
    ["icon", "size-8"],
    ["icon-lg", "size-9"],
  ]) {
    assert.ok(
      source.includes(`"${geometry}"`),
      `the ${size} step must stay the one place its geometry is written`
    );
  }
});

test("the board's material rules key on the action class, not on utility guesses", () => {
  const globals = tree.readRelative(APP_CSS);
  assert.match(globals, /\.xmatrix-app \.app-action \{/);
  assert.match(globals, /\.xmatrix-app :is\(\.app-action-secondary, \.app-action-danger\),/);
  assert.match(globals, /\.xmatrix-app \.app-action-primary,/);
  /* The private copies these replaced. Each was one button describing its own
     material, which is how the board grew four of them. */
  assert.doesNotMatch(globals, /app-secrets-primary-action/);
  assert.doesNotMatch(globals, /app-action-pill/);
  assert.doesNotMatch(tree.readRelative(MATERIALS_CSS), /app-space-agent-use-button/);
});

/* Specificity of a selector, sufficient for the compound chains this repo
   writes: element names, `*`, `.class`, `#id`, `[attr]`, `:not()`, `:is()`
   and plain pseudo-classes. `:where()` contributes nothing. */
function specificityOf(selector) {
  const total = { ids: 0, classes: 0, elements: 0 };
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === ":" && selector[i + 1] === ":") {
      total.elements += 1;
      const m = /^[-\w]+/.exec(selector.slice(i + 2));
      i += 2 + (m ? m[0].length : 0);
      continue;
    }
    if (ch === ":") {
      const m = /^[-\w]+/.exec(selector.slice(i + 1));
      const pseudo = m ? m[0] : "";
      const after = i + 1 + pseudo.length;
      if (selector[after] === "(") {
        let depth = 0;
        let j = after;
        for (; j < selector.length; j += 1) {
          if (selector[j] === "(") depth += 1;
          else if (selector[j] === ")" && --depth === 0) break;
        }
        if (pseudo === "is" || pseudo === "not" || pseudo === "has") {
          let best = { ids: 0, classes: 0, elements: 0 };
          for (const part of selector.slice(after + 1, j).split(",")) {
            const s = specificityOf(part.trim());
            if (
              s.ids > best.ids ||
              (s.ids === best.ids && s.classes > best.classes) ||
              (s.ids === best.ids && s.classes === best.classes && s.elements > best.elements)
            ) best = s;
          }
          total.ids += best.ids;
          total.classes += best.classes;
          total.elements += best.elements;
        }
        i = j + 1;
        continue;
      }
      total.classes += 1;
      i = after;
      continue;
    }
    if (ch === "." || ch === "#") {
      if (ch === ".") total.classes += 1;
      else total.ids += 1;
      const m = /^[-\w]+/.exec(selector.slice(i + 1));
      i += 1 + (m ? m[0].length : 0);
      continue;
    }
    if (ch === "[") {
      total.classes += 1;
      const close = selector.indexOf("]", i);
      i = close === -1 ? selector.length : close + 1;
      continue;
    }
    if (ch === "*") {
      i += 1;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const m = /^[-\w]+/.exec(selector.slice(i));
      total.elements += 1;
      i += m[0].length;
      continue;
    }
    i += 1;
  }
  return total;
}

function outranks(a, b) {
  if (a.ids !== b.ids) return a.ids > b.ids;
  if (a.classes !== b.classes) return a.classes > b.classes;
  return a.elements >= b.elements;
}

test("a dialog action outranks the chrome sweep and stays one glass", () => {
  const materials = tree.readRelative(MATERIALS_CSS);
  const globals = tree.readRelative(APP_CSS);
  /* globals.css blanks backgrounds on every generic element through a
     `.xmatrix-app *:not(...)` chain. Adding one more `:not` to that chain once
     silently deleted the dialog's primary action — the pale, unreadable
     button under the trace-access banner. The dialog actions must outrank the
     sweep and state their fill explicitly so a future `:not` cannot delete
     the action again. */
  const sweep = /\.xmatrix-app \*((?::not\([^)]*\))+),/.exec(globals);
  assert.ok(sweep, "the background-image sweep selector must exist");
  const sweepSpecificity = specificityOf(`.xmatrix-app *${sweep[1]}`);

  const actionSelectors = (
    materials.match(
      /html\[data-app-theme\] \.xmatrix-app :is\([^)]*\) (?::is\()?button\.(?:bg-primary|app-dialog-button-destructive)/g
    ) || []
  ).filter((selector) => selector.includes("app-dialog-panel") || selector.includes("app-form-page"));
  assert.ok(actionSelectors.length >= 2, "primary and destructive dialog actions must exist");
  for (const selector of actionSelectors) {
    assert.ok(
      outranks(specificityOf(selector.replace(/ :is\($/, " ")), sweepSpecificity),
      `the dialog action must outrank the background sweep: ${selector}`
    );
  }
  assert.match(materials, /background-color: var\(--app-dialog-action-fill-primary\) !important;/);
  /* The design owner sent the espresso stamp back (2026-10-01): actions are
     the board's glass with dark ink, destructive ones only change the ink. */
  assert.doesNotMatch(materials, /--m-stamp-/);
  assert.doesNotMatch(tree.readRelative("app/themes/wood.css"), /--m-stamp-/);
  assert.doesNotMatch(materials, /linear-gradient\(180deg, oklch\(0\.52 0\.16 28\)/);
});

test("wood is a plaque a component opts into, and a field wears one ring", () => {
  const materials = tree.readRelative(MATERIALS_CSS);
  /* A selector that painted every bordered box on a tool page as wood put
     wood inside glass cards (Apps drew a card inside a card) and around
     fields that already had a well. Tool pages are paper now, so there is no
     plaque at all. */
  assert.doesNotMatch(materials, /\.app-tool-surface div\.rounded-(lg|md)\.border/);
  assert.doesNotMatch(materials, /--m-plaque-fill/);
  assert.doesNotMatch(tree.readRelative("app/liquid-glass.css"), /@utility app-plaque\b/);
  assert.match(materials, /:has\(\s*> input:not\(\[type="checkbox"\]\):not\(\[type="radio"\]\)\s*\) > input \{[\s\S]*?box-shadow: none !important;/);
});
