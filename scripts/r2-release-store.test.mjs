import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import {
  buildManifest,
  downloadDirectory,
  downloadLatestAttempt,
  mapWithConcurrency,
  normalizeRelativeObjectName,
  publishChannel,
  R2_MULTIPART_PART_SIZE_BYTES,
  R2_MULTIPART_QUEUE_SIZE,
  R2_MULTIPART_THRESHOLD_BYTES,
  R2_RELEASE_MANIFEST,
  resolveR2S3Configuration,
  sealRelease,
  uploadReleasePart,
  runWrangler,
  shouldUseR2Multipart,
  uploadObjectMultipart,
  uploadTimeoutMs,
  uploadObject,
  uploadDirectory,
  wranglerInvocation,
} from "./r2-release-store.mjs";

function captureReleaseEnv(extra = {}) {
  return { ...extra, ...Object.fromEntries([
    "XMATRIX_RELEASE_TAG",
    "XMATRIX_RELEASE_COMPONENT",
    "XMATRIX_RELEASE_CHANNEL",
    "XMATRIX_RELEASE_SHA",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
  ].map((key) => [key, process.env[key]])) };
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("bounded release transfers preserve order and finish active work", async () => {
  let active = 0;
  let maximumActive = 0;
  const completed = [];
  const results = await mapWithConcurrency([30, 5, 15, 1], 2, async (delay) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, delay));
    completed.push(delay);
    active -= 1;
    return delay * 2;
  });
  assert.equal(maximumActive, 2);
  assert.deepEqual(results, [60, 10, 30, 2]);
  assert.deepEqual(completed.toSorted((left, right) => left - right), [1, 5, 15, 30]);
});

test("a stalled Wrangler process is terminated at the operation deadline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-timeout-test-"));
  const mockWrangler = path.join(root, "mock-wrangler.mjs");
  const priorCommand = process.env.XMATRIX_WRANGLER_COMMAND;
  try {
    await writeFile(
      mockWrangler,
      "#!/usr/bin/env node\nsetInterval(() => {}, 60_000);\n",
    );
    await chmod(mockWrangler, 0o700);
    process.env.XMATRIX_WRANGLER_COMMAND = mockWrangler;
    const startedAt = Date.now();
    const result = await runWrangler(["r2", "bucket", "list"], { capture: true, timeoutMs: 50 });
    assert.equal(result.code, -1);
    assert.match(result.stderr, /Wrangler timed out after 50ms/u);
    assert.ok(Date.now() - startedAt < 2_000);
  } finally {
    if (priorCommand === undefined) delete process.env.XMATRIX_WRANGLER_COMMAND;
    else process.env.XMATRIX_WRANGLER_COMMAND = priorCommand;
    await rm(root, { recursive: true, force: true });
  }
});

test("release object names reject traversal and ambiguous segments", () => {
  for (const value of ["", ".", "..", "../file", "a/../file", "/absolute", "a//file", "a\\file"]) {
    assert.throws(() => normalizeRelativeObjectName(value));
  }
  assert.equal(normalizeRelativeObjectName("mac/xMatrix.dmg"), "mac/xMatrix.dmg");
});

test("default Wrangler launch is version-pinned and does not require pnpm", () => {
  const localWranglerCli = "/workspace/node_modules/wrangler/bin/wrangler.js";
  assert.deepEqual(
    wranglerInvocation(["r2", "bucket", "list"], {
      customCommand: "",
      nodeExecutable: "/opt/node/bin/node",
      localWranglerCli,
      fileExists: (candidate) => candidate === localWranglerCli,
    }),
    {
      command: "/opt/node/bin/node",
      args: [localWranglerCli, "r2", "bucket", "list"],
    }
  );
  assert.deepEqual(
    wranglerInvocation(["r2", "bucket", "list"], {
      customCommand: "",
      platform: "linux",
      nodeExecutable: "/opt/node/bin/node",
      localWranglerCli: "",
      npxCli: "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
    }),
    {
      command: "/opt/node/bin/node",
      args: [
        "/opt/node/lib/node_modules/npm/bin/npx-cli.js",
        "--yes",
        "wrangler@4.79.0",
        "r2",
        "bucket",
        "list",
      ],
    }
  );
  assert.deepEqual(
    wranglerInvocation(["r2", "bucket", "list"], {
      customCommand: "",
      platform: "win32",
      nodeExecutable: "C:\\node\\node.exe",
      localWranglerCli: "",
      npxCli: "C:\\node\\node_modules\\npm\\bin\\npx-cli.js",
    }),
    {
      command: "C:\\node\\node.exe",
      args: [
        "C:\\node\\node_modules\\npm\\bin\\npx-cli.js",
        "--yes",
        "wrangler@4.79.0",
        "r2",
        "bucket",
        "list",
      ],
    }
  );
});

