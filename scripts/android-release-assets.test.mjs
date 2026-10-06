import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";

import { verifyAndroidReleaseChecksums } from "./android-release-assets.mjs";

function writeAsset(directory, name, contents) {
  const filePath = path.join(directory, name);
  writeFileSync(filePath, contents);
  return createHash("sha256").update(contents).digest("hex");
}

test("verifyAndroidReleaseChecksums accepts matching staged assets", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "android-release-verify-"));
  const apkDigest = writeAsset(directory, "xMatrix-Android-0.16.279.apk", "apk-bytes");
  const aabDigest = writeAsset(directory, "xMatrix-Android-0.16.279.aab", "aab-bytes");
  writeFileSync(
    path.join(directory, "checksums.txt"),
    `${apkDigest}  xMatrix-Android-0.16.279.apk\n${aabDigest}  xMatrix-Android-0.16.279.aab\n`,
  );
  assert.deepEqual(verifyAndroidReleaseChecksums(directory), [
    "xMatrix-Android-0.16.279.apk",
    "xMatrix-Android-0.16.279.aab",
  ]);
});

test("verifyAndroidReleaseChecksums rejects a digest that does not match the sibling file", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "android-release-verify-bad-"));
  writeAsset(directory, "xMatrix-Android-0.16.279.apk", "apk-bytes");
  writeFileSync(
    path.join(directory, "checksums.txt"),
    `${"0".repeat(64)}  xMatrix-Android-0.16.279.apk\n`,
  );
  assert.throws(
    () => verifyAndroidReleaseChecksums(directory),
    /checksum mismatch for xMatrix-Android-0\.16\.279\.apk/u,
  );
});

test("verifyAndroidReleaseChecksums rejects a missing sibling named by checksums.txt", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "android-release-verify-missing-"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "checksums.txt"),
    `${"a".repeat(64)}  xMatrix-Android-0.16.279.apk\n`,
  );
  assert.throws(
    () => verifyAndroidReleaseChecksums(directory),
    /asset missing for checksums entry: xMatrix-Android-0\.16\.279\.apk/u,
  );
});
