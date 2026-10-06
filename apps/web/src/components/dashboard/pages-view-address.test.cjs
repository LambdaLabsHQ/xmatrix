const assert = require("node:assert/strict");
const test = require("node:test");
const ts = require("typescript");
const {
  navigationSource,
  extractFunctionSource,
} = require("./workspace-shell-layout-test-context.cjs");

// The Pages view's address is written by one function and read by its reverse.
const source = ["parseAppLocation", "pagesViewPath", "pagesViewSelection"]
  .map((name) => extractFunctionSource(navigationSource, name)).join("\n");
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const { pagesViewPath, pagesViewSelection } = new Function("exports", `${outputText}\nreturn exports;`)({});

test("a Pages address reads back as the page and conversation it was written for", () => {
  const selection = { pageId: "p 1", conversationId: "c1" };
  const location = pagesViewPath("/app/space/pages", selection.pageId, selection.conversationId);
  assert.deepEqual(pagesViewSelection(location), selection);
  assert.deepEqual(pagesViewSelection(pagesViewPath("/app/space/pages", "p1", null)), { pageId: "p1", conversationId: null });
  assert.deepEqual(pagesViewSelection("/app/space/pages"), { pageId: null, conversationId: null });
  // An address from before repository mounts were removed still opens its page.
  assert.deepEqual(pagesViewSelection("/app/space/pages?page=p1&mount=m1&path=README.md"),
    { pageId: "p1", conversationId: null });
});

test("nothing outside the navigation module parses the Pages address itself", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["../pages/pages-view.tsx", "page-shell-actions.ts", "use-workspace-shell-state.ts"]) {
    const text = fs.readFileSync(path.join(__dirname, file), "utf8");
    assert.doesNotMatch(text, /searchParams\.get\("(page|conversation)"\)|\?page=\$\{/u, file);
  }
});
