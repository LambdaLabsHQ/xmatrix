#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { androidDir, androidVersion, rootDir, splitTasks, walk } from "./android-common.mjs";

const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
const validationTasks = [
  ":app:testDebugUnitTest",
  ":app:lintDebug",
  ...splitTasks(process.env.ANDROID_ADDITIONAL_TEST_TASKS || ""),
];
const buildTasks = splitTasks(process.env.ANDROID_BUILD_TASK || ":app:assembleRelease :app:bundleRelease");
const deployTask = process.env.SKIP_ANDROID_DEPLOY === "1" ? "" : process.env.ANDROID_DEPLOY_TASK || "";
const versionName = androidVersion;
const versionCode = process.env.ANDROID_VERSION_CODE || buildVersionCode();

function buildVersionCode() {
  if (process.env.GITHUB_RUN_NUMBER) {
    return process.env.GITHUB_RUN_NUMBER;
  }
  return new Date().toISOString().replace(/\D/g, "").slice(0, 10);
}

function resolveAndroidSdk() {
  if (process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT) {
    return;
  }

  const home = os.homedir();
  const candidates = [
    path.join(home, "AppData", "Local", "Android", "Sdk"),
    path.join(home, "Android", "Sdk"),
    "/opt/android-sdk",
    "/usr/local/lib/android/sdk",
  ];
  const sdk = candidates.find((item) => fs.existsSync(path.join(item, "platforms", "android-36", "android.jar")));

  if (!sdk) {
    return;
  }

  process.env.ANDROID_HOME = sdk;
  process.env.ANDROID_SDK_ROOT = sdk;
}

function requireAndroidProject() {
  if (!fs.existsSync(androidDir)) {
    throw new Error(`Android project directory not found: ${path.relative(rootDir, androidDir)}`);
  }

  const wrapper = path.join(androidDir, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(wrapper)) {
    throw new Error(`Gradle wrapper not found: ${path.relative(rootDir, wrapper)}`);
  }

  if (process.platform !== "win32") {
    fs.chmodSync(wrapper, 0o755);
  }

  return wrapper;
}

function writeBase64File(name, value, mode = 0o600) {
  if (!value) {
    return "";
  }

  const outputPath = path.join(runnerTemp, name);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, Buffer.from(value, "base64"), { mode });
  return outputPath;
}

function pushIfDefined(args, name, value) {
  if (value) {
    args.push(`-P${name}=${value}`);
  }
}

function gradleArgs(task) {
  const args = [task, "--stacktrace"];

  pushIfDefined(args, "xmatrixVersionName", versionName);
  pushIfDefined(args, "xmatrixVersionCode", versionCode);
  pushIfDefined(args, "versionName", versionName);
  pushIfDefined(args, "versionCode", versionCode);
  pushIfDefined(args, "track", process.env.ANDROID_PLAY_TRACK || "internal");

  const keystorePath =
    process.env.ANDROID_KEYSTORE_FILE ||
    writeBase64File("xmatrix-android-release.jks", process.env.ANDROID_KEYSTORE_BASE64);
  pushIfDefined(args, "android.injected.signing.store.file", keystorePath);
  pushIfDefined(args, "android.injected.signing.store.password", process.env.ANDROID_KEYSTORE_PASSWORD);
  pushIfDefined(args, "android.injected.signing.key.alias", process.env.ANDROID_KEY_ALIAS);
  pushIfDefined(args, "android.injected.signing.key.password", process.env.ANDROID_KEY_PASSWORD);

  const serviceAccountPath =
    process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON ||
    writeBase64File("google-play-service-account.json", process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON_BASE64);
  if (serviceAccountPath) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
    pushIfDefined(args, "play.serviceAccountCredentials", serviceAccountPath);
  }

  if (process.env.ANDROID_GRADLE_ARGS) {
    args.push(...process.env.ANDROID_GRADLE_ARGS.split(/\s+/).filter(Boolean));
  }

  return args;
}

function runGradle(wrapper, task) {
  const args = gradleArgs(task);
  console.log(`Running ${path.basename(wrapper)} ${redactedArgs(args).join(" ")}`);

  const command = process.platform === "win32" ? "cmd.exe" : wrapper;
  const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", wrapper, ...args] : args;
  const result = spawnSync(command, commandArgs, {
    cwd: androidDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Failed to start Gradle wrapper: ${result.error.message}`);
  }

  if (result.signal) {
    throw new Error(`Gradle wrapper terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function bundleWebAssets() {
  if (process.env.SKIP_ANDROID_WEB_BUNDLE === "1") {
    console.log("Android packaged web bundle skipped; set SKIP_ANDROID_WEB_BUNDLE=0 to include it.");
    return;
  }

  const script = path.join(rootDir, "scripts", "android-bundle-web.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Failed to start Android web bundler: ${result.error.message}`);
  }

  if (result.signal) {
    throw new Error(`Android web bundler terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function redactedArgs(args) {
  return args.map((arg) => {
    if (/android\.injected\.signing\.(store\.password|key\.password)=/.test(arg)) {
      return arg.replace(/=.*/, "=***");
    }
    if (/play\.serviceAccountCredentials=/.test(arg)) {
      return arg.replace(/=.*/, "=***");
    }
    return arg;
  });
}

function findArtifacts() {
  return walk(androidDir, (filePath, entry) => {
    return filePath.includes(`${path.sep}build${path.sep}outputs${path.sep}`) && /\.(aab|apk)$/i.test(entry.name);
  }).map((filePath) => path.relative(rootDir, filePath));
}

try {
  resolveAndroidSdk();
  const wrapper = requireAndroidProject();

  for (const validationTask of validationTasks) {
    runGradle(wrapper, validationTask);
  }
  bundleWebAssets();
  for (const buildTask of buildTasks) {
    runGradle(wrapper, buildTask);
  }
  if (deployTask) {
    runGradle(wrapper, deployTask);
  } else {
    console.log("Android Play deployment skipped; set ANDROID_DEPLOY_TASK and leave SKIP_ANDROID_DEPLOY unset.");
  }

  const artifacts = findArtifacts();
  if (artifacts.length > 0) {
    console.log("Android artifacts:");
    for (const artifact of artifacts) {
      console.log(`- ${artifact}`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
