const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const protocol = require("@xmatrix/protocol");
const { extractFunctionFromShellModules, loadWorkspaceShellModuleMap } = require("./workspace-shell-source-fixture.cjs");

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "attachment-media-type.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
new Function("module", "exports", "require", compiled)(loaded, loaded.exports, require);
const { directMediaLink } = loaded.exports;

function shellFunction(name, bindings) {
  const { source } = extractFunctionFromShellModules(loadWorkspaceShellModuleMap(__dirname), name);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(bindings), js)(exported, ...Object.values(bindings));
  return exported[name];
}

const { attachmentKind, extensionForMediaType, mediaTypeForName, mediaTypeOf } = protocol;
const isMarkdownAttachmentFile = shellFunction("isMarkdownAttachmentFile", { attachmentKind, mediaTypeForName });
const mimeForFile = shellFunction("attachmentMimeTypeForFile", { isMarkdownAttachmentFile, mediaTypeOf });
const kindForFile = shellFunction("channelAttachmentKindForFile", { isMarkdownAttachmentFile, attachmentKind });
const presentation = shellFunction("presentationAttachmentKind", { attachmentKind });
const filename = shellFunction("attachmentFilenameForMimeType", { extensionForMediaType, mediaTypeForName });

test("a dropped file is typed and drawn from the shared media table", () => {
  assert.equal(mimeForFile({ type: "", name: "clip.webm" }), "video/webm");
  assert.equal(kindForFile({ type: "", name: "clip.webm" }), "video");
  assert.equal(mimeForFile({ type: "", name: "voice.opus" }), "audio/ogg");
  assert.equal(kindForFile({ type: "image/avif", name: "photo.avif" }), "file", "AVIF is page media, not a chat image");
  assert.equal(kindForFile({ type: "image/png", name: "screen" }), "image");
  // Browsers often state nothing, or plain text, for Markdown.
  for (const file of [{ type: "", name: "notes.md" }, { type: "text/plain", name: "notes.markdown" },
    { type: "text/x-markdown", name: "notes" }]) {
    assert.equal(mimeForFile(file), "text/markdown");
    assert.equal(kindForFile(file), "markdown");
  }
  assert.equal(mimeForFile({ type: "not a type", name: "blob" }), "application/octet-stream");
});

test("existing file-kind rows keep specialized kinds and discover playable media by name", () => {
  assert.equal(presentation({ kind: "file", mimeType: "application/octet-stream", name: "handoff-anim.webm" }), "video");
  assert.equal(presentation({ mimeType: "video/webm", name: "clip" }), "video");
  assert.equal(presentation({ kind: "markdown", mimeType: "text/markdown", name: "clip.webm" }), "markdown");
});

test("a download is named with the stored type's extension, replacing a known one", () => {
  assert.equal(filename("track", "audio/flac"), "track.flac");
  assert.equal(filename("IMG_1.jpeg", "image/jpeg"), "IMG_1.jpg");
  assert.equal(filename("notes.txt", "text/markdown"), "notes.md");
  assert.equal(filename("archive.tar", "application/zip"), "archive.tar.zip");
  assert.equal(filename("data.bin", "application/x-unknown"), "data.bin");
});

test("direct media URLs accept HTTPS filenames with queries but reject other schemes and credential URLs", () => {
  assert.equal(directMediaLink("https://media.example/clip.webm?token=123#t=1"), "video");
  assert.equal(directMediaLink("https://media.example/voice%2Emp3"), "audio");
  for (const url of ["javascript:alert(1)", "file:///clip.webm", "http://media.example/clip.webm", "https://u:p@media.example/a.mp4", "https://media.example/watch?v=123", "https://media.example/%ZZ.mp4"]) {
    assert.equal(directMediaLink(url), null);
  }
});
