#!/usr/bin/env node

/**
 * Deploys a tagged Hub as a Cloudflare Worker version, serves it to a small
 * share of production traffic, promotes it only after the canary proves healthy,
 * and puts the previous version back at 100% when it does not.
 *
 * The rollback moves Worker code only. Expand migrations have already run and
 * are harmless to the previous version; contract migrations ship separately
 * after a new Hub is verified, so a rollback never crosses the schema.
 */

import process from "node:process";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { runCliMain } from "./cli-entrypoint.mjs";
import {
  validateHubHealthResponse,
  verifyCompatibilityGate,
  verifyPostgresReadiness,
  waitForHubHealth,
} from "./hub-postdeploy-smoke.mjs";
import { verifyHttpsRedirect } from "./https-postdeploy-smoke.mjs";

const VERSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const DEPLOY_DEFAULTS = Object.freeze({
  canaryPercent: 10,
  windowMs: 180_000,
  intervalMs: 2_000,
  minNewSamples: 3,
  maxNewVersionFailures: 2,
  maxUnattributedFailureRatio: 0.05,
  settleAttempts: 3,
  settleDelayMs: 1_000,
  promoteAttempts: 12,
  promoteDelayMs: 5_000,
  rollbackAttempts: 12,
  rollbackDelayMs: 2_000,
});

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function parseUploadedVersionId(stdout) {
  const match = /Worker Version ID:\s*([0-9a-f-]{36})/u.exec(stdout ?? "");
  if (!match || !VERSION_ID.test(match[1])) {
    throw new Error("wrangler versions upload did not report a Worker Version ID");
  }
  return match[1];
}

