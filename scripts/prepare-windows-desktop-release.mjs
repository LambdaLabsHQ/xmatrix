#!/usr/bin/env node
import { mkdir, readdir, rename, rm, stat, writeFile, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { runCliMain } from "./cli-entrypoint.mjs";

import { digestFile } from "./file-digests.mjs";

async function moveFile(source, destination) {
  try {
    await rename(source, destination);
  } catch (error) {
    if (error?.code !== "EXDEV") throw error;
    await copyFile(source, destination);
    await unlink(source);
  }
}

function updaterManifest({ version, fileName, size, sha512, releaseDate }) {
  return [
    `version: ${version}`,
    "files:",
    `  - url: ${fileName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${fileName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ].join("\n");
}

export async function prepareWindowsDesktopRelease({ sourceDirectory, stageDirectory, version }) {
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(version)) {
    throw new Error(`Invalid desktop version: ${version}`);
  }

  const sourceRoot = path.resolve(sourceDirectory);
  const stageRoot = path.resolve(stageDirectory);
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  const installers = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".exe") && !entry.name.endsWith(".__uninstaller.exe"),
  );
  if (installers.length !== 1) {
    throw new Error(`Expected exactly one Windows installer in ${sourceRoot}; found ${installers.length}`);
  }

  const sourceInstaller = path.join(sourceRoot, installers[0].name);
  const sourceBlockmap = `${sourceInstaller}.blockmap`;
  await stat(sourceBlockmap);
  await rm(stageRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  const installerName = `xMatrix-${version}-x64.exe`;
  const blockmapName = `${installerName}.blockmap`;
  const installerPath = path.join(stageRoot, installerName);
  const blockmapPath = path.join(stageRoot, blockmapName);
  await moveFile(sourceInstaller, installerPath);
  await moveFile(sourceBlockmap, blockmapPath);

  const [installerMetadata, installerHashes] = await Promise.all([
    stat(installerPath),
    digestFile(installerPath, ["sha512"]),
  ]);
  const releaseDate = new Date().toISOString();
  const latestPath = path.join(stageRoot, "latest.yml");
  await writeFile(
    latestPath,
    updaterManifest({
      version,
      fileName: installerName,
      size: installerMetadata.size,
      sha512: installerHashes.sha512.toString("base64"),
      releaseDate,
    }),
  );
  return [installerName, blockmapName, "latest.yml"];
}

async function main(argv) {
  const [sourceDirectory, stageDirectory, version] = argv;
  if (!sourceDirectory || !stageDirectory || !version) {
    throw new Error(
      "Usage: node scripts/prepare-windows-desktop-release.mjs <source-directory> <stage-directory> <version>",
    );
  }
  const assets = await prepareWindowsDesktopRelease({ sourceDirectory, stageDirectory, version });
  process.stdout.write(`${JSON.stringify(assets)}\n`);
}

await runCliMain(import.meta.url, () => main(process.argv.slice(2)), { errorStack: true });
