import assert from "node:assert/strict";
import test from "node:test";

import {
  parseUploadedVersionId,
  readServingVersion,
  rolloutHubCanary,
  uploadHubVersion,
  validateCanarySettings,
  watchCanary,
} from "./hub-canary-rollout.mjs";

const OLD_REVISION = "a".repeat(40);
const NEW_REVISION = "b".repeat(40);
const OLD_VERSION = "11111111-1111-4111-8111-111111111111";
const NEW_VERSION = "22222222-2222-4222-8222-222222222222";
const REVISIONS = { [OLD_VERSION]: OLD_REVISION, [NEW_VERSION]: NEW_REVISION };

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function health(serving) {
  return json({
    status: "ok",
    service: "xmatrix-hub",
    deployment: { versionId: serving.versionId, revision: REVISIONS[serving.versionId] },
  });
}

/**
 * A public Hub whose health names the version currently receiving 100% of
 * traffic; a `versions deploy <id>@100` moves it, exactly as production does.
 * Compatibility and PostgreSQL readiness answer their healthy shapes unless a
 * gate says otherwise.
 */
function fakeProduction({ serving = OLD_VERSION, gates = {} } = {}) {
  let current = { versionId: serving };
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.href : typeof input === "string" ? input : input.url);
    calls.push({ path: url.pathname, protocol: url.protocol });
    if (url.protocol === "http:") {
      if (gates.https === "broken") return new Response("not redirected", { status: 200 });
      return new Response(null, {
        status: 301,
        headers: { location: `https://${url.host}${url.pathname}${url.search}` },
      });
    }
    if (url.pathname === "/") {
      if (gates.health === "throw") throw new Error("connection refused");
      return health(current);
    }
    if (url.pathname === "/api/client-compatibility") {
      if (gates.compatibility === "reject") {
        return json({ compatible: true, code: "compatible", retryable: false }, 500);
      }
      const admitted = Boolean(init.headers?.["x-xmatrix-client-version"]);
      return admitted
        ? json({ compatible: true, code: "compatible", retryable: false })
        : json({ compatible: false, code: "client_upgrade_required", retryable: false }, 426);
    }
    if (url.pathname === "/health/postgres") {
      if (gates.postgres === "not-ready") {
        return json({ status: "starting", service: "xmatrix-postgres", cacheMode: "disabled" }, 503);
      }
      return json({ status: "ready", service: "xmatrix-postgres", cacheMode: "disabled" });
    }
    throw new Error(`unexpected request ${url.href}`);
  };
  const runWrangler = async (args) => {
    calls.push(args);
    if (args[0] === "versions" && args[1] === "deploy") {
      for (const spec of args.slice(2)) {
        if (!spec.includes("@")) continue;
        const [versionId, percentage] = spec.split("@");
        if (percentage === "100" && REVISIONS[versionId]) current = { versionId };
      }
    }
    if (args[0] === "versions" && args[1] === "upload") {
      return `Uploaded xmatrix-hub\nWorker Version ID: ${NEW_VERSION}\n`;
    }
    return "";
  };
  const deployed = () => calls.filter((args) => args[0] === "versions" && args[1] === "deploy");
  return { fetchImpl, runWrangler, calls, deployed };
}

function fakeClock(intervalMs = 1_000) {
  let time = 0;
  return {
    clock: () => time,
    delayImpl: async (milliseconds = intervalMs) => { time += milliseconds; },
  };
}

function state(overrides = {}) {
  return {
    config: "wrangler.generated.production.toml",
    expectedSha: NEW_REVISION,
    previous: { versionId: OLD_VERSION, revision: OLD_REVISION },
    versionId: NEW_VERSION,
    ...overrides,
  };
}

