import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  compareSemver,
  highestReleaseTag,
  RELEASE_TAG_PATTERN,
  releaseChannel,
  releaseCore,
  validateReleaseVersionOrder,
} from "./release-version-order.mjs";

test("semantic versions use SemVer precedence", () => {
  assert.equal(compareSemver("0.11.42", "0.11.41"), 1);
  assert.equal(compareSemver("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareSemver("1.0.0", "1.0.0-rc.10"), 1);
  assert.equal(compareSemver("1.0.0+build.2", "1.0.0+build.1"), 0);
});

test("the version alone says the channel: X.Y.Z is stable, X.Y.Z-beta.N a beta of it", () => {
  assert.equal(releaseChannel("1.0.606"), "stable");
  assert.equal(releaseChannel("1.0.606-beta.12"), "beta");
  assert.equal(releaseCore("1.0.606-beta.12"), "1.0.606");
  assert.equal(releaseCore("1.0.606"), "1.0.606");
  for (const version of ["1.0.606-rc.1", "1.0.606-beta.0", "1.0.606-beta.01", "1.0.606-beta", "1.0.606+build",
    "1.0.606-beta.1+build", "01.0.606", "1.0", "", undefined]) {
    assert.throws(() => releaseChannel(version), /Expected X\.Y\.Z \(stable\) or X\.Y\.Z-beta\.N \(beta\)/u, String(version));
  }
  assert.ok(RELEASE_TAG_PATTERN.test("xmatrix-v1.0.606-beta.3") && RELEASE_TAG_PATTERN.test("xmatrix-v1.0.606"));
  assert.ok(!RELEASE_TAG_PATTERN.test("cli-v1.0.606") && !RELEASE_TAG_PATTERN.test("xmatrix-v1.0.606-rc.1"));
  // Betas and stables share one ascending line.
  assert.equal(compareSemver("1.0.606-beta.10", "1.0.606-beta.9"), 1);
  assert.equal(compareSemver("1.0.606", "1.0.606-beta.10"), 1);
  assert.equal(compareSemver("1.0.607-beta.1", "1.0.606"), 1);
});

test("the highest published product tag establishes the release floor", () => {
  assert.deepEqual(
    highestReleaseTag([
      "desktop-dev",
      "desktop-v0.11.41",
      "android-v0.11.42",
      "cli-v0.11.40",
      "xmatrix-v0.11.43",
      "unrelated-v9.0.0",
    ]),
    { tag: "xmatrix-v0.11.43", version: "0.11.43" },
  );

  assert.throws(
    () =>
      validateReleaseVersionOrder({
        currentVersion: "0.11.41",
        tagNames: ["cli-v0.11.42"],
      }),
    /published tag cli-v0\.11\.42 is 0\.11\.42/,
  );
});

test("the comparison ref prevents an unreleased main-branch downgrade", () => {
  assert.throws(
    () =>
      validateReleaseVersionOrder({
        currentVersion: "0.11.41",
        baselineVersion: "0.11.42",
        baselineLabel: "main",
      }),
    /but main uses 0\.11\.42/,
  );

  assert.doesNotThrow(() =>
    validateReleaseVersionOrder({
      currentVersion: "0.11.42",
      baselineVersion: "0.11.42",
      tagNames: ["desktop-v0.11.42"],
    }),
  );

  // Same train as the comparison ref is allowed: failed pre-publish runs must
  // be able to retry without burning another version.json bump.
  assert.doesNotThrow(() =>
    validateReleaseVersionOrder({
      currentVersion: "0.11.42",
      baselineVersion: "0.11.42",
      baselineLabel: "main",
      requireNewVersion: true,
    }),
  );

  assert.doesNotThrow(() =>
    validateReleaseVersionOrder({
      currentVersion: "0.11.43",
      baselineVersion: "0.11.42",
      requireNewVersion: true,
      tagNames: ["cli-v0.11.43"],
    }),
  );
});

test("only the CLI binary carries the release version; its library crates stay 0.0.0", () => {
  const cargoLock = fs.readFileSync(
    new URL("../packages/cli-rs/Cargo.lock", import.meta.url),
    "utf8",
  );
  // A library crate carrying the release version would be rebuilt by every
  // bump; the binary registers the version at startup instead.
  const libraries = [
    ...cargoLock.matchAll(/\[\[package\]\]\r?\nname = "(xmatrix-[^"]+)"\r?\nversion = "([^"]+)"/g),
  ];
  assert.ok(libraries.length > 5);
  for (const [, name, version] of libraries) assert.equal(version, "0.0.0", name);
  const manifest = fs.readFileSync(new URL("../packages/cli-rs/Cargo.toml", import.meta.url), "utf8");
  assert.doesNotMatch(manifest, /^\[workspace\.package\][^[]*^version/mu);
});
