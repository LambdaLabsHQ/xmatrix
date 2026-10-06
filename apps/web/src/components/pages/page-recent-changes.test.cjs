const assert = require("node:assert/strict");
const test = require("node:test");
require("../dashboard/typescript-require.cjs").installTypeScriptRequire();

const { pageRecentChangePreview, pageTreeHeadKey } = require("./page-recent-changes.ts");

const codex = { kind: "agent", id: "i-1", label: "codex" };

test("a recent change reads as a conversation preview: who, then what they wrote", () => {
  assert.equal(pageRecentChangePreview({ authors: [codex], gist: "Sentry install passed", created: false }),
    "codex: Sentry install passed");
  assert.equal(pageRecentChangePreview({ authors: [codex, codex, { kind: "user", id: "u", label: "Yiming" }],
    gist: null, created: true }), "codex, Yiming: Created the page");
  assert.equal(pageRecentChangePreview({ authors: [], gist: null, created: false }), "Edited",
    "a change that only removed text, by nobody named, still says it changed");
});

test("the tree's head key moves with any page's head and with pages coming or going, not otherwise", () => {
  const pages = [{ headRevision: 3, updatedAt: "2026-10-04T18:00:00.000Z" },
    { headRevision: 7, updatedAt: "2026-10-04T18:12:00.000Z" }];
  const key = pageTreeHeadKey(pages);
  assert.equal(pageTreeHeadKey([...pages].reverse()), key);
  assert.notEqual(pageTreeHeadKey([pages[0], { headRevision: 8, updatedAt: "2026-10-04T18:13:00.000Z" }]), key);
  assert.notEqual(pageTreeHeadKey(pages.slice(1)), key);
});