test("upload reports a Worker Version ID and refuses output without one", () => {
  assert.equal(parseUploadedVersionId(`Worker Version ID: ${NEW_VERSION}\n`), NEW_VERSION);
  assert.throws(() => parseUploadedVersionId("Uploaded xmatrix-hub\n"), /did not report/u);
  assert.throws(() => parseUploadedVersionId("Worker Version ID: not-a-uuid\n"), /did not report/u);
});

test("canary settings stay within a bounded rollout", () => {
  assert.deepEqual(validateCanarySettings({}), {
    canaryPercent: 10, windowMs: 180_000, intervalMs: 2_000, minNewSamples: 3,
  });
  assert.throws(() => validateCanarySettings({ canaryPercent: 0 }), /canary percent/u);
  assert.throws(() => validateCanarySettings({ canaryPercent: 60 }), /canary percent/u);
  assert.throws(() => validateCanarySettings({ windowMs: 1_000 }), /canary window/u);
  assert.throws(() => validateCanarySettings({ intervalMs: 60_000 }), /sample interval/u);
});

test("a Hub already splitting traffic refuses to name a rollback target", async () => {
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    return health({ versionId: call % 2 ? OLD_VERSION : NEW_VERSION });
  };
  await assert.rejects(
    readServingVersion({ url: "https://hub.example/", fetchImpl, delayImpl: async () => {} }),
    /already splits traffic/u,
  );
});

test("upload binds the tag, secrets file, bundle directory and defines", async () => {
  const hub = fakeProduction();
  const result = await uploadHubVersion({
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    config: "wrangler.generated.production.toml",
    tag: NEW_REVISION,
    secretsFile: "/tmp/secrets.json",
    outdir: "/tmp/bundle",
    defines: ["XMATRIX_SENTRY_DSN:\"https://example.invalid/1\""],
    runWrangler: hub.runWrangler,
    fetchImpl: hub.fetchImpl,
    delayImpl: async () => {},
  });
  assert.deepEqual(result.previous, { versionId: OLD_VERSION, revision: OLD_REVISION });
  assert.equal(result.versionId, NEW_VERSION);
  assert.equal(hub.calls.filter((args) => args[0] === "versions" && args[1] === "upload").length, 1);
  const args = hub.calls.find((call) => call[0] === "versions" && call[1] === "upload");
  assert.deepEqual(args.slice(0, 2), ["versions", "upload"]);
  for (const flag of ["--config", "--tag", "--secrets-file", "--outdir", "--define"]) {
    assert.ok(args.includes(flag), `upload passes ${flag}`);
  }
  assert.equal(args[args.indexOf("--tag") + 1], NEW_REVISION);
  assert.equal(args[args.indexOf("--define") + 1], "XMATRIX_SENTRY_DSN:\"https://example.invalid/1\"");
});

test("canary requires the new version to answer and pass its gates", async () => {
  const healthy = fakeProduction({ serving: NEW_VERSION });
  const report = await watchCanary({
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    newVersionId: NEW_VERSION,
    previousVersionId: OLD_VERSION,
    canaryPercent: 10,
    windowMs: 4_000,
    intervalMs: 1_000,
    minNewSamples: 2,
    fetchImpl: healthy.fetchImpl,
    ...fakeClock(1_000),
  });
  assert.equal(report.outcome, "healthy");
  assert.equal(report.newSamples, 4);

  const rejected = fakeProduction({ serving: NEW_VERSION, gates: { compatibility: "reject" } });
  const failed = await watchCanary({
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    newVersionId: NEW_VERSION,
    previousVersionId: OLD_VERSION,
    canaryPercent: 100,
    windowMs: 4_000,
    intervalMs: 1_000,
    minNewSamples: 1,
    fetchImpl: rejected.fetchImpl,
    ...fakeClock(1_000),
  });
  assert.equal(failed.outcome, "unhealthy");
  assert.match(failed.reason, /failed its gate/u);
});
test("a canary that never reaches the new version is not promoted", async () => {
  const report = await watchCanary({
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    newVersionId: NEW_VERSION,
    previousVersionId: OLD_VERSION,
    canaryPercent: 10,
    windowMs: 4_000,
    intervalMs: 1_000,
    minNewSamples: 2,
    fetchImpl: fakeProduction({ serving: OLD_VERSION }).fetchImpl,
    ...fakeClock(1_000),
  });
  assert.equal(report.outcome, "unhealthy");
  assert.match(report.reason, /fewer than 2/u);
});

