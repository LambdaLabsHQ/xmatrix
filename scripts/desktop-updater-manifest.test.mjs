import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { writeMacUpdaterManifest } from "./desktop-updater-manifest.mjs";

test("macOS updater manifest names the versioned artifacts with their digests", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xmatrix-updater-manifest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = "1.2.3";
  const releaseDate = "2026-10-03T20:00:00.000Z";
  const assets = new Map(["zip", "dmg", "zip.blockmap", "dmg.blockmap"].map((extension) => [
    extension, Buffer.from(`signed ${extension} fixture`),
  ]));
  for (const [extension, bytes] of assets) {
    await writeFile(path.join(directory, `xMatrix-${version}-arm64.${extension}`), bytes);
  }
  const cli = spawnSync(process.execPath, [
    fileURLToPath(new URL("./desktop-updater-manifest.mjs", import.meta.url)), directory,
  ], { encoding: "utf8", env: { ...process.env, DESKTOP_VERSION: version } });
  assert.equal(cli.status, 0, cli.stderr);
  writeMacUpdaterManifest({ directory, version, releaseDate });
  const files = ["zip", "dmg"].map((extension) => ({
    url: `xMatrix-${version}-arm64.${extension}`,
    sha512: createHash("sha512").update(assets.get(extension)).digest("base64"),
    size: assets.get(extension).length,
  }));
  assert.deepEqual(parse(await readFile(path.join(directory, "latest-mac.yml"), "utf8")), {
    version, files, path: files[0].url, sha512: files[0].sha512, releaseDate,
  });
});
