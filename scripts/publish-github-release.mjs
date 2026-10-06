import { spawnSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { basename } from "node:path";

import {
  assertAnnotatedTagTargetsCommit,
  assertImmutableReleaseTransaction,
  assertImmutableTagCanBeUsed,
  assertReleaseTransactionId,
  isImmutableVersionTag,
  releaseNotesWithTransaction,
} from "./release-publication-policy.mjs";
import {
  DEFAULT_STALL_SPEED_LIMIT_BYTES,
  DEFAULT_STALL_SPEED_TIME_SECONDS,
  DEFAULT_UPLOAD_TIMEOUT_MS,
  buildCurlUploadArgs,
} from "./publish-github-release-upload.mjs";

const RETRY_ATTEMPTS = Number(process.env.GITHUB_RELEASE_RETRY_ATTEMPTS ?? "6");
const RETRY_BASE_MS = Number(process.env.GITHUB_RELEASE_RETRY_BASE_MS ?? "1500");
const RETRY_MAX_MS = Number(process.env.GITHUB_RELEASE_RETRY_MAX_MS ?? "30000");
const API_TIMEOUT_MS = Number(process.env.GITHUB_RELEASE_API_TIMEOUT_MS ?? "60000");
const UPLOAD_TIMEOUT_MS = Number(
  process.env.GITHUB_RELEASE_UPLOAD_TIMEOUT_MS ?? String(DEFAULT_UPLOAD_TIMEOUT_MS),
);
const STALL_SPEED_LIMIT_BYTES = Number(
  process.env.GITHUB_RELEASE_STALL_SPEED_LIMIT ?? String(DEFAULT_STALL_SPEED_LIMIT_BYTES),
);
const STALL_SPEED_TIME_SECONDS = Number(
  process.env.GITHUB_RELEASE_STALL_SPEED_TIME ?? String(DEFAULT_STALL_SPEED_TIME_SECONDS),
);

const allowEmptyAssets = process.env.RELEASE_ALLOW_EMPTY_ASSETS === "true";
const requiredEnv = [
  "GITHUB_REPOSITORY",
  "GITHUB_SHA",
  "GITHUB_TOKEN",
  "RELEASE_TAG",
  "RELEASE_TITLE",
  "RELEASE_NOTES",
  "RELEASE_PRERELEASE",
];

for (const name of requiredEnv) {
  if (!process.env[name]) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

if (!allowEmptyAssets && !process.env.RELEASE_ASSETS) {
  throw new Error("Missing required environment variable: RELEASE_ASSETS");
}

const [owner, repo] = process.env.GITHUB_REPOSITORY.split("/");
const token = process.env.GITHUB_TOKEN;
const tag = process.env.RELEASE_TAG;
const assetPaths = (process.env.RELEASE_ASSETS ?? "").split("\n").filter(Boolean).map(normalizeReleaseAssetPath);
const expectedAssetNames = new Set(assetPaths.map((assetPath) => basename(assetPath)));
const requiredAssetNames = new Set(
  (process.env.RELEASE_REQUIRED_ASSET_NAMES ?? "")
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean),
);
const forceTag = process.env.RELEASE_FORCE_TAG === "true";
const keepStaleAssets = process.env.RELEASE_KEEP_STALE_ASSETS === "true";
const draftRelease = process.env.RELEASE_DRAFT === "true";
const immutableVersion =
  isImmutableVersionTag(tag) || process.env.RELEASE_IMMUTABLE_VERSION === "true";
const releaseTransactionId = process.env.RELEASE_TRANSACTION_ID ?? "";
const updateMetadata = process.env.RELEASE_UPDATE_METADATA !== "false";
const publishAfterUpload =
  process.env.RELEASE_PUBLISH_AFTER_UPLOAD === "true" || (immutableVersion && !draftRelease);
const deleteAssetNames = new Set((process.env.RELEASE_DELETE_ASSET_NAMES ?? "").split("\n").filter(Boolean));

if (immutableVersion) {
  assertReleaseTransactionId(releaseTransactionId);
  if (forceTag) {
    throw new Error("RELEASE_FORCE_TAG cannot be used for an immutable versioned release.");
  }
  if (deleteAssetNames.size > 0) {
    throw new Error("RELEASE_DELETE_ASSET_NAMES cannot be used for an immutable versioned release.");
  }
}

class RetryableHttpError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
    this.retryable = true;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const exponential = RETRY_BASE_MS * 2 ** (attempt - 1);
  const jitter = Math.floor(Math.random() * RETRY_BASE_MS);
  return Math.min(RETRY_MAX_MS, exponential + jitter);
}

function shouldRetryStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function shouldRetryError(error) {
  if (error?.retryable) return true;

  const code = error?.code ?? error?.cause?.code ?? error?.cause?.cause?.code;
  if (
    error?.name === "AbortError" ||
    error?.name === "TimeoutError" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }

  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_ATTEMPTS || !shouldRetryError(error)) {
        throw error;
      }

      const delay = retryDelay(attempt);
      console.warn(`${label} failed on attempt ${attempt}/${RETRY_ATTEMPTS}: ${error.message}`);
      console.warn(`Retrying ${label} in ${delay}ms...`);
      await sleep(delay);
    }
  }
  throw lastError;
}

function fetchTextWithCurl(url, options = {}) {
  const method = options.method ?? "GET";
  const headers = options.headers ?? {};
  const timeoutSeconds = Math.max(1, Math.ceil(API_TIMEOUT_MS / 1000));
  const args = [
    "--silent",
    "--show-error",
    "--location",
    "--http1.1",
    "--connect-timeout",
    "20",
    "--max-time",
    String(timeoutSeconds),
    "--request",
    method,
    "--write-out",
    "\n%{http_code}",
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (value != null && value !== "") {
      args.push("--header", `${name}: ${value}`);
    }
  }
  if (options.body != null && options.body !== "") {
    args.push("--data-raw", String(options.body));
  }
  args.push(url);

  const result = spawnSync("curl", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`curl ${method} ${url} failed with exit code ${result.status}: ${result.stderr.trim()}`);
    error.retryable = true;
    throw error;
  }

  const output = result.stdout;
  const statusIndex = output.lastIndexOf("\n");
  const text = statusIndex === -1 ? "" : output.slice(0, statusIndex);
  const status = Number(statusIndex === -1 ? output : output.slice(statusIndex + 1));
  if (!Number.isInteger(status)) {
    throw new Error(`curl ${method} ${url} returned an invalid status`);
  }
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
    },
    text: status === 204 ? "" : text,
  };
}

async function fetchText(url, options) {
  try {
    const response = await fetch(url, {
      ...options,
      signal: options?.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    });
    const text = response.status === 204 ? "" : await response.text();
    return { response, text };
  } catch (error) {
    const bodyIsCurlable = options?.body == null || typeof options.body === "string";
    if (bodyIsCurlable && hasCommand("curl") && shouldRetryError(error)) {
      console.warn(`fetch failed (${error.message}); retrying ${url} via curl`);
      return fetchTextWithCurl(url, options);
    }
    throw error;
  }
}

