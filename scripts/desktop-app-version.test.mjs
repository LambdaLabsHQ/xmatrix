import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyPackagedAppVersion } from "./desktop-app-version.mjs";

// An archive laid out as electron-builder writes it: a size pickle, the header
// pickle with its JSON, then the files.
function asar(files) {
  let offset = 0;
  const entries = {};
  for (const [name, text] of Object.entries(files)) {
    entries[name] = { size: Buffer.byteLength(text), offset: String(offset) };
    offset += Buffer.byteLength(text);
  }
  const json = Buffer.from(JSON.stringify({ files: entries }));
  const padded = Math.ceil(json.length / 4) * 4;
  const header = Buffer.alloc(8 + padded);
  header.writeUInt32LE(4 + padded, 0);
  header.writeUInt32LE(json.length, 4);
  json.copy(header, 8);
  const size = Buffer.alloc(8);
  size.writeUInt32LE(4, 0);
  size.writeUInt32LE(header.length, 4);
  return Buffer.concat([size, header, ...Object.values(files).map((text) => Buffer.from(text))]);
}

test("a packaged app passes only when its own package.json carries the release version", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-desktop-asar-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const archive = path.join(directory, "app.asar");
  writeFileSync(archive, asar({
    "main.js": "console.log('xMatrix');\n",
    "package.json": JSON.stringify({ name: "@xmatrix/desktop", version: "1.0.606-beta.1" }),
  }));
  assert.equal(verifyPackagedAppVersion(archive, "1.0.606-beta.1"), "1.0.606-beta.1");
  // The updater manifest may name the right version while the app inside runs as another.
  assert.throws(() => verifyPackagedAppVersion(archive, "1.0.606-beta.10"), /runs as 1\.0\.606-beta\.1, not the release version/u);
  assert.throws(() => verifyPackagedAppVersion(archive, "1.0.606"), /not the release version 1\.0\.606/u);

  writeFileSync(archive, asar({ "main.js": "x" }));
  assert.throws(() => verifyPackagedAppVersion(archive, "1.0.606"), /has no packed package\.json/u);
});
