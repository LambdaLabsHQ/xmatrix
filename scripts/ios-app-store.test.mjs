import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appleClient, appleToken, AppleApiError } from "./app-store-connect.mjs";
import { findBuild, submitRelease, validateMetadata } from "./ios-app-store.mjs";

const metadata = JSON.parse(readFileSync(new URL("../apps/ios/app-store/metadata.json", import.meta.url), "utf8"));
const args = { appId: "app", version: "1.0.200", buildNumber: "12345", metadata, waitFor: async () => {}, attempts: 2 };
const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const credentials = { keyId: "TESTKEY", issuerId: "test-issuer", privateKey: key.privateKey };

function fixture(options = {}) {
  const writes = [];
  const build = { id: "exact-build", attributes: { version: "12345", processingState: "VALID", expired: false, ...options.build } };
  const version = { id: "version", attributes: { versionString: "1.0.199", appVersionState: "PREPARE_FOR_SUBMISSION", ...options.version }, relationships: { build: { data: { id: options.boundBuild ?? "exact-build" } } } };
  const review = { id: "private-review", attributes: { contactFirstName: "Review", contactLastName: "Contact", contactEmail: "review@example.invalid", contactPhone: "+10000000000", demoAccountRequired: true, demoAccountName: "synthetic-user", demoAccountPassword: "SENSITIVE_TEST_SENTINEL", notes: "Private review access instructions", ...options.review } };
  let submission = options.submission;
  let selected = false;
  const api = {
    async list(path) {
      const url = new URL(path, "https://api.appstoreconnect.apple.com");
      if (url.pathname === "/v1/builds") {
        assert.equal(url.searchParams.get("filter[version]"), "12345");
        assert.equal(url.searchParams.get("filter[preReleaseVersion.version]"), "1.0.200");
        assert.equal(url.searchParams.get("filter[app]"), "app");
        assert.equal(url.searchParams.get("filter[preReleaseVersion.platform]"), "IOS");
        return options.builds ?? [build];
      }
      if (url.pathname === "/v1/apps/app/appStoreVersions") return options.versions ?? [version];
      if (url.pathname === "/v1/reviewSubmissions") return submission ? [submission] : [];
      if (url.pathname.endsWith("/items")) return options.items ?? [];
      if (url.pathname.endsWith("/appStoreVersionLocalizations")) return [{ id: "en", attributes: { locale: "en-US" } }, { id: "fr", attributes: { locale: "fr-FR" } }];
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, method = "GET", data) {
      if (method !== "GET") writes.push({ path, method, data });
      if (path.endsWith("/appStoreReviewDetail")) return { data: review };
      if (path === "/v1/appStoreVersions/version" && method === "PATCH") {
        assert.equal(data.relationships.build.data.id, "exact-build"); selected = true; return { data: version };
      }
      if (path.endsWith("/relationships/build")) {
        assert.ok(selected); return { data: { id: options.readbackBuild ?? "exact-build" } };
      }
      if (path === "/v1/reviewSubmissions" && method === "POST") {
        submission = { id: "submission", attributes: { state: "READY_FOR_REVIEW" } }; return { data: submission };
      }
      if (path === "/v1/reviewSubmissions/submission" && method === "PATCH") {
        assert.deepEqual(data.attributes, { submitted: true }); submission.attributes.state = options.receiptState ?? "WAITING_FOR_REVIEW";
      }
      if (path === "/v1/reviewSubmissions/submission" && method === "GET") return { data: submission };
      return { data: { id: "saved" } };
    },
  };
  return { api, writes };
}

test("public metadata has only publishable fields and respects Apple limits", () => {
  assert.equal(validateMetadata(metadata), metadata);
  assert.throws(() => validateMetadata({ ...metadata, demoAccountPassword: "SENSITIVE_TEST_SENTINEL" }), /schema/);
  assert.throws(() => validateMetadata({ ...metadata, localizations: [{ ...metadata.localizations[0], description: "x".repeat(4001) }] }), /description/);
  assert.throws(() => validateMetadata({ ...metadata, localizations: [{ ...metadata.localizations[0], supportUrl: "https://other.invalid" }] }), /URL/);
});

test("submits exact build, preserves private review fields and unrelated localizations", async () => {
  const { api, writes } = fixture();
  const result = await submitRelease(api, { ...args, privateNotes: "SENSITIVE_TEST_SENTINEL" });
  assert.deepEqual(result, { outcome: "submitted", version: "1.0.200", buildNumber: "12345", state: "WAITING_FOR_REVIEW" });
  assert.equal(JSON.stringify(result).includes("SENSITIVE"), false);
  assert.equal(writes.some((row) => row.path.endsWith("/fr")), false);
  const reviewWrite = writes.find((row) => row.path.startsWith("/v1/appStoreReviewDetails/"));
  assert.deepEqual(Object.keys(reviewWrite.data.attributes), ["notes"]);
  assert.ok(reviewWrite.data.attributes.notes.includes("1.0.200 (12345)"));
  assert.equal(writes.some((row) => row.method === "DELETE"), false);
  assert.equal(writes.some((row) => row.data?.attributes?.canceled), false);
});

