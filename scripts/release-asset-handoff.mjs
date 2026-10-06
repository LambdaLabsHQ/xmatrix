import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { digestFile } from "./file-digests.mjs";

function assertAssetName(name) {
  if (
    typeof name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) ||
    name === "." ||
    name === ".." ||
    path.basename(name) !== name
  ) {
    throw new Error(`Invalid handoff asset name: ${String(name)}`);
  }
}

function assertExpectedAssetNames(assetNames) {
  if (!Array.isArray(assetNames) || assetNames.length === 0) {
    throw new Error("Expected at least one handoff asset name");
  }

  const unique = new Set();
  for (const name of assetNames) {
    assertAssetName(name);
    if (unique.has(name)) throw new Error(`Duplicate handoff asset name: ${name}`);
    unique.add(name);
  }
}

function assertHandoffContract(assetNames, manifestName) {
  assertExpectedAssetNames(assetNames);
  assertAssetName(manifestName);
  if (assetNames.includes(manifestName)) {
    throw new Error(`Handoff manifest name conflicts with an asset: ${manifestName}`);
  }
}

function assetPath(directory, name) {
  const root = path.resolve(directory);
  const candidate = path.resolve(root, name);
  if (path.dirname(candidate) !== root) {
    throw new Error(`Handoff asset escapes its directory: ${name}`);
  }
  return candidate;
}

function assertExactKeys(value, keys, context) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${context} has unexpected fields`);
  }
}

async function sha256(filePath) {
  return (await digestFile(filePath, ["sha256"])).sha256.toString("hex");
}

async function assertRegularFile(filePath, context) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`${context} must be a regular file`);
  }
  return metadata;
}

async function assertExactDirectoryContents(directory, expectedNames, label) {
  const entries = await readdir(directory, { withFileTypes: true });
  const actualNames = entries.map((entry) => entry.name).sort();
  const expected = [...expectedNames].sort();
  if (actualNames.length !== expected.length || actualNames.some((name, index) => name !== expected[index])) {
    throw new Error(
      `Unexpected ${label} handoff contents: expected ${expected.join(", ")}; found ${actualNames.join(", ")}`,
    );
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${label} handoff entry must be a regular file: ${entry.name}`);
    }
  }
}

async function buildManifest(directory, assetNames, label) {
  const assets = [];
  for (const name of assetNames) {
    const filePath = assetPath(directory, name);
    const metadata = await assertRegularFile(filePath, `${label} handoff asset ${name}`);
    if (metadata.size <= 0) throw new Error(`${label} handoff asset is empty: ${name}`);
    assets.push({
      name,
      size: metadata.size,
      sha256: await sha256(filePath),
    });
  }
  return { schema: 1, assets };
}

export async function createReleaseAssetHandoff(
  directory,
  assetNames,
  { manifestName, label = "Release" },
) {
  assertHandoffContract(assetNames, manifestName);
  const root = path.resolve(directory);
  await mkdir(root, { recursive: true });
  await assertExactDirectoryContents(root, assetNames, label);
  const manifest = await buildManifest(root, assetNames, label);
  const manifestPath = assetPath(root, manifestName);
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  await rm(temporaryPath, { force: true });
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, manifestPath);
  return manifest;
}

export async function verifyReleaseAssetHandoff(
  directory,
  assetNames,
  { manifestName, label = "Release" },
) {
  assertHandoffContract(assetNames, manifestName);
  const root = path.resolve(directory);
  await assertExactDirectoryContents(root, [...assetNames, manifestName], label);

  const manifestPath = assetPath(root, manifestName);
  await assertRegularFile(manifestPath, `${label} handoff manifest`);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`${label} handoff manifest is not valid JSON: ${error.message}`);
  }

  assertExactKeys(manifest, ["schema", "assets"], `${label} handoff manifest`);
  if (manifest.schema !== 1 || !Array.isArray(manifest.assets) || manifest.assets.length !== assetNames.length) {
    throw new Error(`${label} handoff manifest has an invalid schema or asset count`);
  }

  for (const [index, expectedName] of assetNames.entries()) {
    const expected = manifest.assets[index];
    assertExactKeys(expected, ["name", "size", "sha256"], `${label} handoff manifest asset ${index}`);
    if (
      expected.name !== expectedName ||
      !Number.isSafeInteger(expected.size) ||
      expected.size <= 0 ||
      typeof expected.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(expected.sha256)
    ) {
      throw new Error(`${label} handoff manifest asset ${index} is invalid`);
    }

    const filePath = assetPath(root, expectedName);
    const metadata = await assertRegularFile(filePath, `${label} handoff asset ${expectedName}`);
    if (metadata.size !== expected.size) {
      throw new Error(`${label} handoff asset size mismatch: ${expectedName}`);
    }
    if ((await sha256(filePath)) !== expected.sha256) {
      throw new Error(`${label} handoff asset SHA-256 mismatch: ${expectedName}`);
    }
  }

  return manifest;
}