test("R2 multipart configuration is all-or-nothing and bucket-endpoint scoped", () => {
  assert.equal(resolveR2S3Configuration({ CLOUDFLARE_ACCOUNT_ID: "account" }), null);
  assert.throws(
    () =>
      resolveR2S3Configuration({
        CLOUDFLARE_ACCOUNT_ID: "account",
        R2_RELEASE_ACCESS_KEY_ID: "access",
      }),
    /requires CLOUDFLARE_ACCOUNT_ID, R2_RELEASE_ACCESS_KEY_ID, and R2_RELEASE_SECRET_ACCESS_KEY together/u,
  );
  assert.deepEqual(
    resolveR2S3Configuration({
      CLOUDFLARE_ACCOUNT_ID: " account ",
      R2_RELEASE_ACCESS_KEY_ID: " access ",
      R2_RELEASE_SECRET_ACCESS_KEY: " secret ",
    }),
    {
      region: "auto",
      endpoint: "https://account.r2.cloudflarestorage.com",
      credentials: { accessKeyId: "access", secretAccessKey: "secret" },
      maxAttempts: 5,
    },
  );
});

test("large R2 objects use bounded streaming multipart uploads when credentials exist", async () => {
  const configuration = resolveR2S3Configuration({
    CLOUDFLARE_ACCOUNT_ID: "account",
    R2_RELEASE_ACCESS_KEY_ID: "access",
    R2_RELEASE_SECRET_ACCESS_KEY: "secret",
  });
  assert.equal(shouldUseR2Multipart(R2_MULTIPART_THRESHOLD_BYTES - 1, configuration), true);
  assert.throws(() => shouldUseR2Multipart(R2_MULTIPART_THRESHOLD_BYTES, null), /Required R2 S3/u);
  assert.equal(shouldUseR2Multipart(R2_MULTIPART_THRESHOLD_BYTES, configuration), true);

  let clientConfiguration;
  let clientDestroyed = false;
  let uploadConfiguration;
  let completed = false;
  class FakeS3Client {
    constructor(value) {
      clientConfiguration = value;
    }

    destroy() {
      clientDestroyed = true;
    }
  }
  class FakeUpload {
    constructor(value) {
      uploadConfiguration = value;
    }

    async done() {
      completed = true;
    }
  }
  const body = { stream: true };
  await uploadObjectMultipart(
    {
      bucket: "xmatrix-release-assets",
      key: "handoffs/desktop/123/2/macos/xMatrix.dmg",
      source: "/release/xMatrix.dmg",
      expected: { name: "xMatrix.dmg", size: R2_MULTIPART_THRESHOLD_BYTES },
      configuration,
    },
    {
      S3ClientClass: FakeS3Client,
      UploadClass: FakeUpload,
      createReadStreamFunction: () => body,
    },
  );
  assert.deepEqual(clientConfiguration, configuration);
  assert.equal(uploadConfiguration.params.Bucket, "xmatrix-release-assets");
  assert.equal(uploadConfiguration.params.Key, "handoffs/desktop/123/2/macos/xMatrix.dmg");
  assert.equal(uploadConfiguration.params.Body, body);
  assert.equal(uploadConfiguration.params.ContentType, "application/x-apple-diskimage");
  assert.equal(uploadConfiguration.partSize, R2_MULTIPART_PART_SIZE_BYTES);
  assert.equal(uploadConfiguration.queueSize, R2_MULTIPART_QUEUE_SIZE);
  assert.equal(uploadConfiguration.leavePartsOnError, false);
  assert.equal(completed, true);
  assert.equal(clientDestroyed, true);
});

