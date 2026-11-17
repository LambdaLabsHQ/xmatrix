#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { argumentValue, argumentValues, runCliMain } from "./cli-entrypoint.mjs";
import { assertSecretPolicy, SECRET_POLICIES } from "./wrangler-secret-policy.mjs";

/** Gradual part of a release the new Hub serves before it takes all traffic. */
export const DEFAULT_CANARY_PERCENT = 10;
/** Traffic stays split this long before production promotes the new version. */
export const DEFAULT_HOLD_SECONDS = 180;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRANSIENT_FAILURE = /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|ENETUNREACH|socket hang up|fetch failed|Response code (?:408|429|5\d\d)|network/iu;

function fail(message) {
  throw new Error(`[hub-canary] ${message}`);
}

/** The previous deployment is a safe rollback base only when it serves one version at 100%. */
export function previousDeploymentVersion(status) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  if (versions.length !== 1) return null;
  const [version] = versions;
  if (typeof version?.version_id !== "string" || version.version_id.length === 0) return null;
  if (Number(version.percentage) !== 100) return null;
  return version.version_id;
}

/**
 * The version this release uploaded, found by the immutable tag it carries.
 * A retried job can upload the same tag twice; the newest one is the release.
 */
export function versionIdForTag(versions, tag) {
  const matches = (Array.isArray(versions) ? versions : [])
    .filter((version) => version?.annotations?.["workers/tag"] === tag && typeof version?.id === "string" && version.id.length > 0)
    .sort((left, right) => String(left.metadata?.created_on ?? "").localeCompare(String(right.metadata?.created_on ?? "")));
  if (matches.length === 0) return null;
  return matches.at(-1).id;
}

/**
 * A Durable Object class lifecycle change cannot be uploaded as a version or
 * rolled back across, so that release deploys in one step without a canary.
 */
export function isDurableObjectLifecycleRefusal(text) {
  return /durable object|migration|10211/iu.test(text ?? "");
}

/** Secret names a Worker version carries, as `wrangler versions view --json` reports them. */
export function secretNamesOfVersion(version) {
  const bindings = version?.resources?.bindings;
  if (!Array.isArray(bindings)) fail("uploaded Hub version has no bindings to verify");
  return bindings
    .filter((binding) => binding?.type === "secret_text" && typeof binding.name === "string" && binding.name.length > 0)
    .map((binding) => binding.name);
}

/**
 * The uploaded version must carry every secret this release selected before
 * any traffic reaches it. The Worker-level check after deploy is too late: a
 * version missing a secret would already serve 10% and then 100%.
 */
export function assertVersionSecrets(version, expectedNames) {
  if (!Array.isArray(expectedNames) || expectedNames.some((name) => typeof name !== "string" || !name)) {
    fail("expected secret names must be a list of names");
  }
  const policy = SECRET_POLICIES["production-hub"];
  assertSecretPolicy(secretNamesOfVersion(version), {
    ...policy,
    required: [...policy.required, ...expectedNames],
  });
}

export function trafficArguments(versionId, previousVersionId, percent) {
  if (!previousVersionId) return ["--version-id", versionId, "--percentage", "100"];
  return [
    "--version-id", versionId, "--percentage", String(percent),
    "--version-id", previousVersionId, "--percentage", String(100 - percent),
  ];
}

function assertPercent(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 50) {
    fail("canary percent must be an integer between 1 and 50");
  }
  return value;
}

function assertHoldMs(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 900_000) {
    fail("hold milliseconds must be an integer between 0 and 900000");
  }
  return value;
}

async function runWithRetry(run, args, attempts, sleep) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(args);
    } catch (error) {
      const detail = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
      if (attempt >= attempts || !TRANSIENT_FAILURE.test(detail)) throw error;
      await sleep(5_000 * attempt);
    }
  }
}

/**
 * Deploy one immutable Hub release with a gradual window and automatic code
 * rollback. Schema never rolls back: the release train only applies expand
 * migrations before this job, and contract migrations ship separately after
 * the new Hub is proven.
 */
