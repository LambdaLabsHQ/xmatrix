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
  const source = fs.readFileSync(path.join(__dirname, "channel-row-preview.tsx"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: "channel-row-preview.tsx",
  }).outputText;
  const nodes = [];
  const jsx = (type, props, key) => {
    if (typeof type === "function") return type(props);
    const node = { type, props, key };
    nodes.push(node);
    return node;
  };
  const runtime = { jsx, jsxs: jsx, Fragment: "fragment" };
  const react = { Fragment: "fragment" };
  const mod = { exports: {} };
  new Function("exports", "require", "module", compiled)(mod.exports, (id) => {
    if (id === "react/jsx-runtime") return runtime;
    if (id === "react") return react;
    if (id === "./inline-preview-markdown") return loaded.exports;
    throw new Error(`unexpected import ${id}`);
  }, mod);
  mod.exports.ChannelRowPreview({ channel });
  return nodes;
}

test("the row renders the author's text plain and the body's bold as strong", () => {
  const nodes = renderPreview({
    lastMessage: {
      from: { label: "claude:3" },
      bodyPreview: "新进展： - **新发现 (A 线)**: 用...",
    },
  });
  const strong = nodes.find((node) => node.type === "strong");
  assert.equal(strong.props.children, "新发现 (A 线)");
  const root = nodes.find((node) => node.type === "fragment" && Array.isArray(node.props.children));
  assert.deepEqual(root.props.children.slice(0, 2), ["claude:3", ": "]);
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