test("a stalled R2 upload attempt is aborted at its deadline so the retry can run", async () => {
  assert.ok(uploadTimeoutMs(0) >= 60_000);
  assert.ok(uploadTimeoutMs(200 * 1024 * 1024) > uploadTimeoutMs(0));
  let aborted = false;
  let clientDestroyed = false;
  class FakeS3Client {
    destroy() {
      clientDestroyed = true;
    }
  }
  class StalledUpload {
    done() {
      return new Promise((_, reject) => {
        this.reject = reject;
      });
    }

    async abort() {
      aborted = true;
      this.reject(new Error("Upload aborted."));
    }
  }
  await assert.rejects(
    uploadObjectMultipart(
      {
        bucket: "xmatrix-release-assets",
        key: "handoffs/cli/1/1/macos/xmatrix",
        source: "/release/xmatrix",
        expected: { name: "xmatrix", size: 128 },
        configuration: { endpoint: "https://example.invalid" },
        timeoutMs: 20,
      },
      { S3ClientClass: FakeS3Client, UploadClass: StalledUpload, createReadStreamFunction: () => ({}) },
    ),
    /handoffs\/cli\/1\/1\/macos\/xmatrix timed out after 20ms/u,
  );
  assert.equal(aborted, true);
  assert.equal(clientDestroyed, true);
  const result = await uploadObject("bucket", "key", "file", { name: "file", size: 1 }, {
    configuration: { endpoint: "https://example.invalid" },
    uploadS3: (options) => uploadObjectMultipart(
      { ...options, timeoutMs: 20 },
      { S3ClientClass: FakeS3Client, UploadClass: StalledUpload, createReadStreamFunction: () => ({}) },
    ),
  });
  assert.equal(result.code, -1);
  assert.match(result.stderr, /timed out after 20ms/u);
});

test("required S3 uploads include small CLI artifacts and never fall back to Wrangler", async () => {
  const configuration = { endpoint: "https://example.invalid" };
  let calls = 0;
  const options = {
    configuration,
    uploadS3: async () => { calls += 1; },
  };
  for (const size of [0, 128, R2_MULTIPART_THRESHOLD_BYTES - 1, R2_MULTIPART_THRESHOLD_BYTES]) {
    const result = await uploadObject("bucket", "key", "file", { name: "file", size }, options);
    assert.equal(result.code, 0);
  }
  assert.equal(calls, 4);
  await assert.rejects(() => uploadObject("bucket", "key", "file", { size: 1 }, {
    ...options, configuration: null,
  }), /Required R2 S3 upload credentials/u);
  const failure = await uploadObject("bucket", "key", "file", { size: 1 }, {
    ...options, uploadS3: async () => { throw new Error("upload failed"); },
  });
  assert.equal(failure.code, -1);
  assert.match(failure.stderr, /upload failed/u);
});

test("release manifests are deterministic, recursive, and bind provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-manifest-test-"));
  const prior = captureReleaseEnv();
  try {
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "z.txt"), "z\n");
    await writeFile(path.join(root, "nested", "a.json"), "{}\n");
    await writeFile(path.join(root, R2_RELEASE_MANIFEST), "stale manifest");
    Object.assign(process.env, {
      XMATRIX_RELEASE_TAG: "cli-v1.2.3",
      XMATRIX_RELEASE_COMPONENT: "cli",
      XMATRIX_RELEASE_CHANNEL: "stable",
      XMATRIX_RELEASE_SHA: "a".repeat(40),
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "2",
    });
    const manifest = await buildManifest({
      bucket: "xmatrix-release-assets",
      prefix: "releases/cli-v1.2.3",
      directory: root,
    });
    assert.deepEqual(
      manifest.files.map((file) => file.name),
      ["nested/a.json", "z.txt"]
    );
    assert.equal(manifest.releaseTag, "cli-v1.2.3");
    assert.equal(manifest.component, "cli");
    assert.equal(manifest.channel, "stable");
    assert.equal(manifest.commitSha, "a".repeat(40));
    assert.equal(manifest.runId, "123");
    assert.equal("runAttempt" in manifest, false);
    assert.ok(manifest.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)));
  } finally {
    restoreEnv(prior);
    await rm(root, { recursive: true, force: true });
  }
});