async function github(path, options = {}) {
  const method = options.method ?? "GET";
  const { response, text } = await withRetry(`${method} ${path}`, async () => {
    const result = await fetchText(`https://api.github.com${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });

    if (!result.response.ok && shouldRetryStatus(result.response.status)) {
      throw new RetryableHttpError(
        `${method} ${path} failed: ${result.response.status} ${result.text}`,
        result.response.status,
      );
    }

    return result;
  });

  if (response.status === 204) {
    return null;
  }

  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${text}`);
  }
  return body;
}

async function deleteExistingAssetByName(releaseId, name) {
  const release = await github(`/repos/${owner}/${repo}/releases/${releaseId}`);
  const existing = release.assets?.find((asset) => asset.name === name);
  if (!existing) return false;

  await github(`/repos/${owner}/${repo}/releases/assets/${existing.id}`, { method: "DELETE" });
  console.log(`Deleted existing ${name} before retry`);
  return true;
}

function hasCommand(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return result.status === 0;
}

function normalizeReleaseAssetPath(assetPath) {
  if (process.platform !== "win32") return assetPath;

  const msysDrivePath = assetPath.match(/^\/([a-zA-Z])(?=\/|$)(.*)$/);
  if (!msysDrivePath) return assetPath;

  const [, drive, rest] = msysDrivePath;
  return `${drive.toUpperCase()}:${rest}`;
}

async function uploadAssetWithCurl(releaseId, assetPath, uploadName) {
  const size = statSync(assetPath).size;
  const uploadUrl = `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(uploadName)}`;
  const timeoutSeconds = Math.max(1, Math.ceil(UPLOAD_TIMEOUT_MS / 1000));
  const result = spawnSync(
    "curl",
    buildCurlUploadArgs({
      uploadUrl,
      assetPath,
      token,
      size,
      timeoutSeconds,
      speedLimitBytes: STALL_SPEED_LIMIT_BYTES,
      speedTimeSeconds: STALL_SPEED_TIME_SECONDS,
    }),
    {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const signal = result.signal ? ` signal=${result.signal}` : "";
    const error = new Error(`curl upload failed with exit code ${result.status}${signal}: ${result.stderr.trim()}`);
    error.retryable = true;
    throw error;
  }

  const output = result.stdout;
  const statusIndex = output.lastIndexOf("\n");
  const body = statusIndex === -1 ? "" : output.slice(0, statusIndex);
  const status = Number(statusIndex === -1 ? output : output.slice(statusIndex + 1));

  if (status >= 200 && status < 300) {
    console.log(`Uploaded ${uploadName}`);
    return JSON.parse(body);
  }

  if (status === 422 && /already_exists|already exists/i.test(body)) {
    await deleteExistingAssetByName(releaseId, uploadName);
    throw new RetryableHttpError(`Upload ${uploadName} hit an existing asset name after a partial attempt`, status);
  }

  if (shouldRetryStatus(status)) {
    throw new RetryableHttpError(`Upload ${uploadName} failed: ${status} ${body}`, status);
  }

  throw new Error(`Upload ${uploadName} failed: ${status} ${body}`);
}

async function uploadAsset(releaseId, assetPath, uploadName = basename(assetPath)) {
  const size = statSync(assetPath).size;
  console.log(`Uploading ${uploadName} (${size} bytes)`);
  const canUseCurl = process.env.GITHUB_RELEASE_UPLOAD_TRANSPORT !== "fetch" && hasCommand("curl");
  return await withRetry(`Upload ${uploadName}`, async () => {
    if (canUseCurl) {
      return await uploadAssetWithCurl(releaseId, assetPath, uploadName);
    }

    const { response, text } = await fetchText(
      `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(uploadName)}`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Length": String(size),
          "Content-Type": "application/octet-stream",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: createReadStream(assetPath),
        duplex: "half",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      },
    );

    if (response.ok) {
      console.log(`Uploaded ${uploadName}`);
      return JSON.parse(text);
    }

    if (response.status === 422 && /already_exists|already exists/i.test(text)) {
      await deleteExistingAssetByName(releaseId, uploadName);
      throw new RetryableHttpError(`Upload ${uploadName} hit an existing asset name after a partial attempt`, response.status);
    }

    if (shouldRetryStatus(response.status)) {
      throw new RetryableHttpError(`Upload ${uploadName} failed: ${response.status} ${text}`, response.status);
    }

    throw new Error(`Upload ${uploadName} failed: ${response.status} ${text}`);
  });
}

async function renameAsset(assetId, fromName, toName) {
  await github(`/repos/${owner}/${repo}/releases/assets/${assetId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: toName }),
  });
  console.log(`Renamed ${fromName} to ${toName}`);
}

function temporaryAssetName(name) {
  const runPart = process.env.GITHUB_RUN_ID ? `run-${process.env.GITHUB_RUN_ID}` : `pid-${process.pid}`;
  const attemptPart = process.env.GITHUB_RUN_ATTEMPT ? `attempt-${process.env.GITHUB_RUN_ATTEMPT}` : Date.now().toString(36);
  return `${name}.uploading-${runPart}-${attemptPart}`;
}

async function getOptionalGitHubResource(url, description) {
  return withRetry(description, async () => {
    const result = await fetchText(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (result.response.status !== 404 && !result.response.ok && shouldRetryStatus(result.response.status)) {
      throw new RetryableHttpError(`${description} failed: ${result.response.status} ${result.text}`, result.response.status);
    }
    return result;
  });
}

async function findRelease() {
  const { response, text } = await getOptionalGitHubResource(`https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`, `GET release ${tag}`);

  if (response.status === 404) {
    const releases = await github(`/repos/${owner}/${repo}/releases?per_page=100`);
    return releases.find((item) => item.tag_name === tag) ?? null;
  }

  if (!response.ok) {
    throw new Error(`GET release ${tag} failed: ${response.status} ${text}`);
  }
  return JSON.parse(text);
}

async function ensureTagRef(release) {
  const getRefPath = `/repos/${owner}/${repo}/git/ref/tags/${encodeURIComponent(tag)}`;
  const updateRefPath = `/repos/${owner}/${repo}/git/refs/tags/${encodeURIComponent(tag)}`;
  const { response, text } = await getOptionalGitHubResource(`https://api.github.com${getRefPath}`, `GET tag ${tag}`);

  if (response.status === 404) {
    await github(`/repos/${owner}/${repo}/git/refs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ref: `refs/tags/${tag}`,
        sha: process.env.GITHUB_SHA,
      }),
    });
    console.log(`Created tag ${tag}`);
    return;
  }

  if (!response.ok) {
    throw new Error(`GET tag ${tag} failed: ${response.status} ${text}`);
  }

  const existingRef = JSON.parse(text);

  if (immutableVersion) {
    assertImmutableTagCanBeUsed({
      release,
      tag,
      tagExists: true,
      transactionId: releaseTransactionId,
    });

    if (existingRef?.object?.type === "tag") {
      const tagObjectSha = existingRef.object.sha;
      if (!/^[0-9a-f]{40}$/iu.test(tagObjectSha ?? "")) {
        throw new Error(`Annotated tag ${tag} returned an invalid Git tag object id.`);
      }
      const tagObject = await github(
        `/repos/${owner}/${repo}/git/tags/${encodeURIComponent(tagObjectSha)}`,
      );
      assertAnnotatedTagTargetsCommit({
        tag,
        expectedSha: process.env.GITHUB_SHA,
        tagObject,
      });
      console.log(`Preserved annotated tag ${tag} at ${process.env.GITHUB_SHA}`);
      return;
    }
  }

  // Retarget unpublished draft/orphan tags to this commit so a later run can
  // finish the same product version. Published tags never reach here.
  const retargetUnpublished =
    immutableVersion && (!release || release.draft === true);

  if (forceTag || retargetUnpublished) {
    await github(updateRefPath, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sha: process.env.GITHUB_SHA,
        force: true,
      }),
    });
    console.log(
      retargetUnpublished && !forceTag
        ? `Retargeted unpublished tag ${tag} to ${process.env.GITHUB_SHA}`
        : `Updated tag ${tag}`,
    );
  }
}

let release = await findRelease();
if (immutableVersion) {
  assertImmutableReleaseTransaction({
    release,
    tag,
    transactionId: releaseTransactionId,
  });
}

if (updateMetadata || forceTag) {
  await ensureTagRef(release);
}

const releaseNotes = immutableVersion
  ? releaseNotesWithTransaction(process.env.RELEASE_NOTES, releaseTransactionId)
  : process.env.RELEASE_NOTES;
const releaseBody = {
  tag_name: tag,
  target_commitish: process.env.GITHUB_SHA,
  name: process.env.RELEASE_TITLE,
  body: releaseNotes,
  draft: draftRelease || publishAfterUpload,
  prerelease: process.env.RELEASE_PRERELEASE === "true",
};

if (release) {
  if (updateMetadata) {
    release = await github(`/repos/${owner}/${repo}/releases/${release.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(releaseBody),
    });
    console.log(`Updated release ${tag}`);
  }
} else {
  if (!updateMetadata) {
    throw new Error(`Release not found: ${tag}`);
  }
  release = await github(`/repos/${owner}/${repo}/releases`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(releaseBody),
  });
  console.log(`Created release ${tag}`);
}

for (const asset of release.assets ?? []) {
  if (deleteAssetNames.has(asset.name)) {
    await github(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: "DELETE" });
    console.log(`Deleted requested ${asset.name}`);
  }
}

