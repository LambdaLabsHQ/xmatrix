import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  androidSdkCandidates,
  androidToolchainEnv,
  javaHomeCandidates,
} from "./ci-android-toolchain.mjs";

/**
 * The Android stage failed on a machine that had both a JDK and an SDK
 * installed. Homebrew's `openjdk` is keg-only, so `/usr/bin/java` -- which
 * only knows about registered runtimes -- reported "Unable to locate a Java
 * Runtime", and once that was fed in, an unset `ANDROID_HOME` surfaced behind
 * it. Discovery exists so that is one fixed step rather than two rediscovered
 * ones.
 */

const HOME = "/Users/example";

function fakeExists(present) {
  const set = new Set(present);
  return (candidate) => set.has(candidate);
}

/** Everything a usable JDK or SDK directory must contain, for one root. */
function jdkTree(root) {
  return [root, path.join(root, "bin", "java")];
}
function sdkTree(root) {
  return [root, path.join(root, "platforms"), path.join(root, "platform-tools")];
}

test("an installed but invisible Homebrew JDK is found", () => {
  const toolchain = androidToolchainEnv({
    env: {},
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists(jdkTree("/opt/homebrew/opt/openjdk@21")),
  });
  assert.equal(toolchain.JAVA_HOME, "/opt/homebrew/opt/openjdk@21");
});

test("an explicitly set JAVA_HOME is never second-guessed", () => {
  // Whoever exported it knows something this module does not.
  const toolchain = androidToolchainEnv({
    env: { JAVA_HOME: "/somewhere/deliberate" },
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists(jdkTree("/opt/homebrew/opt/openjdk@21")),
  });
  assert.equal(toolchain.JAVA_HOME, undefined);
});

test("a directory without a java binary is not a JDK", () => {
  const toolchain = androidToolchainEnv({
    env: {},
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists(["/opt/homebrew/opt/openjdk@21"]),
  });
  assert.equal(toolchain.JAVA_HOME, undefined);
});

test("a partial SDK is skipped in favour of a complete one", () => {
  // This machine has exactly this pair: `~/Library/Android/sdk` carries
  // `platforms` but no `platform-tools`, and is listed first. Pointing Gradle
  // at it trades a clear "SDK location not found" for a missing-component
  // error much later in the build.
  const toolchain = androidToolchainEnv({
    env: {},
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists([
      path.join(HOME, "Library/Android/sdk"),
      path.join(HOME, "Library/Android/sdk/platforms"),
      ...sdkTree(path.join(HOME, "Android/Sdk")),
    ]),
  });
  assert.equal(toolchain.ANDROID_HOME, path.join(HOME, "Android", "Sdk"));
});

test("the deprecated ANDROID_SDK_ROOT still counts as being told", () => {
  const toolchain = androidToolchainEnv({
    env: { ANDROID_SDK_ROOT: "/somewhere/deliberate" },
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists(sdkTree(path.join(HOME, "Android/Sdk"))),
  });
  assert.equal(toolchain.ANDROID_HOME, undefined);
});

test("finding nothing sets nothing, so Gradle reports its own error", () => {
  // A wrong guess would fail later and further from the cause than no guess.
  assert.deepEqual(
    androidToolchainEnv({
      env: {},
      platform: "darwin",
      homeDir: HOME,
      exists: () => false,
    }),
    {},
  );
});

test("discovery only ever adds, so spreading it cannot erase the environment", () => {
  const toolchain = androidToolchainEnv({
    env: { PATH: "/usr/bin" },
    platform: "darwin",
    homeDir: HOME,
    exists: fakeExists([
      ...jdkTree("/opt/homebrew/opt/openjdk@21"),
      ...sdkTree(path.join(HOME, "Android/Sdk")),
    ]),
  });
  assert.deepEqual(Object.keys(toolchain).sort(), ["ANDROID_HOME", "JAVA_HOME"]);
});

test("an unrecognised platform contributes no JDK guesses", () => {
  assert.deepEqual(javaHomeCandidates("win32", HOME), []);
  // The SDK path is the same on every platform, so it is still offered.
  assert.deepEqual(androidSdkCandidates("win32", HOME), [path.join(HOME, "Android", "Sdk")]);
});

test("called with no arguments it reads the real environment", () => {
  // The defaults are the code path CI actually runs; a suite that only ever
  // passes fakes proves the fakes agree with themselves.
  const toolchain = androidToolchainEnv();
  assert.equal(typeof toolchain, "object");
  for (const value of Object.values(toolchain)) assert.equal(typeof value, "string");
  if (process.env.JAVA_HOME) assert.equal(toolchain.JAVA_HOME, undefined);
  if (process.env.ANDROID_HOME) assert.equal(toolchain.ANDROID_HOME, undefined);
  assert.deepEqual(
    javaHomeCandidates(),
    javaHomeCandidates(process.platform, os.homedir()),
  );
});