// A local R2: uploads copy into objectRoot and reads go through a mock Wrangler.
async function withLocalR2(run) {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-smoke-test-"));
  const source = path.join(root, "source");
  const objectRoot = path.join(root, "objects");
  const uploadOptions = {
    configuration: { endpoint: "https://example.invalid" },
    uploadS3: async ({ bucket, key, source: file }) => {
      const stored = path.join(objectRoot, bucket, ...key.split("/"));
      await mkdir(path.dirname(stored), { recursive: true });
      await copyFile(file, stored);
    },
  };
  const mockWrangler = path.join(root, "mock-wrangler.mjs");
  const prior = captureReleaseEnv({
    XMATRIX_WRANGLER_COMMAND: process.env.XMATRIX_WRANGLER_COMMAND,
    MOCK_R2_ROOT: process.env.MOCK_R2_ROOT,
    R2_RELEASE_ACCESS_KEY_ID: process.env.R2_RELEASE_ACCESS_KEY_ID,
    R2_RELEASE_SECRET_ACCESS_KEY: process.env.R2_RELEASE_SECRET_ACCESS_KEY,
  });
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "asset.bin"), "verified release bytes\n");
    await writeFile(
      mockWrangler,
      `#!/usr/bin/env node
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
const operation = args[2];
const object = args[3];
const file = args[args.indexOf("--file") + 1];
const stored = path.join(process.env.MOCK_R2_ROOT, ...object.split("/"));
if (operation === "get") {
  try { await mkdir(path.dirname(file), { recursive: true }); await copyFile(stored, file); }
  catch { console.error("NoSuchKey"); process.exitCode = 1; }
} else { throw new Error("unsupported mock operation"); }
`
    );
    await chmod(mockWrangler, 0o700);
    Object.assign(process.env, {
      XMATRIX_WRANGLER_COMMAND: mockWrangler,
      MOCK_R2_ROOT: objectRoot,
      R2_RELEASE_ACCESS_KEY_ID: "",
      R2_RELEASE_SECRET_ACCESS_KEY: "",
      XMATRIX_RELEASE_TAG: "cli-v1.2.3",
      XMATRIX_RELEASE_COMPONENT: "cli",
      XMATRIX_RELEASE_CHANNEL: "stable",
      XMATRIX_RELEASE_SHA: "b".repeat(40),
      GITHUB_RUN_ID: "456",
      GITHUB_RUN_ATTEMPT: "1",
    });
    await run({ root, source, objectRoot, uploadOptions });
  } finally {
    restoreEnv(prior);
    await rm(root, { recursive: true, force: true });
  }
}

test("local R2 smoke uploads, read-verifies, retries idempotently, and downloads", () =>
  withLocalR2(async ({ root, source, uploadOptions }) => {
    const destination = path.join(root, "download");
    const assetOnlyDestination = path.join(root, "download-assets-only");
    const uploadLocalDirectory = (options) => uploadDirectory(options, uploadOptions);
    await uploadLocalDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "releases/cli-v1.2.3",
      directory: source,
    });
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await uploadLocalDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "releases/cli-v1.2.3",
      directory: source,
    });
    await downloadDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "releases/cli-v1.2.3",
      directory: destination,
    });
    assert.equal(await readFile(path.join(destination, "asset.bin"), "utf8"), "verified release bytes\n");
    assert.equal(
      JSON.parse(await readFile(path.join(destination, R2_RELEASE_MANIFEST), "utf8")).prefix,
      "releases/cli-v1.2.3"
    );
    await downloadDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "releases/cli-v1.2.3",
      directory: assetOnlyDestination,
      excludeManifest: true,
    });
    assert.equal(
      await readFile(path.join(assetOnlyDestination, "asset.bin"), "utf8"),
      "verified release bytes\n"
    );
    await assert.rejects(readFile(path.join(assetOnlyDestination, R2_RELEASE_MANIFEST), "utf8"), /ENOENT/u);

    await uploadLocalDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "handoffs/desktop/456/1/macos",
      directory: source,
    });
    const macosRecovery = {
      bucket: "xmatrix-release-assets",
      prefix: "handoffs/desktop/456",
      suffix: "macos",
      attempt: "3",
      directory: destination,
      excludeManifest: true,
    };
    const recovered = await downloadLatestAttempt(macosRecovery);
    assert.equal(recovered.attempt, 1);
    assert.equal(recovered.prefix, "handoffs/desktop/456/1/macos");
    assert.equal(await readFile(path.join(destination, "asset.bin"), "utf8"), "verified release bytes\n");
    await assert.rejects(readFile(path.join(destination, R2_RELEASE_MANIFEST), "utf8"), /ENOENT/u);

    await uploadLocalDirectory({
      bucket: "xmatrix-release-assets",
      prefix: "handoffs/desktop/456/2/macos",
      directory: source,
    });
    const newest = await downloadLatestAttempt(macosRecovery);
    assert.equal(newest.attempt, 2);
    await assert.rejects(
      downloadLatestAttempt({
        bucket: "xmatrix-release-assets",
        prefix: "handoffs/desktop/456",
        suffix: "windows",
        attempt: "3",
        directory: destination,
      }),
      /No complete windows handoff exists through run attempt 3/u,
    );
  }));

