import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  parseMissingPackages,
  playwrightLinuxLibraryPath,
} from "./playwright-linux-deps.mjs";

test("parseMissingPackages reads Playwright's dry-run package report", () => {
  const output = [
    "Missing system dependencies (3):",
    "  libnspr4",
    "  libnss3",
    "  libx11-6",
    "",
    "Chromium 142.0 (playwright build v1228)",
  ].join("\n");

  assert.deepEqual(parseMissingPackages(output), ["libnspr4", "libnss3", "libx11-6"]);
});

test("parseMissingPackages leaves successful dry runs empty", () => {
  assert.deepEqual(parseMissingPackages("All system dependencies are installed.\n"), []);
});

test("playwrightLinuxLibraryPath preserves the inherited loader path", () => {
  const value = playwrightLinuxLibraryPath("/tmp/playwright-deps", "/existing/libs");
  const entries = value.split(path.delimiter);

  assert.equal(entries.at(-1), "/existing/libs");
  assert.ok(entries.some((entry) => entry.endsWith(path.join("current", "usr", "lib"))));
});