function requireInteger(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

export function validateCanarySettings(settings) {
  const canaryPercent = requireInteger(settings.canaryPercent ?? DEPLOY_DEFAULTS.canaryPercent,
    "canary percent", 1, 50);
  const windowMs = requireInteger(settings.windowMs ?? DEPLOY_DEFAULTS.windowMs,
    "canary window", 30_000, 900_000);
  const intervalMs = requireInteger(settings.intervalMs ?? DEPLOY_DEFAULTS.intervalMs,
    "canary sample interval", 500, 30_000);
  const minNewSamples = requireInteger(settings.minNewSamples ?? DEPLOY_DEFAULTS.minNewSamples,
    "minimum new-version samples", 1, 10_000);
  if (intervalMs > windowMs) throw new Error("canary sample interval must not exceed its window");
  return { canaryPercent, windowMs, intervalMs, minNewSamples };
}

export function defaultRunWrangler(args, { cwd = process.cwd(), env = process.env } = {}) {
  return execFileSync("pnpm", ["exec", "wrangler", ...args], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function fetchHealth(url, fetchImpl) {
  const target = new URL("/", url);
  const response = await fetchImpl(target, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new Error("health response content type is not JSON");
  }
  const payload = await response.json();
  validateHubHealthResponse(response, payload);
  const versionId = payload.deployment?.versionId;
  const revision = payload.deployment?.revision;
  if (typeof versionId !== "string" || !VERSION_ID.test(versionId)) {
    throw new Error("health response does not name its Worker Version ID");
  }
  if (typeof revision !== "string" || !/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("health response does not name its Hub revision");
  }
  return { versionId, revision };
}

/**
 * The version every sampled response serves. A Worker already splitting
 * traffic refuses the rollout: the previous version must be unambiguous
 * before it is used as the rollback target.
 */
export async function readServingVersion({ url, fetchImpl = fetch, delayImpl = delay, log = () => {} }) {
  let served;
  for (let attempt = 1; attempt <= DEPLOY_DEFAULTS.settleAttempts; attempt += 1) {
    const health = await fetchHealth(url, fetchImpl);
    if (served && (served.versionId !== health.versionId || served.revision !== health.revision)) {
      throw new Error(`production Hub already splits traffic: ${served.versionId} and ${health.versionId} both answer`);
    }
    served = health;
    if (attempt < DEPLOY_DEFAULTS.settleAttempts) await delayImpl(DEPLOY_DEFAULTS.settleDelayMs);
  }
  log(`[hub-canary] serving version ${served.versionId} (${served.revision})`);
  return served;
}

function withRetry(action, { attempts = 3, delayMs = 20_000, delayImpl = delay, label }) {
  return async () => {
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await action();
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await delayImpl(attempt * delayMs);
      }
    }
    throw new Error(`${label} failed after ${attempts} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  };
}

export async function uploadHubVersion({
  url,
  expectedSha,
  config,
  tag,
  secretsFile,
  outdir,
  defines = [],
  cwd = process.cwd(),
  runWrangler = defaultRunWrangler,
  fetchImpl = fetch,
  delayImpl = delay,
  log = () => {},
}) {
  if (!/^[0-9a-f]{40}$/u.test(expectedSha ?? "")) throw new Error("expected revision must be a full Git SHA");
  if (!config || !secretsFile || !outdir) throw new Error("config, secrets file and output directory are required");
  if (!tag) throw new Error("a version tag is required");
  const previous = await readServingVersion({ url, fetchImpl, delayImpl, log });
  const args = [
    "versions", "upload",
    "--config", config,
    "--tag", tag,
    "--message", `canary upload ${tag}`,
    "--secrets-file", secretsFile,
    "--outdir", outdir,
    ...defines.flatMap((define) => ["--define", define]),
  ];
  const stdout = await withRetry(
    () => runWrangler(args, { cwd }),
    { delayImpl, label: "Hub version upload" },
  )();
  const versionId = parseUploadedVersionId(stdout);
  if (versionId === previous.versionId) {
    throw new Error("uploaded Hub version is the version already serving production");
  }
  log(`[hub-canary] uploaded version ${versionId} from ${expectedSha}`);
  return { previous, versionId };
}

async function deploySplit({ config, cwd, runWrangler, delayImpl, specs, message, label }) {
  const args = [
    "versions", "deploy",
    ...specs,
    "-y",
    "--message", message,
    "--config", config,
  ];
  await withRetry(
    () => runWrangler(args, { cwd }),
    { delayImpl, label },
  )();
}

async function verifyServingVersion({ url, fetchImpl, delayImpl, versionId, revision, attempts, delayMs }) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const health = await fetchHealth(url, fetchImpl);
      if (health.versionId === versionId && (revision === undefined || health.revision === revision)) {
        return health;
      }
    } catch {
      // A failed probe is retried like a mismatched version.
    }
    if (attempt < attempts) await delayImpl(delayMs);
  }
  const detail = revision ? `${versionId} (${revision})` : versionId;
  throw new Error(`production Hub does not serve version ${detail}`);
}

/**
 * One canary window: every sample asks the public health endpoint. A sample
 * served by the new version must also pass the client compatibility and
 * PostgreSQL readiness gates. Failures of the new version, and unattributed
 * failures beyond a small share of samples, roll the rollout back.
 */
export async function watchCanary({
  url,
  expectedSha,
  newVersionId,
  previousVersionId,
  canaryPercent,
  windowMs,
  intervalMs,
  minNewSamples,
  fetchImpl = fetch,
  delayImpl = delay,
  clock = Date.now,
}) {
  const maxNewVersionFailures = DEPLOY_DEFAULTS.maxNewVersionFailures;
  const maxUnattributedFailureRatio = DEPLOY_DEFAULTS.maxUnattributedFailureRatio;
  const started = clock();
  let samples = 0;
  let newSamples = 0;
  let newFailures = 0;
  let unattributedFailures = 0;
  let consecutiveUnattributed = 0;
  const evidence = [];

  const fail = (reason) => {
    evidence.push(reason);
    return { outcome: "unhealthy", reason, samples, newSamples, evidence };
  };

  while (clock() - started < windowMs) {
    samples += 1;
    let health;
    try {
      health = await fetchHealth(url, fetchImpl);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      unattributedFailures += 1;
      consecutiveUnattributed += 1;
      evidence.push(`sample failed: ${message}`);
      if (consecutiveUnattributed >= 3) return fail(`three consecutive samples failed: ${message}`);
      if (unattributedFailures >= Math.max(3, Math.ceil(samples * maxUnattributedFailureRatio))) {
        return fail(`${unattributedFailures} of ${samples} samples failed`);
      }
      if (clock() - started < windowMs) await delayImpl(intervalMs);
      continue;
    }
    consecutiveUnattributed = 0;
    if (health.versionId === previousVersionId) {
      // The previous version answers as it did before the canary; its own
      // health is not this rollout's verdict.
    } else if (health.versionId === newVersionId) {
      if (health.revision !== expectedSha) {
        newFailures += 1;
        evidence.push(`new version served revision ${health.revision}, expected ${expectedSha}`);
      } else {
        try {
          await verifyCompatibilityGate(url, fetchImpl);
          await verifyPostgresReadiness(url, fetchImpl);
          newSamples += 1;
        } catch (error) {
          newFailures += 1;
          evidence.push(`new version ${newVersionId} failed its gate: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } else {
      unattributedFailures += 1;
      evidence.push(`health served unexpected version ${health.versionId}`);
      if (unattributedFailures >= Math.max(3, Math.ceil(samples * maxUnattributedFailureRatio))) {
        return fail(`${unattributedFailures} of ${samples} samples served an unexpected version`);
      }
    }
    if (newFailures >= maxNewVersionFailures) {
      return fail(`new version failed ${newFailures} samples: ${evidence.filter((line) => line.includes("new version")).join("; ")}`);
    }
    if (clock() - started < windowMs) await delayImpl(intervalMs);
  }

  if (newSamples < minNewSamples) {
    return fail(`canary served the new version ${newSamples} times, fewer than ${minNewSamples}; ${canaryPercent}% of traffic never reached it`);
  }
  return { outcome: "healthy", samples, newSamples, evidence };
}

export async function rolloutHubCanary({
  state,
  url,
  expectedSha,
  config,
  cwd = process.cwd(),
  runWrangler = defaultRunWrangler,
  fetchImpl = fetch,
  delayImpl = delay,
  clock = Date.now,
  log = () => {},
  settings = {},
}) {
  const canary = validateCanarySettings(settings);
  const hubConfig = config ?? state.config;
  if (!hubConfig) throw new Error("the rendered production Hub config is required");
  const { previous, versionId: newVersionId } = state;
  if (!previous || !VERSION_ID.test(previous.versionId ?? "") || !/^[0-9a-f]{40}$/u.test(previous.revision ?? "")) {
    throw new Error("canary state does not name the version serving production");
  }
  if (!VERSION_ID.test(newVersionId ?? "")) throw new Error("canary state does not name the uploaded version");
  if (newVersionId === previous.versionId) throw new Error("canary state names the serving version as its replacement");
  if (state.expectedSha && state.expectedSha !== expectedSha) {
    throw new Error("canary state belongs to a different release revision");
  }

  const rollback = async (reason) => {
    log(`[hub-canary] rolling back to ${previous.versionId}: ${reason}`);
    await deploySplit({
      config: hubConfig, cwd, runWrangler, delayImpl,
      specs: [`${previous.versionId}@100`],
      message: `automatic rollback to ${previous.revision}: ${reason}`.slice(0, 200),
      label: "Hub canary rollback",
    });
    await verifyServingVersion({
      url, fetchImpl, delayImpl,
      versionId: previous.versionId,
      revision: previous.revision,
      attempts: DEPLOY_DEFAULTS.rollbackAttempts,
      delayMs: DEPLOY_DEFAULTS.rollbackDelayMs,
    });
    log(`[hub-canary] rolled back; ${previous.versionId} serves production`);
  };

  await deploySplit({
    config: hubConfig, cwd, runWrangler, delayImpl,
    specs: [`${newVersionId}@${canary.canaryPercent}`, `${previous.versionId}@${100 - canary.canaryPercent}`],
    message: `canary ${canary.canaryPercent}% for ${expectedSha}`,
    label: "Hub canary deployment",
  });
  log(`[hub-canary] canary ${canary.canaryPercent}% for ${canary.windowMs} ms`);

  let report;
  try {
    report = await watchCanary({
      url, expectedSha, newVersionId,
      previousVersionId: previous.versionId,
      canaryPercent: canary.canaryPercent,
      windowMs: canary.windowMs,
      intervalMs: canary.intervalMs,
      minNewSamples: canary.minNewSamples,
      fetchImpl, delayImpl, clock, log,
    });
  } catch (error) {
    await rollback(`canary probes failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  if (report.outcome !== "healthy") {
    await rollback(report.reason);
    throw new Error(`Hub canary rolled back: ${report.reason}`);
  }
  log(`[hub-canary] canary healthy: ${report.newSamples} of ${report.samples} samples served the new version`);

  await deploySplit({
    config: hubConfig, cwd, runWrangler, delayImpl,
    specs: [`${newVersionId}@100`],
    message: `promote ${expectedSha} after a healthy canary`,
    label: "Hub promotion",
  });

  try {
    await waitForHubHealth({
      url,
      attempts: DEPLOY_DEFAULTS.promoteAttempts,
      delayMs: DEPLOY_DEFAULTS.promoteDelayMs,
      fetchImpl,
      delayImpl,
      postgresReadiness: true,
      expectedSha,
    });
    await verifyHttpsRedirect(url, fetchImpl);
  } catch (error) {
    await rollback(`promoted version failed verification: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  log(`[hub-canary] promoted ${newVersionId} from ${expectedSha}`);
  return { previous, promoted: newVersionId, canary: report };
}

export function hubCanaryStatePath(value) {
  if (!value) throw new Error("a canary state file is required");
  return value;
}

export function readCanaryState(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeCanaryState(file, state) {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function argumentValue(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  return index >= 0 && index < argv.length - 1 ? argv[index + 1] : fallback;
}

function argumentValues(argv, flag) {
  const values = [];
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === flag) values.push(argv[index + 1]);
  }
  return values;
}

function requiredArgument(argv, flag) {
  const value = argumentValue(argv, flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const stateFile = requiredArgument(argv, "--state");
  if (command === "upload") {
    const config = requiredArgument(argv, "--config");
    const expectedSha = requiredArgument(argv, "--expected-sha");
    const state = await uploadHubVersion({
      url: requiredArgument(argv, "--url"),
      expectedSha,
      config,
      tag: requiredArgument(argv, "--tag"),
      secretsFile: requiredArgument(argv, "--secrets-file"),
      outdir: requiredArgument(argv, "--outdir"),
      defines: argumentValues(argv, "--define"),
    });
    writeCanaryState(hubCanaryStatePath(stateFile), { ...state, config, expectedSha });
    return;
  }
  if (command === "rollout") {
    const state = readCanaryState(stateFile);
    await rolloutHubCanary({
      state,
      url: requiredArgument(argv, "--url"),
      expectedSha: requiredArgument(argv, "--expected-sha"),
      config: state.config,
      settings: {
        canaryPercent: Number(argumentValue(argv, "--canary-percent", String(DEPLOY_DEFAULTS.canaryPercent))),
        windowMs: Number(argumentValue(argv, "--window-seconds", String(DEPLOY_DEFAULTS.windowMs / 1000))) * 1000,
        intervalMs: Number(argumentValue(argv, "--interval-ms", String(DEPLOY_DEFAULTS.intervalMs))),
      },
    });
    return;
  }
  throw new Error("usage: hub-canary-rollout.mjs <upload|rollout> --state <file> --url <https-origin> --expected-sha <sha> ...");
}

runCliMain(import.meta.url, main);