export async function deployWithCanary({
  run,
  health,
  sleep,
  log = (line) => console.log(line),
  workerName = "xmatrix-hub",
  tag,
  config,
  secretsFile,
  outdir,
  url,
  defines = [],
  expectedSecretNames = [],
  canaryPercent = DEFAULT_CANARY_PERCENT,
  holdMs = DEFAULT_HOLD_SECONDS * 1000,
  uploadAttempts = 3,
  deployAttempts = 3,
}) {
  if (typeof tag !== "string" || !/^[0-9a-f]{40}$/u.test(tag)) fail("tag must be the release commit's full Git SHA");
  const missing = Object.entries({ config, secretsFile, outdir, url }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) fail(`missing required ${missing.join(", ")}`);
  assertPercent(canaryPercent);
  assertHoldMs(holdMs);

  const defineArgs = defines.flatMap((define) => ["--define", define]);
  const workerArgs = ["--config", config, "--name", workerName];
  const uploadArgs = [
    "versions", "upload", "--config", config, "--tag", tag,
    "--secrets-file", secretsFile, "--outdir", outdir, ...defineArgs,
  ];
  const plainDeployArgs = [
    "deploy", "--config", config, "--secrets-file", secretsFile,
    "--tag", tag, "--outdir", outdir, ...defineArgs,
  ];

  const status = await run(["deployments", "status", ...workerArgs, "--json"]).catch((error) => {
    // A Worker that has never been deployed has no rollback base yet.
    if (/no deployments|not found/iu.test(`${error?.stderr ?? ""}\n${error?.message ?? ""}`)) return null;
    throw error;
  });
  const previousVersionId = status ? previousDeploymentVersion(JSON.parse(status.stdout)) : null;

  let versionId;
  try {
    await runWithRetry(run, uploadArgs, uploadAttempts, sleep);
    for (let attempt = 1; attempt <= 3 && versionId === undefined; attempt += 1) {
      const versions = JSON.parse((await run(["versions", "list", ...workerArgs, "--json"])).stdout);
      versionId = versionIdForTag(versions, tag) ?? undefined;
      if (versionId === undefined && attempt < 3) await sleep(2_000);
    }
    if (versionId === undefined) fail(`uploaded version tagged ${tag} was not found`);
  } catch (error) {
    if (!isDurableObjectLifecycleRefusal(`${error?.stderr ?? ""}\n${error?.message ?? ""}`)) throw error;
    log("[hub-canary] versioned upload refused by a Durable Object lifecycle change; deploying once without a canary");
    await runWithRetry(run, plainDeployArgs, deployAttempts, sleep);
    await health({ expectedSha: tag });
    return { mode: "single", reason: "durable-object-lifecycle" };
  }

  // Prove the version itself carries the selected secrets before the first
  // byte of traffic reaches it. No deployment has happened yet, so a failure
  // here leaves the running version untouched.
  const version = JSON.parse((await run(["versions", "view", versionId, ...workerArgs, "--json"])).stdout);
  assertVersionSecrets(version, expectedSecretNames);
  log(`[hub-canary] uploaded version carries the ${expectedSecretNames.length} selected secret name(s)`);

  if (!previousVersionId) {
    await runWithRetry(run, [
      "versions", "deploy", ...workerArgs,
      ...trafficArguments(versionId, null, canaryPercent),
      "--yes", "--message", `release ${tag}`,
    ], deployAttempts, sleep);
    await health({ expectedSha: tag });
    return { mode: "single", reason: "no-previous-deployment", versionId };
  }

  const rollBack = async (cause) => {
    let rolledBack = false;
    try {
      await run([
        "versions", "deploy", ...workerArgs,
        "--version-id", previousVersionId, "--percentage", "100",
        "--yes", "--message", `automatic rollback from ${tag}`,
      ]);
      rolledBack = true;
      log(`[hub-canary] rolled ${workerName} back to ${previousVersionId} at 100%`);
    } catch (error) {
      log(`[hub-canary] rollback to ${previousVersionId} failed: ${error.message}`);
    }
    throw new Error(`Hub canary ${tag} failed: ${cause}${rolledBack ? `; rolled back to ${previousVersionId}` : "; rollback did not complete"}`);
  };

  try {
    await runWithRetry(run, [
      "versions", "deploy", ...workerArgs,
      ...trafficArguments(versionId, previousVersionId, canaryPercent),
      "--yes", "--message", `canary ${tag} at ${canaryPercent}%`,
    ], deployAttempts, sleep);
  } catch (error) {
    return rollBack(`split deployment failed: ${error.message}`);
  }

  try {
    await health({ expectedSha: tag, versionOverride: `${workerName}="${versionId}"` });
    await sleep(holdMs);
    await health({ expectedSha: tag, versionOverride: `${workerName}="${versionId}"` });
  } catch (error) {
    return rollBack(`canary verification failed: ${error.message}`);
  }

  try {
    await runWithRetry(run, [
      "versions", "deploy", ...workerArgs,
      "--version-id", versionId, "--percentage", "100",
      "--yes", "--message", `release ${tag}`,
    ], deployAttempts, sleep);
  } catch (error) {
    return rollBack(`promotion failed: ${error.message}`);
  }

  try {
    await health({ expectedSha: tag });
  } catch (error) {
    return rollBack(`post-promotion verification failed: ${error.message}`);
  }
  return { mode: "canary", previousVersionId, versionId, canaryPercent, holdMs };
}