test("rerun verifies same submitted version's build and does no writes", async () => {
  const { api, writes } = fixture({ version: { versionString: "1.0.200", appVersionState: "WAITING_FOR_REVIEW" } });
  assert.equal((await submitRelease(api, args)).outcome, "already-submitted");
  assert.deepEqual(writes, []);
  const wrong = fixture({ version: { versionString: "1.0.200", appVersionState: "IN_REVIEW" }, boundBuild: "other" });
  await assert.rejects(submitRelease(wrong.api, args), /different build/);
  assert.deepEqual(wrong.writes, []);
});

test("existing review and rejection are deferred without withdrawing or resolving anything", async () => {
  for (const versionState of ["WAITING_FOR_REVIEW", "IN_REVIEW", "PENDING_DEVELOPER_RELEASE"]) {
    const { api, writes } = fixture({ version: { appVersionState: versionState } });
    assert.equal((await submitRelease(api, args)).outcome, "deferred-existing-review");
    assert.deepEqual(writes, []);
  }
  const { api, writes } = fixture({ version: { appVersionState: "REJECTED" }, submission: { id: "submission", attributes: { state: "UNRESOLVED_ISSUES" } }, items: [{ relationships: { appStoreVersion: { data: { id: "version" } } } }] });
  assert.equal((await submitRelease(api, args)).outcome, "deferred-review-response-required");
  assert.deepEqual(writes, []);
});

test("refuses unrelated submission items, downgrades and incomplete review credentials before mutation", async () => {
  for (const options of [
    { submission: { id: "submission", attributes: { state: "READY_FOR_REVIEW" } }, items: [{ relationships: { appStoreVersion: { data: { id: "other" } } } }] },
    { version: { versionString: "2.0.0" } },
    { review: { demoAccountPassword: "" } },
    { review: { contactPhone: "" } },
  ]) {
    const { api, writes } = fixture(options);
    await assert.rejects(submitRelease(api, args));
    assert.deepEqual(writes, []);
  }
});

test("polling is bounded; expired, invalid and ambiguous exact builds fail closed", async () => {
  for (const options of [{ build: { expired: true } }, { build: { processingState: "INVALID" } }, { builds: [{}, {}] }]) {
    const { api, writes } = fixture(options);
    await assert.rejects(findBuild(api, args));
    assert.deepEqual(writes, []);
  }
  const { api, writes } = fixture({ build: { processingState: "PROCESSING" } });
  let waits = 0;
  await assert.rejects(submitRelease(api, { ...args, waitFor: async () => { waits++; } }), /timed out/);
  assert.equal(waits, 1);
  assert.deepEqual(writes, []);
});

test("build readback mismatch never submits and unconfirmed receipt never reports success", async () => {
  const mismatch = fixture({ readbackBuild: "other" });
  await assert.rejects(submitRelease(mismatch.api, args), /binding verification/);
  assert.equal(mismatch.writes.some((row) => row.path === "/v1/reviewSubmissions"), false);
  await assert.rejects(submitRelease(fixture({ receiptState: "READY_FOR_REVIEW" }).api, args), /not yet confirmed/);
});