if (deleteAssetNames.size > 0 || !release.assets) {
  release = await github(`/repos/${owner}/${repo}/releases/${release.id}`);
}
const existingAssetsByName = new Map((release.assets ?? []).map((asset) => [asset.name, asset]));

// Upload the binaries first and confirm every one is in place before touching
// the update manifest. latest-mac.yml is what electron-updater reads to decide
// what to download, so it must only appear (or change) once the binaries it
// points at are all present. Otherwise a partial/failed upload can leave a
// manifest referencing assets that do not exist yet.
const manifestAssetPaths = assetPaths.filter((assetPath) => isUpdateManifestAsset(basename(assetPath)));
const binaryAssetPaths = assetPaths.filter((assetPath) => !isUpdateManifestAsset(basename(assetPath)));

await uploadAssets(binaryAssetPaths);
assertAssetsPresent(
  await github(`/repos/${owner}/${repo}/releases/${release.id}`),
  binaryAssetPaths.map((assetPath) => basename(assetPath)),
  "before uploading the update manifest"
);
await uploadAssets(manifestAssetPaths);

if (!keepStaleAssets) {
  release = await github(`/repos/${owner}/${repo}/releases/${release.id}`);
  for (const asset of release.assets ?? []) {
    if (!expectedAssetNames.has(asset.name)) {
      await github(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { method: "DELETE" });
      console.log(`Deleted stale ${asset.name}`);
    }
  }
}

