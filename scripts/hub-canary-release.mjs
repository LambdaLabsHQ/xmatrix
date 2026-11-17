#!/usr/bin/env node
// Cut a Hub release over through a Cloudflare gradual deployment, then prove
// the new version and roll the code back to the running version if it fails.
//
// The database is not part of this: expand migrations are harmless to the
// previous Hub and contract migrations ship only after the new one is verified,
// so a canary window that ends in a code rollback never crosses a schema.
//
// A release that changes a Durable Object class lifecycle cannot be uploaded as
// a version. Cloudflare applies it atomically with `wrangler deploy`, and no
// version before it can be restored. Those releases take the plain deploy path:
// no canary, no rollback.

import { spawnSync } from "node:child_process";
import process from "node:process";

import { runCliMain } from "./cli-entrypoint.mjs";
import { validateHubHealthResponse, waitForHubHealth } from "./hub-postdeploy-smoke.mjs";

export const DEFAULT_CANARY_PERCENT = 10;
export const DEFAULT_OBSERVE_SECONDS = 90;
export const OBSERVE_INTERVAL_MS = 5_000;

const VERSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** A Durable Object class lifecycle change is applied by `wrangler deploy`, not uploaded as a version. */
export function isDurableObjectLifecycleRejection(output) {
  const text = String(output);
  return /\b10211\b/u.test(text) ||
    (/durable object/iu.test(text) && /(migration|lifecycle)/iu.test(text));
}

/** The version id `wrangler versions upload` reported. */
export function uploadedVersionId(output) {
  for (const line of String(output).split(/\r?\n/u)) {
    if (!/version/iu.test(line)) continue;
    const match = VERSION_ID.exec(line);
    if (match) return match[0].toLowerCase();
  }
  return null;
}

function jsonFromOutput(text) {
  const trimmed = String(text).trim();
  const start = Math.min(
    ...["{", "["].map((token) => {
      const index = trimmed.indexOf(token);
      return index === -1 ? Number.POSITIVE_INFINITY : index;
    }),
  );
  if (!Number.isFinite(start)) throw new Error(`expected JSON output, received: ${trimmed.slice(0, 200)}`);
  return JSON.parse(trimmed.slice(start));
}

function deploymentRecord(status) {
  if (Array.isArray(status)) return status[0] ?? null;
  return status?.deployments?.[0] ?? status?.result?.deployments?.[0] ?? status ?? null;
}

/** The version currently taking the most traffic, or null before a first deployment. */
export function baselineVersion(status) {
  const deployment = deploymentRecord(status);
  const versions = deployment?.versions;
  if (!Array.isArray(versions)) return null;
  const entries = versions
    .map((version) => ({
      id: String(version?.version_id ?? version?.versionId ?? version?.id ?? "").toLowerCase(),
      percentage: Number(version?.percentage ?? version?.percent ?? 0),
    }))
    .filter((version) => VERSION_ID.test(version.id));
  if (entries.length === 0) return null;
  entries.sort((left, right) => right.percentage - left.percentage);
  return entries[0];
}

/** The tag (release commit) attached to a version, when the recent list still names it. */
export function versionTag(versions, versionId) {
  const items = Array.isArray(versions) ? versions : versions?.items ?? versions?.versions ?? [];
  const found = items.find((version) =>
    String(version?.id ?? version?.version_id ?? "").toLowerCase() === versionId.toLowerCase());
  const tag = found?.metadata?.tag ?? found?.tag;
  return typeof tag === "string" && /^[0-9a-f]{40}$/u.test(tag) ? tag : null;
}

function versionOverride(worker, versionId) {
  return { "Cloudflare-Workers-Version-Overrides": `${worker}="${versionId}"` };
}