test("Apple JWT is short-lived and has a valid ES256 signature", () => {
  const jwt = appleToken({ ...credentials, now: 1_000_000 });
  const [header, payload, signature] = jwt.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  assert.equal(claims.exp - claims.iat, 610);
  assert.equal(claims.aud, "appstoreconnect-v1");
  assert.ok(verify("sha256", Buffer.from(`${header}.${payload}`), { key: key.publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url")));
});

test("client rejects foreign pagination and redirects; no private body or token in errors", async () => {
  let calls = 0;
  const api = appleClient({ ...credentials, fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.redirect, "error");
    return new Response(JSON.stringify({ data: [], links: { next: "https://attacker.invalid/v1/apps" } }));
  } });
  await assert.rejects(api.list("/v1/apps"), /destination/);
  assert.equal(calls, 1);
  const bad = appleClient({ ...credentials, fetchImpl: async () => new Response("SENSITIVE_TEST_SENTINEL", { status: 403 }) });
  await assert.rejects(bad.request("/v1/apps", "POST", { private: "SENSITIVE_TEST_SENTINEL" }), (error) => error instanceof AppleApiError && !error.message.includes("SENSITIVE"));
  const malformed = appleClient({ ...credentials, fetchImpl: async () => new Response("SENSITIVE_TEST_SENTINEL") });
  await assert.rejects(malformed.request("/v1/apps"), { message: "Invalid or oversized App Store Connect response." });
});

test("only GET retries: ambiguous mutations are left for reconciliation", async () => {
  for (const method of ["GET", "POST", "PATCH"]) {
    let calls = 0;
    const api = appleClient({ ...credentials, wait: async () => {}, fetchImpl: async () => { calls++; return new Response("secret", { status: 503 }); } });
    await assert.rejects(api.request("/v1/apps", method));
    assert.equal(calls, method === "GET" ? 3 : 1);
  }
});

test("workflow keeps signing/API secrets in production and never uploads private review artifacts", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ios-testflight.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_call:/);
  assert.doesNotMatch(workflow, /pull_request_target|workflow_dispatch:|upload-artifact/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /github.event.repository.private && vars.XMATRIX_RUNNER_FLEET/);
  assert.match(workflow, /node scripts\/check-release-version.mjs/);
  assert.match(workflow, /IOS_BUILD_NUMBER: \$\{\{ github.run_id \}\}/);
  assert.match(workflow, /node scripts\/ios-app-store.mjs submit/);
  assert.match(workflow, /Remove temporary Apple API key\n\s+if: always\(\)/);
  const upload = readFileSync(new URL("./ios-testflight.sh", import.meta.url), "utf8");
  assert.match(upload, /export API_PRIVATE_KEYS_DIR=/);
  assert.doesNotMatch(upload, /\$HOME\/\.appstoreconnect/);
});


test("response and pagination sizes are bounded", async () => {
  const large = appleClient({ ...credentials, fetchImpl: async () => new Response("x".repeat(4 * 1024 * 1024 + 1)) });
  await assert.rejects(large.request("/v1/apps"), /oversized/);
  let calls = 0;
  const pages = appleClient({ ...credentials, fetchImpl: async () => { calls++; return new Response(JSON.stringify({ data: [], links: { next: "/v1/apps?cursor=next" } })); } });
  await assert.rejects(pages.list("/v1/apps"), /pagination limit/);
  assert.equal(calls, 10);
});

test("existing private review instructions are preserved when no secret override is supplied", async () => {
  const { api, writes } = fixture();
  await submitRelease(api, args);
  assert.equal(writes.find((row) => row.path.startsWith("/v1/appStoreReviewDetails/")).data.attributes.notes, "Private review access instructions");
});


test("ready submission with the version already attached is resumed without duplicate items", async () => {
  const { api, writes } = fixture({ submission: { id: "submission", attributes: { state: "READY_FOR_REVIEW" } }, items: [{ relationships: { appStoreVersion: { data: { id: "version" } } } }] });
  assert.equal((await submitRelease(api, args)).outcome, "submitted");
  assert.equal(writes.some((row) => row.path === "/v1/reviewSubmissionItems" || row.path === "/v1/reviewSubmissions"), false);
});

test("new versions inherit only private review fields and use manual release", async () => {
  const { api, writes } = fixture({ version: { appVersionState: "READY_FOR_DISTRIBUTION" } });
  const original = api.request;
  api.request = async (path, method = "GET", data) => {
    if (path === "/v1/appStoreVersions" && method === "POST") {
      writes.push({ path, method, data });
      assert.equal(data.attributes.releaseType, "MANUAL");
      return { data: { id: "new-version", attributes: { versionString: "1.0.200" } } };
    }
    if (path === "/v1/appStoreVersions/new-version/appStoreReviewDetail") throw new AppleApiError(404);
    if (path === "/v1/appStoreVersions/new-version/relationships/build") return { data: { id: "exact-build" } };
    return original(path, method, data);
  };
  assert.equal((await submitRelease(api, args)).outcome, "submitted");
  const created = writes.find((row) => row.path === "/v1/appStoreReviewDetails");
  assert.equal(created.data.attributes.demoAccountPassword, "SENSITIVE_TEST_SENTINEL");
  assert.equal(created.data.relationships.appStoreVersion.data.id, "new-version");
});


test("retry after creating a version but before creating review details recovers from the prior version", async () => {
  const draft = { id: "version", attributes: { versionString: "1.0.200", appVersionState: "PREPARE_FOR_SUBMISSION" } };
  const previous = { id: "previous", attributes: { versionString: "1.0.199", appVersionState: "READY_FOR_DISTRIBUTION" } };
  const { api, writes } = fixture({ versions: [draft, previous] });
  const original = api.request;
  api.request = async (path, method = "GET", data) => {
    if (path === "/v1/appStoreVersions/version/appStoreReviewDetail") throw new AppleApiError(404);
    return original(path, method, data);
  };
  assert.equal((await submitRelease(api, args)).outcome, "submitted");
  assert.equal(writes.some((row) => row.path === "/v1/appStoreVersions" && row.method === "POST"), false);
  assert.ok(writes.find((row) => row.path === "/v1/appStoreReviewDetails"));
});