test("build machines publish release parts directly and sealing names the newest attempts", () =>
  withLocalR2(async ({ root, objectRoot, uploadOptions }) => {
    const bucket = "xmatrix-release-assets";
    const prefix = "releases/cli-v1.2.3";
    const macos = path.join(root, "macos");
    const windows = path.join(root, "windows");
    await mkdir(macos, { recursive: true });
    await mkdir(windows, { recursive: true });
    await writeFile(path.join(macos, "xmatrix-macos-arm64"), "macos attempt 1\n");
    await writeFile(path.join(windows, "xmatrix-windows-x64.exe"), "windows attempt 1\n");
    await uploadReleasePart({ bucket, prefix, part: "macos-arm64", directory: macos }, uploadOptions);
    await uploadReleasePart({ bucket, prefix, part: "windows-x64", directory: windows }, uploadOptions);
    // A rerun re-signs the macOS binary: new bytes land beside attempt 1, never over it.
    process.env.GITHUB_RUN_ATTEMPT = "2";
    await writeFile(path.join(macos, "xmatrix-macos-arm64"), "macos attempt 2\n");
    await uploadReleasePart({ bucket, prefix, part: "macos-arm64", directory: macos }, uploadOptions);

    await assert.rejects(
      sealRelease({ bucket, prefix, parts: "macos-arm64,linux-x64" }, uploadOptions),
      /No complete linux-x64 release part exists through run attempt 2/u,
    );
    const sealed = await sealRelease(
      { bucket, prefix, parts: "macos-arm64,windows-x64", checksums: true },
      uploadOptions,
    );
    assert.deepEqual(
      sealed.files.map((file) => [file.name, file.key]),
      [
        ["checksums.txt", `${prefix}/parts/checksums/456-2/checksums.txt`],
        ["xmatrix-macos-arm64", `${prefix}/parts/macos-arm64/456-2/xmatrix-macos-arm64`],
        ["xmatrix-windows-x64.exe", `${prefix}/parts/windows-x64/456-1/xmatrix-windows-x64.exe`],
      ],
    );
    const checksums = await readFile(
      path.join(objectRoot, bucket, ...`${prefix}/parts/checksums/456-2/checksums.txt`.split("/")),
      "utf8",
    );
    assert.match(checksums, /^[0-9a-f]{64} {2}xmatrix-macos-arm64\n[0-9a-f]{64} {2}xmatrix-windows-x64\.exe\n$/u);

    const destination = path.join(root, "download");
    await downloadDirectory({ bucket, prefix, directory: destination, excludeManifest: true });
    assert.equal(await readFile(path.join(destination, "xmatrix-macos-arm64"), "utf8"), "macos attempt 2\n");
    const single = path.join(root, "download-single");
    await downloadDirectory({ bucket, prefix, directory: single, excludeManifest: true, only: "xmatrix-macos-arm64" });
    assert.deepEqual(await readdir(single), ["xmatrix-macos-arm64"]);
    await assert.rejects(
      downloadDirectory({ bucket, prefix, directory: single, only: "xmatrix-linux-x64" }),
      /names no file xmatrix-linux-x64/u,
    );

    // Sealed is final: a later attempt cannot change what the release names.
    process.env.GITHUB_RUN_ATTEMPT = "3";
    await writeFile(path.join(macos, "xmatrix-macos-arm64"), "macos attempt 3\n");
    await uploadReleasePart({ bucket, prefix, part: "macos-arm64", directory: macos }, uploadOptions);
    assert.deepEqual(await sealRelease({ bucket, prefix, parts: "macos-arm64,windows-x64" }, uploadOptions), sealed);
  }));