release = await github(`/repos/${owner}/${repo}/releases/${release.id}`);
assertExpectedAssets(release);

if (publishAfterUpload) {
  assertAssetsPresent(
    release,
    requiredAssetNames.size > 0 ? [...requiredAssetNames] : [...expectedAssetNames],
    "before publishing",
  );
  release = await github(`/repos/${owner}/${repo}/releases/${release.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...releaseBody,
      draft: false,
    }),
  });
  console.log(`Published release ${tag} after asset verification`);
}

function assertExpectedAssets(release) {
  if (expectedAssetNames.size === 0) return;
  assertAssetsPresent(release, [...expectedAssetNames]);
}

function assertAssetsPresent(release, names, context = "") {
  if (names.length === 0) return;

  const actualAssetNames = new Set((release.assets ?? []).map((asset) => asset.name));
  const missing = names.filter((name) => !actualAssetNames.has(name));
  if (missing.length > 0) {
    const suffix = context ? ` ${context}` : "";
    throw new Error(`Release ${tag} is missing expected assets${suffix}: ${missing.join(", ")}`);
  }
}

function isUpdateManifestAsset(name) {
  return /^latest(-[a-z0-9]+)?\.ya?ml$/i.test(name);
}

async function uploadAssets(paths) {
  const replacementUploads = [];

  for (const assetPath of paths) {
    const name = basename(assetPath);
    const existing = existingAssetsByName.get(name);

    if (!existing) {
      await uploadAsset(release.id, assetPath, name);
      continue;
    }

    const temporaryName = temporaryAssetName(name);
    const temporaryAsset = await uploadAsset(release.id, assetPath, temporaryName);
    replacementUploads.push({ existing, temporaryAsset, temporaryName, name });
  }

  for (const replacement of replacementUploads) {
    await github(`/repos/${owner}/${repo}/releases/assets/${replacement.existing.id}`, { method: "DELETE" });
    console.log(`Deleted previous ${replacement.name}`);
    await renameAsset(replacement.temporaryAsset.id, replacement.temporaryName, replacement.name);
  }
}
