#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

import { digestFile } from "./file-digests.mjs";

export const R2_RELEASE_MANIFEST = "xmatrix-r2-manifest.json";
const MANIFEST_SCHEMA_VERSION = 1;
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_WRANGLER_TIMEOUT_MS = 180_000;
const LARGE_WRANGLER_TIMEOUT_MS = 600_000;
export const R2_MULTIPART_THRESHOLD_BYTES = 32 * 1024 * 1024;
export const R2_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const R2_MULTIPART_QUEUE_SIZE = 2;
const R2_S3_MAX_ATTEMPTS = 5;
// An upload attempt that stalls must fail so the idempotent retry can run; a
// release job otherwise hangs silently until its job timeout cancels it.
const R2_UPLOAD_BASE_TIMEOUT_MS = 180_000;
const R2_UPLOAD_MIN_BYTES_PER_SECOND = 512 * 1024;
const R2_TRANSFER_CONCURRENCY = 2;
const WRANGLER_VERSION = "4.79.0";
const LOCAL_WRANGLER_CLI = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
);

function fail(message) {
  throw new Error(message);
}

function required(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`Missing ${name}`);
  return value.trim();
}

function normalizePrefix(value) {
  const prefix = required(value, "--prefix").replace(/^\/+|\/+$/gu, "");
  if (!prefix || prefix.split("/").some((part) => !part || part === "." || part === "..")) {
    fail(`Invalid R2 prefix: ${value}`);
  }
  return prefix;
}

export function normalizeRelativeObjectName(value) {
  const normalized = value;
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`Invalid release object name: ${value}`);
  }
  return normalized;
}

function contentType(name) {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (name.endsWith(".yml") || name.endsWith(".yaml")) return "application/yaml";
  if (name.endsWith(".zip")) return "application/zip";
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".exe")) return "application/vnd.microsoft.portable-executable";
  if (name.endsWith(".apk")) return "application/vnd.android.package-archive";
  return "application/octet-stream";
}

async function sha256(filePath) {
  return (await digestFile(filePath, ["sha256"])).sha256.toString("hex");
}

export async function mapWithConcurrency(items, concurrency, operation) {
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) fail(`Invalid concurrency: ${concurrency}`);
  const results = Array.from({ length: items.length });
  let nextIndex = 0;
  let failure;

  async function worker() {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        results[index] = await operation(items[index], index);
      } catch (error) {
        failure ??= error;
      }
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  if (failure) throw failure;
  return results;
}

async function walkFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail(`Release storage refuses symlink: ${absolute}`);
    if (entry.isDirectory()) files.push(...(await walkFiles(root, absolute)));
    else if (entry.isFile()) {
      const name = normalizeRelativeObjectName(path.relative(root, absolute).split(path.sep).join("/"));
      if (name !== R2_RELEASE_MANIFEST) files.push({ name, absolute });
    }
  }
  return files.sort((left, right) => left.name.localeCompare(right.name));
}

export function wranglerInvocation(
  args,
  {
    customCommand = process.env.XMATRIX_WRANGLER_COMMAND,
    platform = process.platform,
    nodeExecutable = process.execPath,
    localWranglerCli = LOCAL_WRANGLER_CLI,
    npxCli,
    fileExists = existsSync,
  } = {}
) {
  if (customCommand) {
    return /\.[cm]?js$/iu.test(customCommand)
      ? { command: process.execPath, args: [customCommand, ...args] }
      : { command: customCommand, args };
  }
  if (localWranglerCli && fileExists(localWranglerCli)) {
    return { command: nodeExecutable, args: [localWranglerCli, ...args] };
  }
  const nodeDirectory = path.dirname(nodeExecutable);
  const executableDirectories = [
    nodeDirectory,
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
  ];
  const candidates = npxCli
    ? [npxCli]
    : platform === "win32"
      ? executableDirectories.map((directory) =>
          path.join(directory, "node_modules", "npm", "bin", "npx-cli.js")
        )
      : executableDirectories.map((directory) =>
          path.resolve(directory, "../lib/node_modules/npm/bin/npx-cli.js")
        );
  const resolvedNpxCli = candidates.find((candidate) => npxCli || fileExists(candidate));
  if (!resolvedNpxCli) fail(`Could not locate the Node-provided npx CLI beside ${nodeExecutable}`);
  return {
    command: nodeExecutable,
    args: [resolvedNpxCli, "--yes", `wrangler@${WRANGLER_VERSION}`, ...args],
  };
}

