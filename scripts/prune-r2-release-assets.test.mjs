import assert from "node:assert/strict";
import test from "node:test";
import { validatePrunableRelease } from "./prune-r2-release-assets.mjs";

const prefix = "releases/cli-v1.2.3";
const sha256 = "a".repeat(64);
const manifest = {
  schemaVersion: 1,
  prefix,
  releaseTag: "cli-v1.2.3",
  files: [{ name: "xmatrix-linux-x64", key: `${prefix}/xmatrix-linux-x64`, size: 42, sha256 }],
};
const old = "2025-01-01T00:00:00.000Z";
const objects = [
  { key: `${prefix}/xmatrix-linux-x64`, last_modified: old },
  { key: `${prefix}/xmatrix-r2-manifest.json`, last_modified: old },
];
const release = {
  tag_name: "cli-v1.2.3",
  draft: false,
  prerelease: false,
  body: "archived\n<!-- xmatrix-release-transaction:r2-archive-123:1 -->",
  assets: [{ name: "xmatrix-linux-x64", size: 42, digest: `sha256:${sha256}` }],
};

test("only old, non-current, byte-matched post-CD archives are prunable", () => {
  assert.equal(
    validatePrunableRelease({ objects, manifest, release, currentPrefixes: new Set(), now: Date.parse("2025-05-01") }),
    true
  );
  assert.equal(
    validatePrunableRelease({
      objects: objects.slice(1),
      manifest,
      release,
      currentPrefixes: new Set(),
      now: Date.parse("2025-05-01"),
    }),
    true
  );
});

test("current, unarchived, young, or mismatched releases are preserved", () => {
  const now = Date.parse("2025-05-01");
  assert.equal(validatePrunableRelease({ objects, manifest, release, currentPrefixes: new Set([prefix]), now }), false);
  assert.equal(
    validatePrunableRelease({
      objects,
      manifest,
      release: { ...release, body: "manual" },
      currentPrefixes: new Set(),
      now,
    }),
    false
  );
  assert.equal(
    validatePrunableRelease({
      objects: objects.map((object) => ({ ...object, last_modified: "2025-04-30T00:00:00Z" })),
      manifest,
      release,
      currentPrefixes: new Set(),
      now,
    }),
    false
  );
  assert.equal(
    validatePrunableRelease({
      objects,
      manifest,
      release: { ...release, assets: [{ ...release.assets[0], size: 41 }] },
      currentPrefixes: new Set(),
      now,
    }),
    false
  );
});

test("unpicked release part attempts are pruned with their release, but foreign objects are not", () => {
  const now = Date.parse("2025-05-01");
  const partKey = `${prefix}/parts/linux-x64/9-2/xmatrix-linux-x64`;
  const partManifest = { ...manifest, files: [{ ...manifest.files[0], key: partKey }] };
  const partObjects = [
    { key: partKey, last_modified: old },
    { key: `${prefix}/parts/linux-x64/9-2/xmatrix-r2-manifest.json`, last_modified: old },
    { key: `${prefix}/parts/linux-x64/9-1/xmatrix-linux-x64`, last_modified: old },
    { key: `${prefix}/xmatrix-r2-manifest.json`, last_modified: old },
  ];
  const prunable = (objects) =>
    validatePrunableRelease({ objects, manifest: partManifest, release, currentPrefixes: new Set(), now });
  assert.equal(prunable(partObjects), true);
  assert.equal(prunable([...partObjects, { key: `${prefix}/other/xmatrix-linux-x64`, last_modified: old }]), false);
});
