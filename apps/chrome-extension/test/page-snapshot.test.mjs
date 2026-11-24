import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPageSnapshot } from "../scripts/package.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendored = path.join(root, "snapshot", "playwright");

// Playwright v1.61.1's own files (snapshot/playwright/README.md), by the SHA-256 of their upstream text.
const UPSTREAM = {
  "injected/ariaSnapshot.ts": "75289e8cd6955167c6b6efc5f3117c752b5327e3a8251453ee307938a32c8f88",
  "injected/domUtils.ts": "4f4409017865de7650d4d46bf7e8416c92fbc2ef4ec5fc6a435a318dd77d3d6e",
  "injected/roleUtils.ts": "ddba18db70c8c08cdadeaab7cab80de9ded7acc0361377be052910298e258a03",
  "isomorphic/ariaSnapshot.ts": "531daf2c14cecc90fffc1c3903230af677c4bafbb8ac32c5c661cffa169acd35",
  "isomorphic/cssTokenizer.ts": "beffbe943b63c10af3cfa325e163e7593f91f0824e18a5f7f77062b119e386bc",
  "isomorphic/stringUtils.ts": "6703bfb0d574a3acb4024c4f1d9116b9a4561aecfc7273dcd96e748be8e61979",
  "isomorphic/yaml.ts": "805b5de857749599fcf979b1e00b35ad89beb807c189e163fd264a891110dd29",
};

// The page an Agent reads is Playwright's snapshot, unedited: only the import alias is rewritten.
test("the vendored snapshot code is Playwright's, with only its import alias rewritten", () => {
  const files = fs.readdirSync(vendored, { recursive: true }).filter((file) => file.endsWith(".ts")).sort();
  assert.deepEqual(files, Object.keys(UPSTREAM).sort());
  for (const [file, hash] of Object.entries(UPSTREAM)) {
    const upstream = fs.readFileSync(path.join(vendored, file), "utf8").replaceAll("from '../isomorphic/", "from '@isomorphic/");
    assert.equal(createHash("sha256").update(upstream).digest("hex"), hash, `${file} differs from Playwright v1.61.1`);
  }
  for (const notice of ["LICENSE", "NOTICE"]) assert.ok(fs.statSync(path.join(vendored, notice)).size > 0);
});

test("the page script builds, and carries Playwright's license with it", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "page-snapshot-"));
  const script = path.join(out, "page-snapshot.js");
  await buildPageSnapshot(script);
  const code = fs.readFileSync(script, "utf8");
  assert.match(code, /__xmatrixPageSnapshot/u);
  assert.match(code, /Apache License 2\.0/u);
  const license = fs.readFileSync(path.join(out, "page-snapshot.LICENSE.txt"), "utf8");
  assert.match(license, /^Playwright\nCopyright \(c\) Microsoft Corporation/u);
  assert.match(license, /Apache License\s+Version 2\.0/u);
});
