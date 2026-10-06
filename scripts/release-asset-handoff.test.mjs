import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createReleaseAssetHandoff, verifyReleaseAssetHandoff } from "./release-asset-handoff.mjs";

const options = { manifestName: "release-assets.json", label: "Test" };
const createHandoff = (directory, names) => createReleaseAssetHandoff(directory, names, options);
const verifyHandoff = (directory, names) => verifyReleaseAssetHandoff(directory, names, options);
const assetNames = ["xMatrix-0.16.12-x64.exe", "xMatrix-0.16.12-x64.exe.blockmap", "latest.yml"];

async function withHandoffDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmatrix-release-handoff-"));
  try {
    await Promise.all(assetNames.map((name, index) => writeFile(path.join(directory, name), `asset-${index}`)));
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("release asset handoff verifies an exact SHA-256 manifest", async () => {
  await withHandoffDirectory(async (directory) => {
    const manifest = await createHandoff(directory, assetNames);
    assert.equal(manifest.schema, 1);
    assert.deepEqual(manifest.assets.map((asset) => asset.name), assetNames);
    assert.match(await readFile(path.join(directory, options.manifestName), "utf8"), /"sha256"/u);
    await assert.doesNotReject(verifyHandoff(directory, assetNames));
  });
});

test("release asset handoff rejects changed assets and unlisted files", async () => {
  await withHandoffDirectory(async (directory) => {
    await createHandoff(directory, assetNames);
    await writeFile(path.join(directory, assetNames[0]), "tamper!");
    await assert.rejects(verifyHandoff(directory, assetNames), /SHA-256 mismatch/u);
  });

  await withHandoffDirectory(async (directory) => {
    await createHandoff(directory, assetNames);
    await writeFile(path.join(directory, "unexpected.txt"), "unexpected");
    await assert.rejects(verifyHandoff(directory, assetNames), /Unexpected Test handoff contents/u);
  });
});

test("release asset handoff refuses unsafe asset names", async () => {
  await withHandoffDirectory(async (directory) => {
    await assert.rejects(
      createHandoff(directory, ["../outside.exe"]),
      /Invalid handoff asset name/u,
    );
  });
});
