#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { androidDir, androidVersion, newest, rootDir, walk } from "./android-common.mjs";

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function verifyAndroidReleaseChecksums(directory) {
  const stageDir = path.resolve(directory);
  const checksumsPath = path.join(stageDir, "checksums.txt");
  if (!fs.existsSync(checksumsPath)) {
    throw new Error(`Android release checksums missing: ${checksumsPath}`);
  }
  const lines = fs
    .readFileSync(checksumsPath, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Android release checksums empty: ${checksumsPath}`);
  }
  const seen = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) {
      throw new Error(`Android release checksums line is malformed: ${line}`);
    }
    const [, expected, name] = match;
    if (name.includes("/") || name.includes("\\") || name === "checksums.txt" || seen.has(name)) {
      throw new Error(`Android release checksums name is invalid: ${name}`);
    }
    seen.add(name);
    const filePath = path.join(stageDir, name);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Android release asset missing for checksums entry: ${name}`);
    }
    const actual = sha256(filePath);
    if (actual !== expected) {
      throw new Error(`Android release checksum mismatch for ${name}: ${actual} != ${expected}`);
    }
  }
  console.log(`Verified ${seen.size} Android release asset checksum(s) in ${stageDir}`);
  return [...seen];
}

function stageAndroidReleaseAssets() {
  const stageDir = path.resolve(process.env.ANDROID_RELEASE_STAGE_DIR || path.join(rootDir, "android-release-assets"));
  const outputsDir = path.join(androidDir, "app", "build", "outputs");
  const apk = newest(
    walk(outputsDir, (filePath) => {
      const normalized = filePath.split(path.sep).join("/");
      return normalized.includes("/apk/release/") && filePath.endsWith(".apk") && !filePath.endsWith("-unsigned.apk");
    }),
  );
  const aab = newest(
    walk(outputsDir, (filePath) => {
      const normalized = filePath.split(path.sep).join("/");
      return normalized.includes("/bundle/release/") && filePath.endsWith(".aab");
    }),
  );

  if (!apk) {
    throw new Error("Signed release APK not found under apps/android/app/build/outputs/apk/release.");
  }

  if (!aab) {
    throw new Error("Release AAB not found under apps/android/app/build/outputs/bundle/release.");
  }

  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  const assets = [
    { from: apk, name: `xMatrix-Android-${androidVersion}.apk` },
    { from: aab, name: `xMatrix-Android-${androidVersion}.aab` },
  ];

  for (const asset of assets) {
    fs.copyFileSync(asset.from, path.join(stageDir, asset.name));
  }

  const checksumLines = assets.map((asset) => {
    const filePath = path.join(stageDir, asset.name);
    return `${sha256(filePath)}  ${asset.name}`;
  });
  fs.writeFileSync(path.join(stageDir, "checksums.txt"), `${checksumLines.join("\n")}\n`);
  verifyAndroidReleaseChecksums(stageDir);

  const stagedAssets = [...assets.map((asset) => path.join(stageDir, asset.name)), path.join(stageDir, "checksums.txt")];

  console.log(`Staged Android release assets in ${stageDir}`);
  for (const asset of stagedAssets) {
    console.log(`- ${asset}`);
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `stage_dir=${stageDir}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `assets<<EOF\n${stagedAssets.join("\n")}\nEOF\n`);
  }
}

function runCli(argv) {
  if (argv.length > 0) throw new Error("Usage: node scripts/android-release-assets.mjs");
  stageAndroidReleaseAssets();
}

const invokedDirectly =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
