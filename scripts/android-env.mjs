#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const home = os.homedir();
const installIfMissing = process.argv.includes("--install");
const candidates = [
  process.env.ANDROID_HOME,
  process.env.ANDROID_SDK_ROOT,
  path.join(home, "AppData", "Local", "Android", "Sdk"),
  path.join(home, "Android", "Sdk"),
  "/opt/android-sdk",
  "/usr/local/lib/android/sdk",
].filter(Boolean);

const sdk = candidates.find(hasAndroid36) || (installIfMissing ? installAndroidSdk() : "");

if (!sdk) {
  console.error("Android SDK Platform 36 not found. Install it or set ANDROID_HOME/ANDROID_SDK_ROOT on the runner.");
  process.exit(1);
}

console.log(`Android SDK: ${sdk}`);

if (process.env.GITHUB_ENV) {
  fs.appendFileSync(process.env.GITHUB_ENV, `ANDROID_HOME=${sdk}\nANDROID_SDK_ROOT=${sdk}\n`);
}

if (process.env.GITHUB_PATH) {
  fs.appendFileSync(process.env.GITHUB_PATH, `${path.join(sdk, "platform-tools")}\n`);
  fs.appendFileSync(process.env.GITHUB_PATH, `${path.join(sdk, "cmdline-tools", "latest", "bin")}\n`);
}

function hasAndroid36(sdkRoot) {
  return fs.existsSync(path.join(sdkRoot, "platforms", "android-36", "android.jar"));
}

function installAndroidSdk() {
  const sdkRoot = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(home, "Android", "Sdk");
  fs.mkdirSync(sdkRoot, { recursive: true });

  const cmdlineToolsDir = path.join(sdkRoot, "cmdline-tools", "latest");
  if (!fs.existsSync(path.join(cmdlineToolsDir, "bin", sdkManagerName()))) {
    installCommandLineTools(sdkRoot, cmdlineToolsDir);
  }

  makeCommandLineToolsExecutable(cmdlineToolsDir);

  runSdkManager(sdkRoot, [
    "platform-tools",
    "platforms;android-36",
    "build-tools;36.1.0",
  ]);

  if (!hasAndroid36(sdkRoot)) {
    throw new Error(`Android SDK Platform 36 was not installed in ${sdkRoot}`);
  }

  return sdkRoot;
}

function installCommandLineTools(sdkRoot, cmdlineToolsDir) {
  const url = commandLineToolsUrl();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "xmatrix-android-sdk-"));
  const zipPath = path.join(tempRoot, "commandlinetools.zip");
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });

  console.log(`Downloading Android command line tools from ${url}`);
  const curl = spawnSync(
    "curl",
    [
      "-fsSL",
      "--retry", "5",
      "--retry-delay", "2",
      "--retry-all-errors",
      "--continue-at", "-",
      url,
      "-o", zipPath,
    ],
    { stdio: "inherit" },
  );
  if (curl.status !== 0) {
    throw new Error("Failed to download Android command line tools.");
  }

  const jar = spawnSync("jar", ["xf", zipPath], { cwd: extractDir, stdio: "inherit" });
  if (jar.status !== 0) {
    throw new Error("Failed to extract Android command line tools with jar.");
  }

  const extracted = path.join(extractDir, "cmdline-tools");
  if (!fs.existsSync(extracted)) {
    throw new Error("Android command line tools archive did not contain cmdline-tools.");
  }

  fs.rmSync(cmdlineToolsDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(cmdlineToolsDir), { recursive: true });
  fs.renameSync(extracted, cmdlineToolsDir);
  fs.rmSync(tempRoot, { recursive: true, force: true });

  console.log(`Installed Android command line tools in ${path.relative(sdkRoot, cmdlineToolsDir)}`);
}

function makeCommandLineToolsExecutable(cmdlineToolsDir) {
  if (process.platform === "win32") {
    return;
  }

  const binDir = path.join(cmdlineToolsDir, "bin");
  if (!fs.existsSync(binDir)) {
    return;
  }

  for (const entry of fs.readdirSync(binDir, { withFileTypes: true })) {
    if (entry.isFile()) {
      fs.chmodSync(path.join(binDir, entry.name), 0o755);
    }
  }
}

function runSdkManager(sdkRoot, packages) {
  const sdkManager = path.join(sdkRoot, "cmdline-tools", "latest", "bin", sdkManagerName());
  const sdkManagerArgs = [`--sdk_root=${sdkRoot}`, ...packages];
  const command = process.platform === "win32" ? "cmd.exe" : sdkManager;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", sdkManager, ...sdkManagerArgs] : sdkManagerArgs;
  console.log(`Installing Android SDK packages: ${packages.join(", ")}`);

  const childEnv = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };
  for (const name of [
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
    "http_proxy", "https_proxy", "all_proxy",
  ]) {
    if (typeof childEnv[name] === "string" && childEnv[name].trim() === "") {
      delete childEnv[name];
    }
  }

  const result = spawnSync(command, args, {
    env: childEnv,
    input: "y\ny\ny\ny\ny\ny\ny\ny\ny\ny\n",
    stdio: ["pipe", "inherit", "inherit"],
  });

  if (result.error) {
    throw new Error(`Failed to start sdkmanager: ${result.error.message}`);
  }

  if (result.signal) {
    throw new Error(`sdkmanager terminated by signal ${result.signal}`);
  }

  if (result.status !== 0) {
    throw new Error(`sdkmanager failed with exit code ${result.status}`);
  }
}

function sdkManagerName() {
  return process.platform === "win32" ? "sdkmanager.bat" : "sdkmanager";
}

function commandLineToolsUrl() {
  if (process.platform === "win32") {
    return "https://dl.google.com/android/repository/commandlinetools-win-12266719_latest.zip";
  }
  if (process.platform === "darwin") {
    return "https://dl.google.com/android/repository/commandlinetools-mac-12266719_latest.zip";
  }
  return "https://dl.google.com/android/repository/commandlinetools-linux-12266719_latest.zip";
}
