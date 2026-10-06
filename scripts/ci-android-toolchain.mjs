/**
 * Where the Android stage finds a JDK and an SDK when nothing points at them.
 *
 * Gradle needs `JAVA_HOME` and `ANDROID_HOME`. On a developer Mac both are
 * routinely unset even though both are installed, and the failure reads as if
 * neither is: Homebrew's `openjdk` is keg-only, so it is not on `PATH` and is
 * not registered under `/Library/Java/JavaVirtualMachines`, which leaves
 * `/usr/bin/java` -- a stub that only knows about registered runtimes --
 * answering "Unable to locate a Java Runtime". The Android SDK is likewise
 * installed into a user directory that nothing exports.
 *
 * CI runners export both, so this is a no-op there. It exists so that running
 * the full local suite does not require every developer to rediscover two
 * environment variables, in order, one failure at a time.
 *
 * Discovery only ever *fills a hole*: an explicitly set variable is never
 * overridden, because the person who set it knows something this file does
 * not. When nothing is found the variable stays unset and Gradle reports its
 * own error, which is the honest outcome -- a wrong guess here would fail
 * later and further from the cause.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * JDKs in the order a build should prefer them.
 *
 * Homebrew's versioned kegs come first because they are the ones that are
 * installed-but-invisible. Android Studio's bundled JBR is last: it is the
 * most likely to exist and the least likely to be what someone building from
 * a terminal intends.
 */
export function javaHomeCandidates(platform = process.platform, homeDir = os.homedir()) {
  if (platform === "darwin") {
    return [
      "/opt/homebrew/opt/openjdk@21",
      "/opt/homebrew/opt/openjdk@17",
      "/opt/homebrew/opt/openjdk",
      "/usr/local/opt/openjdk@21",
      "/usr/local/opt/openjdk@17",
      "/usr/local/opt/openjdk",
      "/Applications/Android Studio.app/Contents/jbr/Contents/Home",
      path.join(homeDir, "Applications/Android Studio.app/Contents/jbr/Contents/Home"),
    ];
  }
  if (platform === "linux") {
    return [
      "/usr/lib/jvm/java-21-openjdk-amd64",
      "/usr/lib/jvm/java-17-openjdk-amd64",
      "/opt/android-studio/jbr",
    ];
  }
  return [];
}

/** SDK roots in the order a build should prefer them. */
export function androidSdkCandidates(platform = process.platform, homeDir = os.homedir()) {
  const candidates = [path.join(homeDir, "Android", "Sdk")];
  if (platform === "darwin") {
    candidates.unshift(path.join(homeDir, "Library", "Android", "sdk"));
  }
  return candidates;
}

/** A JDK is one only if it can actually run something. */
function isUsableJavaHome(candidate, exists) {
  return exists(path.join(candidate, "bin", "java")) ||
    exists(path.join(candidate, "bin", "java.exe"));
}

/**
 * An SDK root needs both halves. A directory holding `platforms` alone is a
 * partial install -- this machine has one -- and pointing Gradle at it trades
 * a clear "SDK location not found" for a confusing missing-component error
 * later in the build.
 */
function isUsableAndroidSdk(candidate, exists) {
  return exists(path.join(candidate, "platforms")) &&
    exists(path.join(candidate, "platform-tools"));
}

function firstUsable(candidates, isUsable, exists) {
  return candidates.find((candidate) => exists(candidate) && isUsable(candidate, exists));
}

/**
 * The environment additions the Android stage needs, and nothing else.
 *
 * Returns only the variables it actually resolved, so the caller can spread it
 * over `process.env` without erasing anything.
 */
export function androidToolchainEnv({
  env = process.env,
  platform = process.platform,
  homeDir = os.homedir(),
  exists = fs.existsSync,
} = {}) {
  const toolchain = {};

  if (!env.JAVA_HOME) {
    const javaHome = firstUsable(
      javaHomeCandidates(platform, homeDir),
      isUsableJavaHome,
      exists,
    );
    if (javaHome) toolchain.JAVA_HOME = javaHome;
  }

  // `ANDROID_SDK_ROOT` is the deprecated spelling, but a machine that sets
  // only it is still a machine that has told us where the SDK is.
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT) {
    const sdk = firstUsable(
      androidSdkCandidates(platform, homeDir),
      isUsableAndroidSdk,
      exists,
    );
    if (sdk) toolchain.ANDROID_HOME = sdk;
  }

  return toolchain;
}
