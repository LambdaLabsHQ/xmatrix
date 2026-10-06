const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const { extractFunctionFromShellModules, loadWorkspaceShellModuleMap } = require("./workspace-shell-source-fixture.cjs");

const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "attachment-media-type.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
new Function("module", "exports", compiled)(loaded, loaded.exports);
const { attachmentMediaMimeType, attachmentMediaType, directMediaLink } = loaded.exports;

function shellFunction(name, bindings) {
  const { source } = extractFunctionFromShellModules(loadWorkspaceShellModuleMap(__dirname), name);
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const exported = {};
  new Function("exports", ...Object.keys(bindings), js)(exported, ...Object.values(bindings));
  return exported[name];
}

test("generic and missing MIME discover video/audio extensions, without overriding specific types", () => {
  for (const name of ["handoff-anim.webm", "clip.MP4", "clip.mov", "clip.ogv", "clip.mkv"]) {
    assert.equal(attachmentMediaType("application/octet-stream", name), "video");
    assert.equal(attachmentMediaType("", name), "video");
  }
  for (const name of ["voice.mp3", "voice.m4a", "voice.wav", "voice.flac", "voice.opus"]) {
    assert.equal(attachmentMediaType("application/octet-stream", name), "audio");
  }
  assert.equal(attachmentMediaMimeType("binary/octet-stream", "clip.webm"), "video/webm");
  assert.equal(attachmentMediaType(" VIDEO/WEBM; codecs=vp9 ", "unknown.bin"), "video");
  assert.equal(attachmentMediaType("audio/webm", "clip.webm"), "audio");
  assert.equal(attachmentMediaType("text/html", "page.webm"), null);
  assert.equal(attachmentMediaType("application/pdf", "paper.mp3"), null);
  assert.equal(attachmentMediaType("", "clip.webm.exe"), null);
});

test("existing file-kind WebM rows and upload files use the same presentation inference", () => {
  const kindForMime = shellFunction("channelAttachmentKindForMimeType", {
    attachmentMediaType,
    IMAGE_ATTACHMENT_TYPES: new Set(["image/png"]),
    MARKDOWN_ATTACHMENT_TYPES: new Set(["text/markdown"]),
  });
  const presentation = shellFunction("presentationAttachmentKind", { channelAttachmentKindForMimeType: kindForMime });
  assert.equal(presentation({ kind: "file", mimeType: "application/octet-stream", name: "handoff-anim.webm" }), "video");
  assert.equal(presentation({ mimeType: "video/webm", name: "clip" }), "video");
  assert.equal(presentation({ kind: "markdown", mimeType: "text/markdown", name: "clip.webm" }), "markdown");
  const mimeForFile = shellFunction("attachmentMimeTypeForFile", {
    attachmentMediaMimeType,
    isMarkdownAttachmentFile: () => false,
    normalizeAttachmentMimeType: (mime) => mime,
  });
  const kindForFile = shellFunction("channelAttachmentKindForFile", {
    isMarkdownAttachmentFile: () => false,
    channelAttachmentKindForMimeType: kindForMime,
  });
  const file = { type: "", name: "clip.webm" };
  assert.equal(mimeForFile(file), "video/webm");
  assert.equal(kindForFile(file), "video");
});

test("direct media URLs accept HTTPS filenames with queries but reject other schemes and credential URLs", () => {
  assert.equal(directMediaLink("https://media.example/clip.webm?token=123#t=1"), "video");
  assert.equal(directMediaLink("https://media.example/voice%2Emp3"), "audio");
  for (const url of ["javascript:alert(1)", "file:///clip.webm", "http://media.example/clip.webm", "https://u:p@media.example/a.mp4", "https://media.example/watch?v=123", "https://media.example/%ZZ.mp4"]) {
    assert.equal(directMediaLink(url), null);
  }
});