async function withRetry(action, attempts, sleep, log, retryable = () => true) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !retryable(error)) break;
      log(`attempt ${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      await sleep(attempt * 20_000);
    }
  }
  throw lastError;
}

async function observeLiveHealth({ url, revisions, ticks, intervalMs, fetchImpl, sleep, log }) {
  for (let tick = 0; tick < ticks; tick += 1) {
    const response = await fetchImpl(new URL("/", url), {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    validateHubHealthResponse(response, payload);
    const revision = payload.deployment?.revision;
    if (revisions && !revisions.has(revision)) {
      throw new Error(
        `canary traffic returned revision ${JSON.stringify(revision)}, expected one of ${[...revisions].join(", ")}`,
      );
    }
    log(`canary tick ${tick + 1}/${ticks}: revision ${revision} healthy`);
    if (tick + 1 < ticks) await sleep(intervalMs);
  }
}

/**
 * Runs the release. `deps` is injectable so the sequence and its rollback are
 * testable without Cloudflare.
 *
 * deps.run(args) -> { stdout, stderr } throws with `.stdout`/`.stderr` on a
 * non-zero exit; deps.smoke({ headers, expectedSha }) -> Promise; deps.sleep.
 */
export async function releaseHub(options, deps) {
  const {
    config, cwd, worker, tag, secretsFile, outdir, defines = [], smokeUrl,
    canaryPercent = DEFAULT_CANARY_PERCENT, observeSeconds = DEFAULT_OBSERVE_SECONDS,
  } = options;
  const { run, smoke, sleep, log, fetchImpl } = deps;
  if (!Number.isSafeInteger(canaryPercent) || canaryPercent < 1 || canaryPercent > 50) {
    throw new Error("canaryPercent must be an integer between 1 and 50");
  }
  if (!Number.isSafeInteger(observeSeconds) || observeSeconds < 10 || observeSeconds > 600) {
    throw new Error("observeSeconds must be an integer between 10 and 600");
  }
  const wrangle = (args) => run(args, { cwd });
  const base = ["--config", config];
  const defineArgs = defines.flatMap((define) => ["--define", define]);
  const upload = () => {
    const result = wrangle(["versions", "upload", ...base, "--tag", tag, "--secrets-file", secretsFile,
      "--outdir", outdir, ...defineArgs]);
    return result.stdout || result.stderr || "";
  };
  const deploy = (specs) => wrangle(["versions", "deploy", ...base, ...specs, "--yes"]);
  const deployWhole = () => wrangle(["deploy", ...base, "--tag", tag, "--secrets-file", secretsFile,
    "--outdir", outdir, ...defineArgs]);

  const uploadFailure = (error) =>
    `${error?.stdout ?? ""}\n${error?.stderr ?? ""}\n${error?.message ?? ""}`;
  let uploadOutput;
  try {
    // A lifecycle rejection is deterministic; only transient failures retry.
    uploadOutput = await withRetry(async () => upload(), 3, sleep, log,
      (error) => !isDurableObjectLifecycleRejection(uploadFailure(error)));
  } catch (error) {
    const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
    if (!isDurableObjectLifecycleRejection(output)) throw error;
    log("the Hub bundle changes a Durable Object class lifecycle; uploading a version is refused, so this release applies it with wrangler deploy and has no canary or rollback");
    await withRetry(async () => deployWhole(), 3, sleep, log);
    await smoke({ expectedSha: tag });
    return { mode: "deploy", versionId: null, baseline: null };
  }

  const versionId = uploadedVersionId(uploadOutput);
  if (!versionId) {
    throw new Error(`could not read the uploaded version id from: ${uploadOutput.slice(-400)}`);
  }
  log(`uploaded Hub version ${versionId} tagged ${tag}`);

  const status = jsonFromOutput(wrangle(["deployments", "status", ...base, "--json"]).stdout);
  const baseline = baselineVersion(status);
  const recent = (() => {
    try {
      return jsonFromOutput(wrangle(["versions", "list", ...base, "--json"]).stdout);
    } catch (error) {
      log(`could not read the recent versions for a rollback tag: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  })();
  const baselineTag = baseline ? versionTag(recent, baseline.id) : null;

  if (!baseline) {
    log("no running version to canary against; publishing the new version directly");
    await withRetry(async () => deploy([`${versionId}@100`]), 3, sleep, log);
    await smoke({ expectedSha: tag });
    return { mode: "direct", versionId, baseline: null };
  }

  log(`canarying ${versionId} against ${baseline.id} at ${baseline.percentage}%`);
  // Without the running version's tag, every healthy response is accepted
  // rather than guessing an identity the recent-version list did not name.
  const revisions = baselineTag ? new Set([tag, baselineTag]) : null;
  if (!baselineTag) log(`could not read the running version's tag; the canary only checks health, not revision`);
  let mutated = false;
  try {
    await withRetry(async () => deploy([`${baseline.id}@100`, `${versionId}@0`]), 3, sleep, log);
    mutated = true;
    // An override proves the new version before any real traffic reaches it.
    await smoke({ headers: versionOverride(worker, versionId), expectedSha: tag });

    await withRetry(async () => deploy([
      `${baseline.id}@${100 - canaryPercent}`, `${versionId}@${canaryPercent}`,
    ]), 3, sleep, log);
    await observeLiveHealth({
      url: smokeUrl,
      revisions,
      ticks: Math.max(1, Math.floor(observeSeconds / (OBSERVE_INTERVAL_MS / 1000))),
      intervalMs: OBSERVE_INTERVAL_MS,
      fetchImpl,
      sleep,
      log,
    });
    await smoke({ headers: versionOverride(worker, versionId), expectedSha: tag });

    await withRetry(async () => deploy([`${versionId}@100`]), 3, sleep, log);
    await smoke({ expectedSha: tag });
    return { mode: "canary", versionId, baseline };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`canary failed: ${reason}`);
    if (!mutated) throw error;
    try {
      await withRetry(async () => deploy([`${baseline.id}@100`]), 3, sleep, log);
    } catch (rollbackError) {
      throw new Error(`${reason}\nrolling back to ${baseline.id} also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
    }
    try {
      await smoke({ expectedSha: baselineTag ?? undefined });
    } catch (rollbackSmokeError) {
      log(`rolled back to ${baseline.id}, but its health check did not pass: ${rollbackSmokeError instanceof Error ? rollbackSmokeError.message : String(rollbackSmokeError)}`);
    }
    throw new Error(`${reason}\nrolled the Hub back to ${baseline.id} (${baselineTag ?? "unknown tag"})`);
  }
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

function realRun(args, { cwd }) {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpm, ["exec", "wrangler", ...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`wrangler ${args.slice(0, 2).join(" ")} exited ${result.status}`);
    error.stdout = result.stdout ?? "";
    error.stderr = result.stderr ?? "";
    throw error;
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function main(argv = process.argv.slice(2)) {
  const config = argumentValue(argv, "--config");
  const tag = argumentValue(argv, "--tag");
  const secretsFile = argumentValue(argv, "--secrets-file");
  const outdir = argumentValue(argv, "--outdir");
  const smokeUrl = argumentValue(argv, "--smoke-url");
  if (!config || !tag || !secretsFile || !outdir || !smokeUrl) {
    throw new Error("usage: hub-canary-release.mjs --config <path> --tag <sha> --secrets-file <path> --outdir <dir> --smoke-url <url> [--worker name] [--cwd dir] [--define KEY:VALUE]... [--canary-percent n] [--observe-seconds n]");
  }
  const cwd = argumentValue(argv, "--cwd", process.cwd());
  const worker = argumentValue(argv, "--worker", "xmatrix-hub");
  const result = await releaseHub({
    config,
    cwd,
    worker,
    tag,
    secretsFile,
    outdir,
    defines: argumentValues(argv, "--define"),
    smokeUrl,
    canaryPercent: Number(argumentValue(argv, "--canary-percent", String(DEFAULT_CANARY_PERCENT))),
    observeSeconds: Number(argumentValue(argv, "--observe-seconds", String(DEFAULT_OBSERVE_SECONDS))),
  }, {
    run: realRun,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    log: (message) => console.log(`[hub-canary] ${message}`),
    fetchImpl: fetch,
    smoke: (options) => waitForHubHealth({
      url: smokeUrl,
      attempts: 12,
      delayMs: 5_000,
      expectedSha: options.expectedSha,
      headers: options.headers,
    }),
  });
  console.log(`[hub-canary] ${result.mode} release complete`);
}

runCliMain(import.meta.url, main);
