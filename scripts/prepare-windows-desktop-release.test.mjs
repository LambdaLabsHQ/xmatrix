import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareWindowsDesktopRelease } from "./prepare-windows-desktop-release.mjs";

async function withBuild(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xmatrix-windows-release-"));
  const sourceDirectory = path.join(root, "build");
  const stageDirectory = path.join(root, "stage");
  try {
    await mkdir(sourceDirectory);
    await writeFile(path.join(sourceDirectory, "xMatrix-0.16.117-x64.exe"), "installer-bytes");
    await writeFile(path.join(sourceDirectory, "xMatrix-0.16.117-x64.exe.blockmap"), "blockmap-bytes");
    await run({ sourceDirectory, stageDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("stages the versioned Windows asset set with its updater manifest", async () => {
  await withBuild(async ({ sourceDirectory, stageDirectory }) => {
    const assets = await prepareWindowsDesktopRelease({ sourceDirectory, stageDirectory, version: "0.16.117" });
    assert.deepEqual(assets, ["xMatrix-0.16.117-x64.exe", "xMatrix-0.16.117-x64.exe.blockmap", "latest.yml"]);
    assert.deepEqual((await readdir(stageDirectory)).sort(), [...assets].sort());
    const updater = await readFile(path.join(stageDirectory, "latest.yml"), "utf8");
    assert.match(updater, /version: 0\.16\.117/u);
    assert.match(updater, /url: xMatrix-0\.16\.117-x64\.exe/u);
  });
});

test("rejects an ambiguous Windows installer output", async () => {
  await withBuild(async ({ sourceDirectory, stageDirectory }) => {
    await writeFile(path.join(sourceDirectory, "second.exe"), "other");
    await assert.rejects(
      prepareWindowsDesktopRelease({
        sourceDirectory,
        stageDirectory,
        version: "0.16.117",
      }),
      /Expected exactly one Windows installer/u,
    );
  });
});
