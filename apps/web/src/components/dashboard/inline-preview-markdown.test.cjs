const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const compiled = ts.transpileModule(
  fs.readFileSync(path.join(__dirname, "inline-preview-markdown.ts"), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;
const loaded = { exports: {} };
new Function("exports", compiled)(loaded.exports);
const { channelPreviewModel, inlinePreviewSegments } = loaded.exports;

function visible(source) {
  return inlinePreviewSegments(source).map((segment) => segment.text).join("");
}

test("a conversation preview renders inline marks and leaves the rest as text", () => {
  const source = "新进展： - **新发现 (A 线)**: 用...";
  assert.deepEqual(inlinePreviewSegments(source), [
    { mark: "text", text: "新进展： - " },
    { mark: "strong", text: "新发现 (A 线)" },
    { mark: "text", text: ": 用..." },
  ]);
  assert.equal(visible(source), "新进展： - 新发现 (A 线): 用...");

  assert.deepEqual(inlinePreviewSegments("say __this__ and *that* and _so_"), [
    { mark: "text", text: "say " },
    { mark: "strong", text: "this" },
    { mark: "text", text: " and " },
    { mark: "em", text: "that" },
    { mark: "text", text: " and " },
    { mark: "em", text: "so" },
  ]);
  assert.deepEqual(inlinePreviewSegments("keep `**stars**` and snake_case_name"), [
    { mark: "text", text: "keep " },
    { mark: "code", text: "**stars**" },
    { mark: "text", text: " and snake_case_name" },
  ]);
  assert.deepEqual(inlinePreviewSegments("~~old~~ [**notes**](https://example.test/secret) ![shot](https://cdn.test/a.png)"), [
    { mark: "strike", text: "old" },
    { mark: "text", text: " " },
    { mark: "strong", text: "notes" },
    { mark: "text", text: " shot" },
  ]);
  assert.deepEqual(inlinePreviewSegments("a \\* b"), [{ mark: "text", text: "a * b" }]);
  assert.deepEqual(inlinePreviewSegments("<b>no html</b>"), [{ mark: "text", text: "<b>no html</b>" }]);
  assert.deepEqual(inlinePreviewSegments("**unclosed"), [{ mark: "text", text: "**unclosed" }]);
  assert.deepEqual(inlinePreviewSegments("***both***"), [{ mark: "strong", text: "both" }]);
});

function renderPreview(channel, catalog = null) {
  const modules = new Map();
  function loadComponent(file) {
    file = path.resolve(__dirname, file);
    if (modules.has(file)) return modules.get(file);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText;
    const mod = { exports: {} };
    new Function("exports", "require", "module", compiled)(mod.exports, (id) => {
      if (id.startsWith(".")) {
        const target = path.resolve(path.dirname(file), id);
        return loadComponent(fs.existsSync(`${target}.ts`) ? `${target}.ts` : `${target}.tsx`);
      }
      return require(id);
    }, mod);
    modules.set(file, mod.exports);
    return mod.exports;
  }
  const { ChannelRowPreview } = loadComponent("channel-row-preview.tsx");
  const { MessageReferenceCatalogProvider } = loadComponent("message-reference-catalog.tsx");
  const { createElement } = require("react");
  return require("react-dom/server").renderToStaticMarkup(
    createElement(MessageReferenceCatalogProvider, { catalog }, createElement(ChannelRowPreview, { channel })),
  );
}

test("the row renders the author's text plain and the body's inline marks", () => {
  const html = renderPreview({
    lastMessage: {
      from: { label: "**claude:3**" },
      bodyPreview: "新进展： - **新发现 (A 线)**: *notes* `code` ~~old~~",
    },
  });
  assert.equal(html, "**claude:3**: 新进展： - <strong>新发现 (A 线)</strong>: <em>notes</em> <code>code</code> <s>old</s>");
});

// The screenshot's system message went through this compact renderer, bypassing message chips.
// Test the actual rendered preview so raw IDs cannot leak via its Markdown marks or missing context.
test("previews show current reference titles and never fall back to Page locators", () => {
  const pageId = "1d183157-be5d-4d07-9c31-203fe5688245";
  const channelId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const preview = (bodyPreview, catalog) => renderPreview({
    lastMessage: { from: { label: "xMatrix" }, bodyPreview },
  }, catalog);
  const catalog = { pages: [{ pageId, title: "巴厘岛旅居计划" }], channels: [
    { id: channelId, name: "Planning" },
  ] };
  assert.equal(preview(`Co-writing page:${pageId} live.`, catalog), "xMatrix: Co-writing 巴厘岛旅居计划 live.");
  assert.equal(preview(`Co-writing page:${pageId} ended.`), "xMatrix: Co-writing Page ended.");
  assert.equal(preview(`**page:${pageId}#plan (r4)** and \`channel:${channelId}\``, catalog),
    "xMatrix: <strong>巴厘岛旅居计划 › Section (r4)</strong> and <code>Planning</code>");
  assert.equal(preview(`page:${pageId} and channel:${channelId}`, { pages: [], channels: [] }), "xMatrix: Page and Channel");
  assert.equal(preview(`\`page:${pageId.slice(0, 19)}...`), "xMatrix: `Page");
  assert.equal(preview(`page:${pageId}`, { ...catalog, pages: [{ pageId, title: "**Renamed** <script>" }] }),
    "xMatrix: **Renamed** &lt;script&gt;");
  assert.equal(preview(`[page:${pageId}](https://example.test)`), "xMatrix: Page");
});

test("the preview line keeps the author in front of the body", () => {
  assert.deepEqual(channelPreviewModel({
    lastMessage: { from: { label: "claude:3" }, bodyPreview: "新进展： - **新发现 (A 线)**: 用..." },
  }), { kind: "rich", label: "claude:3", body: "新进展： - **新发现 (A 线)**: 用..." });
  assert.deepEqual(channelPreviewModel({
    lastMessage: { from: { label: "Yiming" }, bodyPreview: "" },
    topic: "ignored when someone spoke",
  }), { kind: "plain", text: "Yiming" });
  assert.deepEqual(channelPreviewModel({ topic: "Where trains ship" }), { kind: "plain", text: "Where trains ship" });
  assert.deepEqual(channelPreviewModel({}), { kind: "plain", text: "No messages yet" });
});