test("trains publish to dev, promotion points stable at the same sealed release, and channels never move back", () =>
  withLocalR2(async ({ root, objectRoot, uploadOptions }) => {
    const bucket = "xmatrix-release-assets";
    for (const version of ["1.2.3", "1.2.4"]) {
      const directory = path.join(root, version);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "xmatrix-linux-x64"), `cli ${version}\n`);
      process.env.XMATRIX_RELEASE_TAG = `cli-v${version}`;
      await uploadDirectory({ bucket, prefix: `releases/cli-v${version}`, directory }, uploadOptions);
    }
    const pointer = async (channel) =>
      JSON.parse(await readFile(path.join(objectRoot, bucket, "channels", "cli", `${channel}.json`), "utf8"));
    const publish = (channel, version) =>
      publishChannel({ bucket, component: "cli", channel, prefix: `releases/cli-v${version}` }, uploadOptions);

    await publish("dev", "1.2.4");
    await assert.rejects(readFile(path.join(objectRoot, bucket, "channels", "cli", "stable.json")), /ENOENT/u);
    await publish("stable", "1.2.4");
    const [dev, stable] = [await pointer("dev"), await pointer("stable")];
    assert.equal(stable.prefix, dev.prefix);
    assert.deepEqual(stable.files, dev.files);
    await publish("dev", "1.2.4");
    await assert.rejects(publish("dev", "1.2.3"), /already names cli-v1\.2\.4; refusing to move it back to cli-v1\.2\.3/u);
    assert.equal((await pointer("dev")).releaseTag, "cli-v1.2.4");
  }));

