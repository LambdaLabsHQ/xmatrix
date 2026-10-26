const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const fs = require("node:fs");
const ts = require("typescript");
const { extractFunctionFromShellModules, loadWorkspaceShellModuleMap } = require("./workspace-shell-source-fixture.cjs");

function loadTsModule(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const loaded = { exports: {} };
  new Function("module", "exports", compiled.outputText)(loaded, loaded.exports);
  return loaded.exports;
}

function loadMediaIdentity() {
  const { source: fn } = extractFunctionFromShellModules(
    loadWorkspaceShellModuleMap(__dirname),
    "relayV2AttachmentMediaIdentity",
  );
  const compiled = ts.transpileModule(fn, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exported = {};
  new Function("exports", compiled.outputText)(exported);
  return exported.relayV2AttachmentMediaIdentity;
}

test("attachments restored from the durable tail cache after a restart still load their media", () => {
  const identity = loadMediaIdentity();
  const { buildProductTailCacheEntry } = loadTsModule(
    path.join(__dirname, "../../lib/relay-v2/product-tail-cache.ts"),
  );
  const hash = "a".repeat(64);
  const live = {
    id: "att-1", kind: "image", name: "zz-channel.png", mimeType: "image/png",
    size: 344537, version: 1, contentHash: hash, objectKey: `objects/${hash}`,
  };
  const [restored] = buildProductTailCacheEntry({
    userId: "user-1",
    channelId: "c1",
    hasOlderMessages: false,
    cachedAt: 1000,
    contentRevision: 1,
    messages: [{ messageId: "m1", sequence: 1, body: "before/after", attachments: [live] }],
  }).messages[0].attachments;

  assert.equal(restored.objectKey, undefined, "the tail cache keeps storage locators off disk");
  assert.ok(identity(live));
  assert.equal(
    identity(restored),
    identity(live),
    "a restored row must reach the loader instead of failing closed as unavailable",
  );
  assert.equal(identity({ ...live, objectKey: `objects/${"b".repeat(64)}` }), undefined);
  assert.equal(identity({ ...live, contentHash: undefined, objectKey: undefined }), undefined);
});

// Receiver hydration already retained its Blob. This exercises the sender's
// actual upload result against the same reader, with the browser's CSP boundary.
test("a just-uploaded Markdown file opens without fetching its object URL", async () => {
  const { evaluateExtractedSource } = require("./workspace-shell-source-fixture.cjs");
  const modules = loadWorkspaceShellModuleMap(__dirname);
  const uploadSource = extractFunctionFromShellModules(modules, "uploadChannelAttachment").source;
  const readSource = extractFunctionFromShellModules(modules, "loadAttachmentBlob").source;
  const { uploadChannelAttachment, loadAttachmentBlob } = evaluateExtractedSource(
    `${uploadSource}\n${readSource}`,
    {
      attachmentMimeTypeForFile: file => file.type,
      channelAttachmentKindForFile: () => "markdown",
      prepareMessageAttachmentUpload: async () => ({ attachmentId: "qa-upload", name: "qa.md" }),
      attachmentFetchHref: attachment => attachment.url,
      xmatrixRawResponse: async () => { throw new TypeError("CSP blocks blob: fetch"); },
    },
  );
  const file = new File(["# QA upload\n\nImmediate preview."], "qa.md", { type: "text/markdown" });
  const attachment = await uploadChannelAttachment("space-qa", "token-qa", file);
  try {
    assert.equal(await (await loadAttachmentBlob(attachment)).text(), await file.text());
  } finally {
    URL.revokeObjectURL(attachment.url);
  }
});