export function createWranglerRunner({ cwd = process.cwd(), exec = spawnSync } = {}) {
  return async (args) => {
    const result = exec("pnpm", ["exec", "wrangler", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? "");
      const error = new Error(`wrangler ${args.slice(0, 2).join(" ")} failed (${result.status}): ${stderr.trim().slice(0, 4000)}`);
      error.stderr = stderr;
      error.status = result.status;
      throw error;
    }
    return result;
  };
}

export function createHealthChecker({ url, exec = spawnSync } = {}) {
  return async ({ expectedSha, versionOverride }) => {
    const args = [
      path.join(REPOSITORY_ROOT, "scripts", "hub-postdeploy-smoke.mjs"),
      "--url", url, "--expected-sha", expectedSha, "--attempts", "12", "--delay-ms", "5000",
    ];
    if (versionOverride !== undefined) args.push("--version-override", versionOverride);
    const result = exec(process.execPath, args, { cwd: REPOSITORY_ROOT, encoding: "utf8", stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Hub health check failed (${result.status})`);
  };
}

async function main(argv = process.argv.slice(2)) {
  const url = argumentValue(argv, "--url");
  const expectedSecretNamesPath = argumentValue(argv, "--expected-secret-names");
  const result = await deployWithCanary({
    run: createWranglerRunner({ cwd: process.cwd() }),
    health: createHealthChecker({ url }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    workerName: argumentValue(argv, "--worker", "xmatrix-hub"),
    tag: argumentValue(argv, "--tag"),
    config: argumentValue(argv, "--config"),
    secretsFile: argumentValue(argv, "--secrets-file"),
    outdir: argumentValue(argv, "--outdir"),
    url,
    defines: argumentValues(argv, "--define"),
    expectedSecretNames: expectedSecretNamesPath
      ? JSON.parse(readFileSync(expectedSecretNamesPath, "utf8"))
      : [],
    canaryPercent: Number(argumentValue(argv, "--canary-percent", String(DEFAULT_CANARY_PERCENT))),
    holdMs: Number(argumentValue(argv, "--hold-seconds", String(DEFAULT_HOLD_SECONDS))) * 1000,
  });
  console.log(`[hub-canary] deployed ${result.mode === "canary" ? `${result.canaryPercent}% then 100%` : "once"} ${argumentValue(argv, "--tag")}`);
}

runCliMain(import.meta.url, main);
