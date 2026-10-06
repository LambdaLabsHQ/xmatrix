"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { webSourceTree, strippedOfComments } = require("./source-scan-fixture.cjs");

/* The app's language is monochrome plus one brass accent, and globals.css
   enforces it with a sweep that rewrites every `amber-*` / `emerald-*` /
   `sky-*` / `orange-*` utility to grey. A state written as one of those
   colours therefore renders as no state at all, silently, with no error
   anywhere — which is exactly how "Review required" and "cli" ended up as two
   identical grey pills on the Agents page.

   Deleting those 206 utilities once does not keep them gone; the next person
   reaching for a warning colour will reach for amber again, and nothing will
   tell them it did not work. So this test is the thing that tells them. */

const tree = webSourceTree();
const SWEPT = /\b(?:bg|text|border|ring|from|to|via|divide|outline|decoration|shadow|accent|caret|fill|stroke)-(?:amber|emerald|sky|orange)-\d{2,3}\b/;

/* The only exemption, and it is in the sweep itself: presence dots keep the
   product's vivid status colours. globals.css re-asserts the real values for
   `.identity-avatar-status` / `.app-presence-status-dot`, so those utilities
   are load-bearing rather than dead. */
const EXEMPT = new Set(["identity-avatar.tsx"]);

test("no swept colour utility is used to mean a status", () => {
  const offenders = [];
  for (const file of tree.files(/\.tsx?$/)) {
    if (EXEMPT.has(tree.basename(file))) continue;
    const lines = strippedOfComments(tree.read(file)).split("\n");
    lines.forEach((line, index) => {
      if (SWEPT.test(line)) {
        offenders.push(`${tree.relative(file)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "these render as flat grey under the monochrome sweep in globals.css; " +
      "say the state with statusChipClass / noticeClass / statusInkClass from " +
      "@/components/ui/status-tone instead:\n" +
      offenders.join("\n")
  );
});

test("there is exactly one segmented control", () => {
  const offenders = [];
  for (const file of tree.files(/\.tsx?$/)) {
    if (tree.basename(file) === "segmented-tabs.tsx") continue;
    const source = tree.read(file);
    if (/role="tablist"/.test(strippedOfComments(source))) {
      offenders.push(tree.relative(file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a tab bar must be the shared SegmentedTabs from @/components/ui/segmented-tabs; " +
      "four hand-rolled ones drifted into four different materials before it existed:\n" +
      offenders.join("\n")
  );
});

test("there is no native select", () => {
  /* The product owner ruled this twice: "不允许使用系统下拉框", then — when the
     replacement was built as a portalled menu — "我都说了不要悬浮窗". A native
     control paints the platform's own popup, on the platform's background,
     with padding nothing here can reach; a portalled panel is that same popup
     rebuilt in our materials. GlassSelect opens in the document flow instead.

     This is a guard rather than a comment because the ruling was already a
     year old and twenty native selects had accumulated under it. */
  const offenders = [];
  for (const file of tree.files(/\.tsx?$/)) {
    const lines = strippedOfComments(tree.read(file)).split("\n");
    lines.forEach((line, index) => {
      if (/<select[\s>]/.test(line)) {
        offenders.push(`${tree.relative(file)}:${index + 1}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "use GlassSelect from @/components/ui/glass-select:\n" + offenders.join("\n")
  );
});