export async function runWrangler(
  args,
  { capture = false, timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS } = {},
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail(`Invalid Wrangler timeout: ${timeoutMs}`);
  return await new Promise((resolve) => {
    const invocation = wranglerInvocation(args);
    const child = spawn(invocation.command, invocation.args, {
      env: process.env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
      forceKill.unref();
    }, timeoutMs);
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }
    child.on("error", (error) => finish({ code: -1, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) =>
      finish({
        code: timedOut ? -1 : (code ?? -1),
        stdout,
        stderr: timedOut ? `${stderr}Wrangler timed out after ${timeoutMs}ms` : stderr,
      }),
    );
  });
}

function isMissingObject(result) {
  return /(?:NoSuchKey|not found|does not exist|specified key.*not exist|10007)/iu.test(
    `${result.stdout}\n${result.stderr}`
  );
}

const RELEASE_DOWNLOAD_EVIDENCE_LIMIT = 400;
// A timed-out Wrangler inherits the release environment. Keep a short progress
// or error excerpt, and drop any line that could carry a credential, header, or
// environment value. This does not change the transfer itself.
const SENSITIVE_RELEASE_EVIDENCE =
  /(?:authorization\b|bearer\s+\S+|aws[_-]|x-amz-|secret|password|credential|api[_-]?key|\btoken\b|cookie\b|R2_RELEASE_|CLOUDFLARE_)/iu;

function redactReleaseEvidence(text) {
  const cleaned = String(text ?? "")
    .split(/\r?\n/u)
    .map((line) => (SENSITIVE_RELEASE_EVIDENCE.test(line) ? "[redacted]" : line))
    .join("\n")
    .trim();
  if (cleaned.length <= RELEASE_DOWNLOAD_EVIDENCE_LIMIT) return cleaned || "(empty)";
  return `${cleaned.slice(0, 140)}\n…\n${cleaned.slice(-140)}`;
}

function releaseDownloadFailure(phase, bucket, key, result) {
  const label =
    phase === "probe" ? "R2 probe download" : phase === "readback" ? "R2 readback download" : "R2 download";
  return `${label} ${bucket}/${key} failed after ${DEFAULT_ATTEMPTS} attempts: stdout=${redactReleaseEvidence(result?.stdout)}; stderr=${redactReleaseEvidence(result?.stderr)}`;
}

async function withRetries(label, operation, attempts = DEFAULT_ATTEMPTS) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await operation();
    if (last.code === 0) return last;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  fail(`${label} failed after ${attempts} attempts: ${last?.stderr || last?.stdout || "unknown error"}`);
}

export function resolveR2S3Configuration(env = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim() || "";
  const accessKeyId = env.R2_RELEASE_ACCESS_KEY_ID?.trim() || "";
  const secretAccessKey = env.R2_RELEASE_SECRET_ACCESS_KEY?.trim() || "";
  if (!accessKeyId && !secretAccessKey) return null;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    fail(
      "R2 multipart upload requires CLOUDFLARE_ACCOUNT_ID, R2_RELEASE_ACCESS_KEY_ID, and R2_RELEASE_SECRET_ACCESS_KEY together"
    );
  }
  return {
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: R2_S3_MAX_ATTEMPTS,
  };
}

export function requireR2S3Configuration(configuration = resolveR2S3Configuration()) {
  if (!configuration) fail("Required R2 S3 upload credentials are unavailable");
  return configuration;
}

export function shouldUseR2Multipart(size, configuration = resolveR2S3Configuration()) {
  if (!Number.isSafeInteger(size) || size < 0) fail(`Invalid release object size: ${size}`);
  requireR2S3Configuration(configuration);
  return true;
}

export function uploadTimeoutMs(size) {
  if (!Number.isSafeInteger(size) || size < 0) fail(`Invalid release object size: ${size}`);
  return R2_UPLOAD_BASE_TIMEOUT_MS + Math.ceil((size / R2_UPLOAD_MIN_BYTES_PER_SECOND) * 1000);
}

