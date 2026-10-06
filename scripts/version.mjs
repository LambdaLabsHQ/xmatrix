#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  assertSemver,
  listReleaseTags,
  readVersionAtRef,
  validateReleaseVersionOrder,
} from "./release-version-order.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalVersionPath = "version.json";
const packageJsonPaths = [
  "packages/decision-model/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "packages/hub/package.json",
  "packages/protocol/package.json",
  "packages/db/package.json",
  "packages/mock-agent/package.json",
];
const cargoTomlPath = "packages/cli-rs/Cargo.toml";
const cargoLockPath = "packages/cli-rs/Cargo.lock";
// Only the binary carries the release version. The CLI's library crates stay
// at 0.0.0 so a bump leaves their build cache valid; they read the running
// version from xmatrix_cli_core::version.
const cargoLockPackageNames = ["xmatrix"];
const iosProjectPath = "apps/ios/xMatrix.xcodeproj/project.pbxproj";

/** Every file a version bump rewrites; nothing else carries the release version. */
export const versionedPaths = [
  canonicalVersionPath,
  "package.json",
  ...packageJsonPaths,
  cargoTomlPath,
  cargoLockPath,
  iosProjectPath,
];

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDir, relativePath), "utf8");
}

function writeText(relativePath, text) {
  fs.writeFileSync(path.join(rootDir, relativePath), text);
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

function writeJson(relativePath, value) {
  writeText(relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function canonicalVersion() {
  return readJson(canonicalVersionPath).version;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cargoLockPackageVersionPattern(packageName) {
  return new RegExp(
    `(\\[\\[package\\]\\]\\r?\\nname = "${escapeRegExp(packageName)}"\\r?\\nversion = )"(.*)"`,
    "m",
  );
}

function cargoLockPackageVersion(cargoLock, packageName) {
  return cargoLock.match(cargoLockPackageVersionPattern(packageName))?.[2];
}

function syncCargoLockPackageVersion(cargoLock, packageName, version) {
  const pattern = cargoLockPackageVersionPattern(packageName);
  if (!pattern.test(cargoLock)) {
    throw new Error(`Could not find ${packageName} in ${cargoLockPath}.`);
  }
  return cargoLock.replace(pattern, `$1"${version}"`);
}

/**
 * Pure: `text`, the contents of the versioned file `relativePath`, with only
 * its release-version fields set to `version`. Anything else that happens to
 * equal the version, such as a dependency's version, is left alone.
 */
export function stampVersionText(relativePath, text, version) {
  if ([canonicalVersionPath, "package.json", ...packageJsonPaths].includes(relativePath)) {
    return `${JSON.stringify({ ...JSON.parse(text), version }, null, 2)}\n`;
  }
  if (relativePath === cargoTomlPath) {
    return text.replace(/^version = ".*"$/m, `version = "${version}"`);
  }
  if (relativePath === cargoLockPath) {
    let cargoLock = text;
    for (const packageName of cargoLockPackageNames) {
      cargoLock = syncCargoLockPackageVersion(cargoLock, packageName, version);
    }
    return cargoLock;
  }
  if (relativePath === iosProjectPath) {
    return text.replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`);
  }
  throw new Error(`${relativePath} is not a versioned file.`);
}

function sync(version) {
  assertSemver(version);

  writeJson(canonicalVersionPath, { version });
  for (const relativePath of versionedPaths.filter((file) => file !== canonicalVersionPath)) {
    writeText(relativePath, stampVersionText(relativePath, readText(relativePath), version));
  }
}

function collectMismatches(expectedVersion) {
  const mismatches = [];

  for (const relativePath of ["package.json", ...packageJsonPaths]) {
    const actualVersion = readJson(relativePath).version;
    if (actualVersion !== expectedVersion) {
      mismatches.push(`${relativePath}: ${actualVersion || "(missing)"}`);
    }
  }

  const cargoTomlVersion = readText(cargoTomlPath).match(/^version = "(.*)"$/m)?.[1];
  if (cargoTomlVersion !== expectedVersion) {
    mismatches.push(`${cargoTomlPath}: ${cargoTomlVersion || "(missing)"}`);
  }

  const cargoLock = readText(cargoLockPath);
  for (const packageName of cargoLockPackageNames) {
    const cargoLockVersion = cargoLockPackageVersion(cargoLock, packageName);
    if (cargoLockVersion !== expectedVersion) {
      mismatches.push(`${cargoLockPath} ${packageName}: ${cargoLockVersion || "(missing)"}`);
    }
  }

  const iosVersions = [...readText(iosProjectPath).matchAll(/MARKETING_VERSION = ([^;]+);/g)].map(
    (match) => match[1],
  );
  for (const actualVersion of iosVersions) {
    if (actualVersion !== expectedVersion) {
      mismatches.push(`${iosProjectPath}: MARKETING_VERSION ${actualVersion}`);
    }
  }

  return mismatches;
}

function check() {
  const version = canonicalVersion();
  assertSemver(version);
  const mismatches = collectMismatches(version);
  if (mismatches.length > 0) {
    console.error(`Version mismatch. ${canonicalVersionPath} is ${version}:`);
    for (const mismatch of mismatches) {
      console.error(`- ${mismatch}`);
    }
    console.error("Run `pnpm version:sync` or `pnpm version:set <version>`.");
    process.exit(1);
  }
  console.log(`All manifests use xMatrix version ${version}.`);
}

function releaseOrderOptions(args) {
  let requestedBaseRef = process.env.XMATRIX_RELEASE_BASE_REF || null;
  let requireNewVersion = false;
  let mergedTagsOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--require-new-version") {
      requireNewVersion = true;
      continue;
    }
    if (arg === "--merged-tags-only") {
      mergedTagsOnly = true;
      continue;
    }
    if (arg === "--base-ref" && index + 1 < args.length) {
      requestedBaseRef = args[index + 1] || null;
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: node scripts/version.mjs check-release-order [--base-ref <git-ref>] [--require-new-version] [--merged-tags-only]",
    );
  }

  return { requestedBaseRef, requireNewVersion, mergedTagsOnly };
}

function checkReleaseOrder(args) {
  const version = canonicalVersion();
  const { requestedBaseRef, requireNewVersion, mergedTagsOnly } = releaseOrderOptions(args);
  const baseRef =
    requestedBaseRef && !/^0+$/.test(requestedBaseRef) ? requestedBaseRef : null;
  const baselineVersion = baseRef ? readVersionAtRef(rootDir, baseRef) : null;
  const { highestTag } = validateReleaseVersionOrder({
    currentVersion: version,
    baselineVersion,
    baselineLabel: baseRef ? `comparison ref ${baseRef}` : undefined,
    tagNames: listReleaseTags(rootDir, { mergedOnly: mergedTagsOnly }),
    requireNewVersion,
  });

  const comparisons = [];
  if (baselineVersion) comparisons.push(`comparison ref ${baselineVersion}`);
  if (highestTag) comparisons.push(`published tag ${highestTag.tag}`);
  console.log(
    comparisons.length > 0
      ? requireNewVersion && baselineVersion && version === baselineVersion
        ? `Release version ${version} matches comparison ref ${baselineVersion}; same-version retry is allowed until a release is published.`
        : requireNewVersion && baselineVersion
          ? `Release version ${version} is newer than comparison ref ${baselineVersion} and does not downgrade published tags.`
          : `Release version ${version} does not downgrade ${comparisons.join(" or ")}.`
      : `Release version ${version} is valid; no earlier release baseline was found.`,
  );
}

const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const [command, ...commandArgs] = invokedDirectly ? process.argv.slice(2) : [];

if (invokedDirectly) try {
  if (command === "check") {
    check();
  } else if (command === "sync") {
    sync(canonicalVersion());
    check();
  } else if (command === "set") {
    const [versionArg] = commandArgs;
    if (!versionArg) {
      throw new Error("Usage: pnpm version:set <version>");
    }
    sync(versionArg);
    check();
  } else if (command === "check-release-order") {
    checkReleaseOrder(commandArgs);
  } else {
    throw new Error(
      "Usage: node scripts/version.mjs <check|sync|set|check-release-order> [version|--base-ref <git-ref>|--require-new-version]",
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
