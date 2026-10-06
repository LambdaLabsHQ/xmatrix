import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { nextBuildCacheDir, runWithNextBuildCache } from "./next-build-cache.mjs";

function layout() {
  const root = mkdtempSync(path.join(os.tmpdir(), "xmatrix-next-cache-"));
  return { cacheDir: path.join(root, "home/next-cache/runner-1"), appCacheDir: path.join(root, "app/.next/cache") };
}

test("the Next build cache is carried per runner only in CI", () => {
  assert.equal(nextBuildCacheDir({ CI: "true", RUNNER_NAME: "local-linux-x64-2" }, "/home/u"),
    "/home/u/.cache/xmatrix/next-cache/local-linux-x64-2");
  assert.equal(nextBuildCacheDir({ RUNNER_NAME: "local-linux-x64-2" }, "/home/u"), null, "developers keep their own .next");
  assert.equal(nextBuildCacheDir({ CI: "true", RUNNER_NAME: "../escape" }, "/home/u"), null);
  assert.equal(nextBuildCacheDir({ XMATRIX_NEXT_CACHE_DIR: "/tmp/explicit" }, "/home/u"), "/tmp/explicit");
});

test("the cache moves in before the build and back out after it, pass or fail", () => {
  const { cacheDir, appCacheDir } = layout();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, "webpack.pack"), "warm");
  for (const status of [0, 1]) {
    const seen = [];
    const code = runWithNextBuildCache("build", [], {
      cacheDir,
      appCacheDir,
      run: () => {
        seen.push(readFileSync(path.join(appCacheDir, "webpack.pack"), "utf8"));
        writeFileSync(path.join(appCacheDir, "webpack.pack"), `written-${status}`);
        return { status };
      },
    });
    assert.equal(code, status);
    assert.equal(existsSync(appCacheDir), false, "the checkout keeps no cache between runs");
    assert.equal(readFileSync(path.join(cacheDir, "webpack.pack"), "utf8"), `written-${status}`);
    assert.deepEqual(seen, [status === 0 ? "warm" : "written-0"]);
  }
});

test("a first build seeds the cache, and an oversized cache is dropped", () => {
  const { cacheDir, appCacheDir } = layout();
  const build = () => {
    mkdirSync(appCacheDir, { recursive: true });
    writeFileSync(path.join(appCacheDir, "webpack.pack"), "x".repeat(4096));
    return { status: 0 };
  };
  assert.equal(runWithNextBuildCache("build", [], { cacheDir, appCacheDir, run: build }), 0);
  assert.equal(existsSync(path.join(cacheDir, "webpack.pack")), true);

  const other = layout();
  runWithNextBuildCache("build", [], { cacheDir: other.cacheDir, appCacheDir: other.appCacheDir, maxBytes: 1024, run: () => {
    mkdirSync(other.appCacheDir, { recursive: true });
    writeFileSync(path.join(other.appCacheDir, "webpack.pack"), "x".repeat(4096));
    return { status: 0 };
  } });
  assert.equal(existsSync(other.cacheDir), false);
  assert.equal(existsSync(other.appCacheDir), false);
});

test("without a cache location the command simply runs", () => {
  const { appCacheDir } = layout();
  assert.equal(runWithNextBuildCache("build", [], { cacheDir: null, appCacheDir, run: () => ({ status: 3 }) }), 3);
});
