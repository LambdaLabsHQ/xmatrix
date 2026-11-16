import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { loadTypescriptModule } from "./load-typescript-module.mjs";

const table = JSON.parse(await readFile(new URL("../src/media-types.json", import.meta.url), "utf8"));
const { attachmentKind, extensionForMediaType, mediaTypeForName, mediaTypeOf, PAGE_MEDIA_TYPES, playableMediaKind } =
  await loadTypescriptModule(new URL("../src/media-types.ts", import.meta.url));
const { pageMediaFile, pageMediaReference } = await import("../dist/index.js");

const hash = "a".repeat(64);

test("the table names each extension and type once, and never a markup type", () => {
  const extensions = table.types.flatMap((entry) => entry.extensions);
  const types = table.types.flatMap((entry) => [entry.type, ...entry.aliases ?? []]);
  assert.equal(new Set(extensions).size, extensions.length);
  assert.equal(new Set(types).size, types.length);
  assert.ok(!types.some((type) => /svg|html|xml|javascript/u.test(type)));
  for (const entry of table.types) {
    assert.ok(!entry.image || entry.type.startsWith("image/"), entry.type);
    assert.ok(!entry.page || /^(image|video)\//u.test(entry.type), entry.type);
  }
});

test("every reader of a file's type answers from the table", () => {
  for (const entry of table.types) {
    for (const extension of entry.extensions) {
      assert.equal(mediaTypeForName(`file.${extension.toUpperCase()}`), entry.type);
      assert.equal(mediaTypeOf("application/octet-stream", `file.${extension}`), entry.type);
      assert.equal(pageMediaFile(`${hash}.${extension}`)?.mimeType, entry.page ? entry.type : undefined, extension);
    }
    for (const type of [entry.type, ...entry.aliases ?? []]) {
      assert.equal(mediaTypeOf(`${type.toUpperCase()}; charset=utf-8`, "x.bin"), entry.type);
      assert.equal(extensionForMediaType(type), entry.extensions[0]);
      const kind = entry.image ? "image" : entry.type.startsWith("video/") ? "video"
        : entry.type === "text/markdown" ? "markdown" : "file";
      assert.equal(attachmentKind(type), kind, type);
      assert.equal(pageMediaReference(hash, type),
        entry.page ? `xmatrix:page-media/${hash}.${entry.extensions[0]}` : null, type);
    }
  }
  assert.deepEqual(Object.values(PAGE_MEDIA_TYPES).sort(),
    table.types.filter((entry) => entry.page).flatMap((entry) => entry.extensions.map(() => entry.type)).sort());
});

test("a specific stated type wins over the name; a generic one is read from the name", () => {
  assert.equal(mediaTypeOf("text/html", "page.webm"), "text/html");
  assert.equal(playableMediaKind("application/pdf", "paper.mp3"), null);
  assert.equal(playableMediaKind("audio/webm", "clip.webm"), "audio");
  assert.equal(playableMediaKind(" VIDEO/WEBM; codecs=vp9 ", "unknown.bin"), "video");
  assert.equal(playableMediaKind("binary/octet-stream", "voice.m4a"), "audio");
  assert.equal(mediaTypeOf("", "clip.webm.exe"), "application/octet-stream");
  assert.equal(mediaTypeOf("not a type", "blob"), "application/octet-stream");
  assert.equal(attachmentKind("", "screen.PNG"), "image");
  assert.equal(attachmentKind("image/svg+xml", "logo.svg"), "file");
  assert.equal(extensionForMediaType("application/x-unknown"), undefined);
});