export async function uploadObjectMultipart(
  {
    bucket, key, source, expected, configuration = resolveR2S3Configuration(),
    timeoutMs = uploadTimeoutMs(expected.size),
  },
  {
    S3ClientClass = S3Client,
    UploadClass = Upload,
    createReadStreamFunction = createReadStream,
  } = {},
) {
  if (!configuration) fail("R2 multipart configuration is unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail(`Invalid R2 upload timeout: ${timeoutMs}`);
  const client = new S3ClientClass(configuration);
  const upload = new UploadClass({
    client,
    params: {
      Bucket: bucket,
      Key: key,
      Body: createReadStreamFunction(source),
      ContentType: contentType(expected.name),
    },
    partSize: R2_MULTIPART_PART_SIZE_BYTES,
    queueSize: R2_MULTIPART_QUEUE_SIZE,
    leavePartsOnError: false,
  });
  let deadline;
  const timedOut = new Promise((_, reject) => {
    deadline = setTimeout(() => {
      reject(new Error(`R2 upload ${bucket}/${key} timed out after ${timeoutMs}ms`));
      Promise.resolve(upload.abort?.()).catch(() => {});
    }, timeoutMs);
  });
  const startedAt = Date.now();
  process.stderr.write(`R2 upload ${bucket}/${key} (${expected.size} bytes) started\n`);
  try {
    await Promise.race([upload.done(), timedOut]);
    process.stderr.write(`R2 upload ${bucket}/${key} finished in ${Date.now() - startedAt}ms\n`);
  } finally {
    clearTimeout(deadline);
    client.destroy?.();
  }
}

export async function uploadObject(bucket, key, source, expected, {
  configuration = resolveR2S3Configuration(),
  uploadS3 = uploadObjectMultipart,
} = {}) {
  if (shouldUseR2Multipart(expected.size, configuration)) {
    try {
      await uploadS3({ bucket, key, source, expected, configuration });
      return { code: 0, stdout: "", stderr: "" };
    } catch (error) {
      return {
        code: -1,
        stdout: "",
        stderr: `R2 multipart upload failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

// Use the same account-scoped data endpoint as uploads. The caller still
// verifies the complete downloaded size and digest before any publication.
export async function downloadObjectS3(
  { bucket, key, destination, allowMissing = false,
    timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS, configuration = resolveR2S3Configuration() },
  { S3ClientClass = S3Client } = {},
) {
  if (!configuration) fail("Required R2 S3 download credentials are unavailable");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail(`Invalid R2 download timeout: ${timeoutMs}`);
  await mkdir(path.dirname(destination), { recursive: true });
  const client = new S3ClientClass(configuration);
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), {
      abortSignal: controller.signal,
    });
    if (!response.Body) fail("R2 S3 download omitted its body");
    await pipeline(response.Body, createWriteStream(destination), { signal: controller.signal });
    return true;
  } catch (error) {
    await rm(destination, { force: true });
    if (controller.signal.aborted) {
      fail(
        `R2 S3 download timed out after ${timeoutMs}ms: ${redactReleaseEvidence(error instanceof Error ? error.message : "")}`,
      );
    }
    if (allowMissing && error?.name === "NoSuchKey" && error?.$metadata?.httpStatusCode === 404) return false;
    throw error;
  } finally {
    clearTimeout(deadline);
    client.destroy();
  }
}

async function getObject(
  bucket,
  key,
  destination,
  {
    allowMissing = false,
    timeoutMs = DEFAULT_WRANGLER_TIMEOUT_MS,
    phase = "download",
    S3ClientClass,
  } = {},
) {
  await mkdir(path.dirname(destination), { recursive: true });
  const configuration = resolveR2S3Configuration();
  let result;
  for (let attempt = 1; attempt <= DEFAULT_ATTEMPTS; attempt += 1) {
    if (configuration) {
      try {
        return await downloadObjectS3(
          { bucket, key, destination, allowMissing, timeoutMs, configuration },
          S3ClientClass ? { S3ClientClass } : {},
        );
      } catch (error) {
        result = { code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
      }
    } else {
      result = await runWrangler(
        ["r2", "object", "get", `${bucket}/${key}`, "--remote", "--file", destination],
        { capture: true, timeoutMs },
      );
    }
    if (result.code === 0) return true;
    await rm(destination, { force: true });
    if (!configuration && allowMissing && isMissingObject(result)) return false;
    if (attempt < DEFAULT_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
  }
  fail(releaseDownloadFailure(phase, bucket, key, result));
}

function downloadTimeoutMs(expected, override) {
  if (override === undefined) {
    return expected.size >= R2_MULTIPART_THRESHOLD_BYTES
      ? LARGE_WRANGLER_TIMEOUT_MS
      : DEFAULT_WRANGLER_TIMEOUT_MS;
  }
  if (!Number.isSafeInteger(override) || override <= 0) fail(`Invalid R2 download timeout: ${override}`);
  return override;
}

async function verifyDownloaded(filePath, expected, label) {
  const fileStat = await stat(filePath);
  if (fileStat.size !== expected.size) fail(`${label} size mismatch: ${fileStat.size} != ${expected.size}`);
  const digest = await sha256(filePath);
  if (digest !== expected.sha256) fail(`${label} SHA-256 mismatch: ${digest} != ${expected.sha256}`);
}

async function putObjectIdempotently(bucket, key, source, expected, uploadOptions) {
  const probeRoot = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-probe-"));
  const probe = path.join(probeRoot, "object");
  try {
    const verificationTimeoutMs = downloadTimeoutMs(
      expected,
      uploadOptions.verificationTimeoutMs,
    );
    if (
      await getObject(bucket, key, probe, {
        allowMissing: true,
        timeoutMs: verificationTimeoutMs,
        phase: "probe",
        S3ClientClass: uploadOptions.S3ClientClass,
      })
    ) {
      await verifyDownloaded(probe, expected, `${bucket}/${key}`);
      return;
    }
    const uploaded = await uploadObject(bucket, key, source, expected, uploadOptions);
    if (uploaded.code !== 0) {
      // A retry may race with a completed first request or meet an active bucket
      // lock. Accept only an independently downloaded byte-identical object.
      if (
        !(await getObject(bucket, key, probe, {
          allowMissing: true,
          timeoutMs: verificationTimeoutMs,
          phase: "probe",
          S3ClientClass: uploadOptions.S3ClientClass,
        }))
      ) {
        await withRetries(
          `R2 upload ${bucket}/${key}`,
          async () => await uploadObject(bucket, key, source, expected, uploadOptions)
        );
      }
    }
    await getObject(bucket, key, probe, {
      timeoutMs: verificationTimeoutMs,
      phase: "readback",
      S3ClientClass: uploadOptions.S3ClientClass,
    });
    await verifyDownloaded(probe, expected, `${bucket}/${key}`);
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }
}

export async function buildManifest({ bucket, prefix, directory }) {
  const files = await mapWithConcurrency(await walkFiles(directory), R2_TRANSFER_CONCURRENCY, async (entry) => {
    const fileStat = await stat(entry.absolute);
    return {
      name: entry.name,
      key: `${prefix}/${entry.name}`,
      size: fileStat.size,
      sha256: await sha256(entry.absolute),
      contentType: contentType(entry.name),
    };
  });
  if (files.length === 0) fail(`Release directory is empty: ${directory}`);
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    bucket,
    prefix,
    releaseTag: process.env.XMATRIX_RELEASE_TAG || null,
    component: process.env.XMATRIX_RELEASE_COMPONENT || null,
    channel: process.env.XMATRIX_RELEASE_CHANNEL || null,
    commitSha: process.env.XMATRIX_RELEASE_SHA || process.env.GITHUB_SHA || null,
    runId: process.env.GITHUB_RUN_ID || null,
    files,
  };
}

// A build machine uploads its verified files straight into the release, each
// run attempt under its own part prefix: `releases/<tag>` is retention-locked,
// so a rerun that re-signs a binary cannot overwrite an earlier attempt's
// bytes. Nothing reads a part until seal-release names it in the release
// manifest, and the channel pointer only ever names a sealed release.
const RELEASE_PART_PATTERN = /^parts\/[a-z0-9][a-z0-9-]*\/\d+-\d+$/u;

export function releasePartPrefix(prefix, part, runId, attempt) {
  part = required(part, "--part");
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(part)) fail(`Invalid release part: ${part}`);
  if (!/^\d+$/u.test(String(runId)) || !/^\d+$/u.test(String(attempt)) || Number(attempt) < 1) {
    fail("Release parts require GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT");
  }
  return `${normalizePrefix(prefix)}/parts/${part}/${runId}-${attempt}`;
}

function isReleaseObjectKey(key, prefix, name) {
  if (key === `${prefix}/${name}`) return true;
  if (typeof key !== "string" || !key.startsWith(`${prefix}/`) || !key.endsWith(`/${name}`)) return false;
  return RELEASE_PART_PATTERN.test(key.slice(prefix.length + 1, key.length - name.length - 1));
}

function validateManifest(manifest, bucket, prefix) {
  if (
    manifest?.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    manifest.bucket !== bucket ||
    manifest.prefix !== prefix ||
    !Array.isArray(manifest.files) ||
    manifest.files.length === 0
  ) {
    fail(`Invalid R2 release manifest for ${bucket}/${prefix}`);
  }
  const seen = new Set();
  for (const file of manifest.files) {
    const name = normalizeRelativeObjectName(file?.name);
    if (
      seen.has(name) ||
      !isReleaseObjectKey(file.key, prefix, name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[0-9a-f]{64}$/u.test(file.sha256 || "")
    ) {
      fail(`Invalid R2 release manifest file: ${JSON.stringify(file)}`);
    }
    seen.add(name);
  }
  return manifest;
}

export async function uploadDirectory({ bucket, prefix, directory }, uploadOptions = {}) {
  // Validate required transport before probing or mutating any remote object.
  requireR2S3Configuration(uploadOptions.configuration);
  bucket = required(bucket, "--bucket");
  prefix = normalizePrefix(prefix);
  directory = path.resolve(required(directory, "--directory"));
  const manifest = await buildManifest({ bucket, prefix, directory });
  await mapWithConcurrency(manifest.files, R2_TRANSFER_CONCURRENCY, async (file) => {
    await putObjectIdempotently(bucket, file.key, path.join(directory, ...file.name.split("/")), file, uploadOptions);
  });
  const manifestPath = path.join(directory, R2_RELEASE_MANIFEST);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  const manifestStat = await stat(manifestPath);
  const manifestEntry = {
    name: R2_RELEASE_MANIFEST,
    size: manifestStat.size,
    sha256: await sha256(manifestPath),
  };
  await putObjectIdempotently(bucket, `${prefix}/${R2_RELEASE_MANIFEST}`, manifestPath, manifestEntry, uploadOptions);
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  return manifest;
}

async function fetchManifest({ bucket, prefix, destination, allowMissing = false }) {
  const manifestPath = path.join(destination, R2_RELEASE_MANIFEST);
  if (!(await getObject(bucket, `${prefix}/${R2_RELEASE_MANIFEST}`, manifestPath, { allowMissing }))) return null;
  return validateManifest(JSON.parse(await readFile(manifestPath, "utf8")), bucket, prefix);
}

export async function downloadDirectory({
  bucket,
  prefix,
  directory,
  allowMissing = false,
  excludeManifest = false,
  only,
}) {
  bucket = required(bucket, "--bucket");
  prefix = normalizePrefix(prefix);
  directory = path.resolve(required(directory, "--directory"));
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  const manifest = await fetchManifest({
    bucket,
    prefix,
    destination: directory,
    allowMissing,
  });
  if (!manifest) {
    await rm(directory, { recursive: true, force: true });
    return null;
  }
  // `--only <name>` fetches one named file, e.g. the one platform binary a
  // Desktop build seeds, instead of every file over a slow release link.
  const files = only === undefined ? manifest.files : manifest.files.filter((file) => file.name === only);
  if (only !== undefined && files.length === 0) fail(`${bucket}/${prefix} names no file ${only}`);
  await mapWithConcurrency(files, R2_TRANSFER_CONCURRENCY, async (file) => {
    const destination = path.join(directory, ...file.name.split("/"));
    await getObject(bucket, file.key, destination, {
      timeoutMs:
        file.size >= R2_MULTIPART_THRESHOLD_BYTES
          ? LARGE_WRANGLER_TIMEOUT_MS
          : DEFAULT_WRANGLER_TIMEOUT_MS,
    });
    await verifyDownloaded(destination, file, `${bucket}/${file.key}`);
  });
  if (excludeManifest) await rm(path.join(directory, R2_RELEASE_MANIFEST), { force: true });
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
  return manifest;
}

export async function downloadLatestAttempt({
  bucket,
  prefix,
  suffix,
  attempt,
  directory,
  excludeManifest = false,
}) {
  bucket = required(bucket, "--bucket");
  prefix = normalizePrefix(prefix);
  suffix = normalizeRelativeObjectName(required(suffix, "--suffix"));
  const maximumAttempt = Number(attempt);
  if (!Number.isSafeInteger(maximumAttempt) || maximumAttempt < 1) {
    fail(`Invalid --attempt: ${attempt}`);
  }
  for (let candidateAttempt = maximumAttempt; candidateAttempt >= 1; candidateAttempt -= 1) {
    const candidatePrefix = `${prefix}/${candidateAttempt}/${suffix}`;
    const manifest = await downloadDirectory({
      bucket,
      prefix: candidatePrefix,
      directory,
      allowMissing: true,
      excludeManifest,
    });
    if (manifest) {
      const selected = { attempt: candidateAttempt, prefix: candidatePrefix, manifest };
      process.stdout.write(`${JSON.stringify(selected)}\n`);
      return selected;
    }
  }
  fail(`No complete ${suffix} handoff exists through run attempt ${maximumAttempt} under ${prefix}`);
}

export async function uploadReleasePart(
  { bucket, prefix, part, directory, runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT },
  uploadOptions = {},
) {
  return uploadDirectory({ bucket, prefix: releasePartPrefix(prefix, part, runId, attempt), directory }, uploadOptions);
}

async function latestReleasePart({ bucket, prefix, part, runId, attempt, staging }) {
  const maximumAttempt = Number(attempt);
  for (let candidate = maximumAttempt; candidate >= 1; candidate -= 1) {
    const partPrefix = releasePartPrefix(prefix, part, runId, candidate);
    const destination = path.join(staging, `${part}-${candidate}`);
    await mkdir(destination, { recursive: true });
    const manifest = await fetchManifest({ bucket, prefix: partPrefix, destination, allowMissing: true });
    if (manifest) return manifest;
  }
  fail(`No complete ${part} release part exists through run attempt ${maximumAttempt} under ${prefix}`);
}

function checksumsFile(files) {
  return files
    .filter((file) => file.name !== "checksums.txt")
    .map((file) => `${file.sha256}  ${file.name}\n`)
    .join("");
}

// Seal a release from the parts its build machines uploaded directly: no
// artifact is downloaded or re-uploaded, only the manifest that names them.
// A sealed release is immutable, so sealing again returns the sealed manifest.
export async function sealRelease(
  {
    bucket, prefix, parts, checksums = false,
    runId = process.env.GITHUB_RUN_ID, attempt = process.env.GITHUB_RUN_ATTEMPT,
  },
  uploadOptions = {},
) {
  requireR2S3Configuration(uploadOptions.configuration);
  bucket = required(bucket, "--bucket");
  prefix = normalizePrefix(prefix);
  const partNames = required(parts, "--parts").split(",").map((part) => part.trim()).filter(Boolean);
  if (partNames.length === 0 || new Set(partNames).size !== partNames.length) fail(`Invalid --parts: ${parts}`);
  const staging = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-seal-"));
  try {
    const sealed = await fetchManifest({ bucket, prefix, destination: staging, allowMissing: true });
    if (sealed) {
      process.stdout.write(`${JSON.stringify(sealed)}\n`);
      return sealed;
    }
    const files = [];
    for (const part of partNames) {
      const manifest = await latestReleasePart({ bucket, prefix, part, runId, attempt, staging });
      files.push(...manifest.files);
    }
    if (checksums) {
      const checksumDirectory = path.join(staging, "checksums");
      await mkdir(checksumDirectory, { recursive: true });
      await writeFile(path.join(checksumDirectory, "checksums.txt"), checksumsFile(files));
      const manifest = await uploadReleasePart(
        { bucket, prefix, part: "checksums", directory: checksumDirectory, runId, attempt },
        uploadOptions,
      );
      files.push(...manifest.files);
    }
    const names = new Set();
    for (const file of files) {
      if (names.has(file.name)) fail(`Release ${prefix} has two parts that provide ${file.name}`);
      names.add(file.name);
    }
    files.sort((left, right) => left.name.localeCompare(right.name));
    const manifest = validateManifest({
      schemaVersion: MANIFEST_SCHEMA_VERSION,
      bucket,
      prefix,
      releaseTag: process.env.XMATRIX_RELEASE_TAG || null,
      component: process.env.XMATRIX_RELEASE_COMPONENT || null,
      channel: process.env.XMATRIX_RELEASE_CHANNEL || null,
      commitSha: process.env.XMATRIX_RELEASE_SHA || process.env.GITHUB_SHA || null,
      runId: runId || null,
      files,
    }, bucket, prefix);
    const manifestPath = path.join(staging, R2_RELEASE_MANIFEST);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const manifestStat = await stat(manifestPath);
    await putObjectIdempotently(bucket, `${prefix}/${R2_RELEASE_MANIFEST}`, manifestPath, {
      name: R2_RELEASE_MANIFEST,
      size: manifestStat.size,
      sha256: await sha256(manifestPath),
    }, uploadOptions);
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return manifest;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function releaseVersion(tag) {
  const version = /-v(\d+\.\d+\.\d+)$/u.exec(tag ?? "")?.[1];
  if (!version) fail(`Release tag has no version: ${tag}`);
  return version.split(".").map(Number);
}

function isOlderRelease(candidate, current) {
  const [left, right] = [releaseVersion(candidate), releaseVersion(current)];
  const index = left.findIndex((part, position) => part !== right[position]);
  return index >= 0 && left[index] < right[index];
}

// Point a channel at a sealed release. A train publishes to dev; promoting to
// stable points stable at the same sealed bytes. A channel never moves to an
// older release than the one it already names.
export async function publishChannel({ bucket, component, channel, prefix }, uploadOptions = {}) {
  shouldUseR2Multipart(0, uploadOptions.configuration);
  bucket = required(bucket, "--bucket");
  component = normalizeRelativeObjectName(required(component, "--component"));
  channel = normalizeRelativeObjectName(required(channel, "--channel"));
  prefix = normalizePrefix(prefix);
  const staging = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-channel-"));
  try {
    const manifest = await fetchManifest({
      bucket,
      prefix,
      destination: staging,
    });
    if (manifest.component && manifest.component !== component)
      fail(`Manifest component ${manifest.component} does not match ${component}`);
    const channelKey = `channels/${component}/${channel}.json`;
    const currentPath = path.join(staging, "current.json");
    if (await getObject(bucket, channelKey, currentPath, { allowMissing: true })) {
      const current = JSON.parse(await readFile(currentPath, "utf8"));
      if (isOlderRelease(manifest.releaseTag, current.releaseTag)) {
        fail(`${component} ${channel} already names ${current.releaseTag}; refusing to move it back to ${manifest.releaseTag}`);
      }
    }
    const pointer = {
      schemaVersion: 1,
      component,
      channel,
      releaseTag: manifest.releaseTag,
      prefix,
      manifestKey: `${prefix}/${R2_RELEASE_MANIFEST}`,
      commitSha: manifest.commitSha,
      runId: manifest.runId,
      files: manifest.files,
      publishedAt: new Date().toISOString(),
    };
    const pointerPath = path.join(staging, "channel.json");
    await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, {
      mode: 0o600,
    });
    await withRetries(
      `R2 channel publish ${component}/${channel}`,
      async () =>
        await uploadObject(bucket, channelKey, pointerPath, {
          name: "channel.json",
          size: (await stat(pointerPath)).size,
        }, uploadOptions)
    );
    process.stdout.write(`${JSON.stringify(pointer)}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith("--")) fail(`Unexpected argument: ${key}`);
    if (key === "--allow-missing") options.allowMissing = true;
    else if (key === "--exclude-manifest") options.excludeManifest = true;
    else if (key === "--checksums") options.checksums = true;
    else options[key.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = rest[++index];
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "upload-directory") await uploadDirectory(options);
  else if (command === "download-directory") {
    const result = await downloadDirectory(options);
    if (!result && options.allowMissing) process.stdout.write('{"exists":false}\n');
  } else if (command === "download-latest-attempt") await downloadLatestAttempt(options);
  else if (command === "upload-release-part") await uploadReleasePart(options);
  else if (command === "seal-release") await sealRelease(options);
  else if (command === "publish-channel") await publishChannel(options);
  else
    fail(
      "Usage: r2-release-store.mjs <upload-directory|upload-release-part|seal-release|download-directory|download-latest-attempt|publish-channel> --bucket <bucket> --prefix <prefix> --directory <directory>"
    );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