test("an unreachable Hub fails the canary instead of promoting it", async () => {
  const report = await watchCanary({
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    newVersionId: NEW_VERSION,
    previousVersionId: OLD_VERSION,
    canaryPercent: 10,
    windowMs: 10_000,
    intervalMs: 1_000,
    minNewSamples: 1,
    fetchImpl: fakeProduction({ serving: NEW_VERSION, gates: { health: "throw" } }).fetchImpl,
    ...fakeClock(1_000),
  });
  assert.equal(report.outcome, "unhealthy");
  assert.match(report.reason, /three consecutive samples/u);
});

test("a healthy canary is promoted to 100% of production", async () => {
  const hub = fakeProduction({ serving: NEW_VERSION });
  const result = await rolloutHubCanary({
    state: state(),
    url: "https://hub.example/",
    expectedSha: NEW_REVISION,
    runWrangler: hub.runWrangler,
    fetchImpl: hub.fetchImpl,
    ...fakeClock(1_000),
    settings: { windowMs: 30_000, intervalMs: 1_000 },
  });
  assert.equal(result.promoted, NEW_VERSION);
  assert.deepEqual(hub.deployed().map((args) => args.slice(0, args.indexOf("-y"))), [
    ["versions", "deploy", `${NEW_VERSION}@10`, `${OLD_VERSION}@90`],
    ["versions", "deploy", `${NEW_VERSION}@100`],
  ]);
});

test("a canary gate failure rolls production back to the previous version", async () => {
  const hub = fakeProduction({ serving: NEW_VERSION, gates: { postgres: "not-ready" } });
  await assert.rejects(
    rolloutHubCanary({
      state: state(),
      url: "https://hub.example/",
      expectedSha: NEW_REVISION,
      runWrangler: hub.runWrangler,
      fetchImpl: hub.fetchImpl,
      ...fakeClock(1_000),
      settings: { windowMs: 30_000, intervalMs: 1_000 },
    }),
    /rolled back/u,
  );
  assert.deepEqual(hub.deployed().map((args) => args.slice(0, args.indexOf("-y"))), [
    ["versions", "deploy", `${NEW_VERSION}@10`, `${OLD_VERSION}@90`],
    ["versions", "deploy", `${OLD_VERSION}@100`],
  ]);
});

test("a promoted version that fails verification is rolled back too", async () => {
  const hub = fakeProduction({ serving: NEW_VERSION, gates: { https: "broken" } });
  await assert.rejects(
    rolloutHubCanary({
      state: state(),
      url: "https://hub.example/",
      expectedSha: NEW_REVISION,
      runWrangler: hub.runWrangler,
      fetchImpl: hub.fetchImpl,
      ...fakeClock(1_000),
      settings: { windowMs: 30_000, intervalMs: 1_000 },
    }),
    /expected same-path HTTPS redirect/u,
  );
  assert.deepEqual(hub.deployed().at(-1).slice(0, 3), ["versions", "deploy", `${OLD_VERSION}@100`]);
});

test("canary state from another revision is refused before traffic moves", async () => {
  const hub = fakeProduction({ serving: NEW_VERSION });
  await assert.rejects(
    rolloutHubCanary({
      state: state({ expectedSha: OLD_REVISION }),
      url: "https://hub.example/",
      expectedSha: NEW_REVISION,
      runWrangler: hub.runWrangler,
      fetchImpl: hub.fetchImpl,
    }),
    /different release revision/u,
  );
  assert.equal(hub.calls.length, 0);
});