test("probe and readback timeouts keep their phase and drop credential evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xmatrix-r2-phase-test-"));
  const source = path.join(root, "source");
  const prior = captureReleaseEnv({
    CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    R2_RELEASE_ACCESS_KEY_ID: process.env.R2_RELEASE_ACCESS_KEY_ID,
    R2_RELEASE_SECRET_ACCESS_KEY: process.env.R2_RELEASE_SECRET_ACCESS_KEY,
    XMATRIX_WRANGLER_COMMAND: process.env.XMATRIX_WRANGLER_COMMAND,
    MOCK_R2_MODE: process.env.MOCK_R2_MODE,
    MOCK_R2_COUNT: process.env.MOCK_R2_COUNT,
    MOCK_R2_ROOT: process.env.MOCK_R2_ROOT,
  });
  const secret = "rawsecretvalue";
  const progress = "Downloaded 12 MiB";
  let uploads = 0;
  const uploadLocalDirectory = (extra = {}) => uploadDirectory({
    bucket: "xmatrix-release-assets",
    prefix: "handoffs/cli/456/1/macos-arm64",
    directory: source,
  }, {
    configuration: { endpoint: "https://example.invalid" },
    verificationTimeoutMs: 40,
    uploadS3: async () => {
      uploads += 1;
    },
    ...extra,
  });
  const assertDiagnostic = (error, phase, timeoutMs = 40) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, new RegExp(`R2 ${phase} download `));
    assert.match(message, /failed after 3 attempts/u);
    assert.match(message, new RegExp(`timed out after ${timeoutMs}ms`));
    assert.match(message, new RegExp(progress));
    assert.equal(message.includes(secret), false);
    assert.equal(message.includes("super-secret-token"), false);
    assert.equal(message.includes("tok_123"), false);
    assert.equal(message.includes("x-amz-security-token"), false);
    assert.ok(message.length < 1_500);
  };
  try {
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "xmatrix-macos-arm64"), "verified release bytes\n");
    Object.assign(process.env, {
      CLOUDFLARE_ACCOUNT_ID: "account",
      R2_RELEASE_ACCESS_KEY_ID: "access",
      R2_RELEASE_SECRET_ACCESS_KEY: secret,
      XMATRIX_RELEASE_TAG: "cli-v1.2.3",
      XMATRIX_RELEASE_COMPONENT: "cli-handoff",
      XMATRIX_RELEASE_CHANNEL: "stable",
      XMATRIX_RELEASE_SHA: "c".repeat(40),
      GITHUB_RUN_ID: "456",
    });

    let sends = 0;
    const hangUntilAbort = (abortSignal) => new Promise((_resolve, reject) => {
      const abort = () => reject(new Error(`${progress}\nAuthorization: Bearer super-secret-token\nR2_RELEASE_SECRET_ACCESS_KEY=${secret}\nCLOUDFLARE_API_TOKEN=tok_123\n{"headers":{"x-amz-security-token":"abc"}}`));
      if (abortSignal.aborted) abort();
      else abortSignal.addEventListener("abort", abort, { once: true });
    });
    class HangingClient {
      destroy() {}

      async send(_command, { abortSignal }) {
        sends += 1;
        await hangUntilAbort(abortSignal);
      }
    }
    uploads = 0;
    sends = 0;
    await assert.rejects(
      uploadLocalDirectory({ S3ClientClass: HangingClient }),
      (error) => {
        assertDiagnostic(error, "probe");
        return true;
      },
    );
    assert.equal(uploads, 0);
    assert.equal(sends, 3);

    class MissingThenHangClient {
      destroy() {}

      async send(_command, { abortSignal }) {
        sends += 1;
        if (sends === 1) {
          const missing = new Error("The specified key does not exist");
          missing.name = "NoSuchKey";
          missing.$metadata = { httpStatusCode: 404 };
          throw missing;
        }
        await hangUntilAbort(abortSignal);
      }
    }
    uploads = 0;
    sends = 0;
    await assert.rejects(
      uploadLocalDirectory({ S3ClientClass: MissingThenHangClient }),
      (error) => {
        assertDiagnostic(error, "readback");
        return true;
      },
    );
    assert.equal(uploads, 1);
    assert.equal(sends, 4);

    class StoredClient {
      destroy() {}

      async send(command) {
        sends += 1;
        assert.equal(command.input.Bucket, "xmatrix-release-assets");
        const key = command.input.Key;
        if (key.endsWith("/xmatrix-macos-arm64")) {
          return { Body: Readable.from(["verified release bytes\n"]) };
        }
        if (stored.has(key)) return { Body: Readable.from([stored.get(key)]) };
        const missing = new Error("The specified key does not exist");
        missing.name = "NoSuchKey";
        missing.$metadata = { httpStatusCode: 404 };
        throw missing;
      }
    }
    const stored = new Map();
    uploads = 0;
    sends = 0;
    const manifest = await uploadLocalDirectory({
      S3ClientClass: StoredClient,
      verificationTimeoutMs: undefined,
      uploadS3: async ({ key, source: file }) => {
        uploads += 1;
        stored.set(key, await readFile(file));
      },
    });
    assert.equal(uploads, 1);
    assert.equal([...stored.keys()].every((key) => key.endsWith(`/${R2_RELEASE_MANIFEST}`)), true);
    assert.equal(sends, 3);
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.files.length, 1);
    assert.equal("runAttempt" in manifest, false);

    class CorruptClient {
      destroy() {}

      async send() {
        return { Body: Readable.from(["Xerified release bytes\n"]) };
      }
    }
    uploads = 0;
    await assert.rejects(
      uploadLocalDirectory({ S3ClientClass: CorruptClient, verificationTimeoutMs: undefined }),
      /SHA-256 mismatch/u,
    );
    assert.equal(uploads, 0);

    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.R2_RELEASE_ACCESS_KEY_ID;
    delete process.env.R2_RELEASE_SECRET_ACCESS_KEY;
    const countPath = path.join(root, "gets.txt");
    const mockWrangler = path.join(root, "mock-wrangler.mjs");
    await writeFile(mockWrangler, `#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
const countPath = process.env.MOCK_R2_COUNT;
let count = 0;
try { count = Number(await readFile(countPath, "utf8")); } catch {}
count += 1;
await writeFile(countPath, String(count));
const mode = process.env.MOCK_R2_MODE;
if (mode === "missing" && count === 1) {
  console.error("NoSuchKey");
  process.exitCode = 1;
} else {
  console.log(${JSON.stringify(progress)});
  console.error("Authorization: Bearer super-secret-token");
  console.error("R2_RELEASE_SECRET_ACCESS_KEY=${secret}");
  console.error("CLOUDFLARE_API_TOKEN=tok_123");
  setInterval(() => {}, 60_000);
}
`);
    await chmod(mockWrangler, 0o700);
    process.env.XMATRIX_WRANGLER_COMMAND = mockWrangler;
    process.env.MOCK_R2_COUNT = countPath;
    for (const scenario of [
      { mode: "hang", phase: "probe", uploaded: 0, gets: "3" },
      { mode: "missing", phase: "readback", uploaded: 1, gets: "4" },
    ]) {
      process.env.MOCK_R2_MODE = scenario.mode;
      await writeFile(countPath, "0");
      uploads = 0;
      await assert.rejects(
        uploadLocalDirectory({ verificationTimeoutMs: 1_000 }),
        (error) => {
          assertDiagnostic(error, scenario.phase, 1_000);
          return true;
        },
      );
      assert.equal(uploads, scenario.uploaded);
      assert.equal(await readFile(countPath, "utf8"), scenario.gets);
    }
  } finally {
    restoreEnv(prior);
    await rm(root, { recursive: true, force: true });
  }
});
