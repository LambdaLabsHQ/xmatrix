import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createReleaseAssetHandoff,
  verifyReleaseAssetHandoff,
} from "./release-asset-handoff.mjs";

// The production Web build crosses from the build job to the deploy job as one
// archive of the OpenNext output plus the exact commit it was built from.
export const WEB_HANDOFF_MANIFEST = "web-release-bundle.json";
export const WEB_HANDOFF_ARCHIVE = "xmatrix-web-open-next.tar.gz";
export const WEB_HANDOFF_IDENTITY = "web-build-identity.json";
const WEB_HANDOFF_ASSETS = [WEB_HANDOFF_ARCHIVE, WEB_HANDOFF_IDENTITY];
const OPEN_NEXT_DIRECTORY = ".open-next";
const handoffOptions = { manifestName: WEB_HANDOFF_MANIFEST, label: "Web" };

function assertDeploySha(deploySha) {
  if (!/^[0-9a-f]{40}$/u.test(deploySha ?? "")) {
    throw new Error(`Web handoff requires an exact 40-character commit, got ${JSON.stringify(deploySha)}`);
  }
}

export async function createWebReleaseHandoff(directory, webDirectory, deploySha) {
  assertDeploySha(deploySha);
  if (!existsSync(path.join(webDirectory, OPEN_NEXT_DIRECTORY, "worker.js"))) {
    throw new Error(`No OpenNext build output under ${webDirectory}`);
  }
  await mkdir(directory, { recursive: true });
  execFileSync("tar", [
    "-C", webDirectory,
    "-czf", path.join(directory, WEB_HANDOFF_ARCHIVE),
    OPEN_NEXT_DIRECTORY,
  ], { stdio: "inherit" });
  await writeFile(
    path.join(directory, WEB_HANDOFF_IDENTITY),
    `${JSON.stringify({ schema: 1, deploySha })}\n`,
  );
  return createReleaseAssetHandoff(directory, WEB_HANDOFF_ASSETS, handoffOptions);
}

export async function restoreWebReleaseHandoff(directory, webDirectory, deploySha) {
  assertDeploySha(deploySha);
  await verifyReleaseAssetHandoff(directory, WEB_HANDOFF_ASSETS, handoffOptions);
  const identity = JSON.parse(await readFile(path.join(directory, WEB_HANDOFF_IDENTITY), "utf8"));
  if (identity?.schema !== 1 || identity.deploySha !== deploySha) {
    throw new Error(`Web handoff was built from ${identity?.deploySha}, not ${deploySha}`);
  }
  if (existsSync(path.join(webDirectory, OPEN_NEXT_DIRECTORY))) {
    throw new Error(`Refusing to restore over an existing ${OPEN_NEXT_DIRECTORY} in ${webDirectory}`);
  }
  const archive = path.join(directory, WEB_HANDOFF_ARCHIVE);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  const outside = entries.find((entry) =>
    entry !== OPEN_NEXT_DIRECTORY
    && entry !== `${OPEN_NEXT_DIRECTORY}/`
    && (!entry.startsWith(`${OPEN_NEXT_DIRECTORY}/`) || entry.split("/").includes("..")));
  if (outside !== undefined) throw new Error(`Web handoff archive has an entry outside ${OPEN_NEXT_DIRECTORY}: ${outside}`);
  execFileSync("tar", ["-C", webDirectory, "--no-same-owner", "-xzf", archive], { stdio: "inherit" });
  if (!existsSync(path.join(webDirectory, OPEN_NEXT_DIRECTORY, "worker.js"))) {
    throw new Error("Restored Web handoff has no OpenNext worker");
  }
}

const commands = { create: createWebReleaseHandoff, restore: restoreWebReleaseHandoff };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, directory, webDirectory, deploySha] = process.argv.slice(2);
  try {
    if (!Object.hasOwn(commands, command)) {
      throw new Error("Usage: node scripts/web-release-handoff.mjs <create|restore> <handoff-directory> <web-directory> <deploy-sha>");
    }
    await commands[command](directory, webDirectory, deploySha);
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}
