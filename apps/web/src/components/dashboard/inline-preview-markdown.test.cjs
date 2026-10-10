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

function renderPreview(channel) {
  function loadComponent(file) {
    const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
      fileName: file,
    }).outputText;
    const mod = { exports: {} };
    new Function("exports", "require", "module", compiled)(mod.exports, (id) => {
      if (id === "./inline-preview-markdown") return loaded.exports;
      if (id === "./inline-row-preview") return loadComponent("inline-row-preview.tsx");
      return require(id);
    }, mod);
    return mod.exports;
  }
  const { ChannelRowPreview } = loadComponent("channel-row-preview.tsx");
  return require("react-dom/server").renderToStaticMarkup(
    require("react").createElement(ChannelRowPreview, { channel }),
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
