import { execFileSync } from "node:child_process";

const releaseTagPattern = /^(cli|desktop|android|xmatrix)-v(.+)$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(version) {
  const match = version.match(semverPattern);
  if (!match) {
    throw new Error(`Invalid version '${version}'. Expected semver like 1.2.3.`);
  }

  const prerelease = match[4]?.split(".") ?? [];
  for (const identifier of prerelease) {
    if (
      /^\d+$/.test(identifier) &&
      identifier.length > 1 &&
      identifier.startsWith("0")
    ) {
      throw new Error(
        `Invalid version '${version}'. Numeric prerelease identifiers must not have leading zeroes.`,
      );
    }
  }

  return {
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

export function assertSemver(version) {
  parseSemver(version);
}

export function compareSemver(left, right) {
  const parsedLeft = parseSemver(left);
  const parsedRight = parseSemver(right);

  for (let index = 0; index < parsedLeft.core.length; index += 1) {
    if (parsedLeft.core[index] < parsedRight.core[index]) return -1;
    if (parsedLeft.core[index] > parsedRight.core[index]) return 1;
  }

  if (parsedLeft.prerelease.length === 0 && parsedRight.prerelease.length === 0) return 0;
  if (parsedLeft.prerelease.length === 0) return 1;
  if (parsedRight.prerelease.length === 0) return -1;

  const identifierCount = Math.max(
    parsedLeft.prerelease.length,
    parsedRight.prerelease.length,
  );
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = parsedLeft.prerelease[index];
    const rightIdentifier = parsedRight.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;

    const leftIsNumeric = /^\d+$/.test(leftIdentifier);
    const rightIsNumeric = /^\d+$/.test(rightIdentifier);
    if (leftIsNumeric && rightIsNumeric) {
      return BigInt(leftIdentifier) < BigInt(rightIdentifier) ? -1 : 1;
    }
    if (leftIsNumeric) return -1;
    if (rightIsNumeric) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }

  return 0;
}

export function highestReleaseTag(tagNames) {
  let highest = null;
  for (const tag of tagNames) {
    const match = tag.match(releaseTagPattern);
    if (!match) continue;

    try {
      parseSemver(match[2]);
    } catch {
      continue;
    }

    if (!highest || compareSemver(match[2], highest.version) > 0) {
      highest = { tag, version: match[2] };
    }
  }
  return highest;
}

export function validateReleaseVersionOrder({
  currentVersion,
  baselineVersion,
  baselineLabel = "the comparison ref",
  tagNames = [],
  requireNewVersion = false,
}) {
  assertSemver(currentVersion);

  if (baselineVersion) {
    assertSemver(baselineVersion);
    const baselineComparison = compareSemver(currentVersion, baselineVersion);
    if (baselineComparison < 0) {
      throw new Error(
        `Release version downgrade detected: version.json is ${currentVersion}, ` +
          `but ${baselineLabel} uses ${baselineVersion}. ` +
          "Bump the release version before merging or publishing.",
      );
    }
    // requireNewVersion no longer demands a strict train bump on every release
    // workflow fire. Same version as the comparison ref is allowed so a failed
    // pre-publish attempt can retry; published releases stay immutable in the
    // GitHub publication policy. The flag remains for workflow compatibility.
    void requireNewVersion;
  }

  const highestTag = highestReleaseTag(tagNames);
  if (highestTag && compareSemver(currentVersion, highestTag.version) < 0) {
    throw new Error(
      `Release version downgrade detected: version.json is ${currentVersion}, ` +
        `but published tag ${highestTag.tag} is ${highestTag.version}. ` +
        "Bump the release version before merging or publishing.",
    );
  }

  return { highestTag };
}

function runGit(rootDir, args) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * Release tags, optionally only those in HEAD's history. Releases are cut as
 * release commits off main, so main's own version.json is only ever compared
 * with the releases it contains; a release request still compares against all.
 */
export function listReleaseTags(rootDir, { mergedOnly = false } = {}) {
  const output = runGit(rootDir, [
    "tag",
    ...(mergedOnly ? ["--merged", "HEAD"] : []),
    "--list",
    "cli-v*",
    "desktop-v*",
    "android-v*",
    "xmatrix-v*",
  ]);
  return output ? output.split(/\r?\n/) : [];
}

export function readVersionAtRef(rootDir, ref) {
  const commit = runGit(rootDir, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  if (!/^[0-9a-f]{40,64}$/i.test(commit)) {
    throw new Error(`Could not resolve comparison ref '${ref}' to a commit.`);
  }

  const versionJson = runGit(rootDir, ["show", `${commit}:version.json`]);
  const version = JSON.parse(versionJson).version;
  assertSemver(version);
  return version;
}
