import { assert, spawnSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test, fileURLToPath } from "./script-test-fixture.mjs";
import { verifyProductionDeploymentReceipt } from "./verify-production-deployment-receipt.mjs";

const expected = {
  scope: "web",
  sha: "a".repeat(40),
  tag: "xmatrix-v0.16.339",
  runId: 123,
  runAttempt: 1,
};
const receipt = {
  schemaVersion: 1,
  scope: "web",
  components: ["web"],
  releaseTag: expected.tag,
  version: "0.16.339",
  deploySha: expected.sha,
  webUrl: "https://xmatrix.sh",
  runId: expected.runId,
  runAttempt: expected.runAttempt,
};

test("receipt recovery requires the exact run, tag, SHA, scope, and selected surfaces", () => {
  assert.equal(verifyProductionDeploymentReceipt(receipt, expected), receipt);
  for (const altered of [
    { ...receipt, scope: "hub" },
    { ...receipt, components: ["hub", "web"] },
    { ...receipt, deploySha: "b".repeat(40) },
    { ...receipt, runId: 124 },
    { ...receipt, runAttempt: 2 },
    { ...receipt, releaseTag: "xmatrix-v0.16.340" },
    { ...receipt, hubUrl: "https://xmatrix-hub.xmatrix.sh" },
    { ...receipt, webUrl: "https://example.invalid" },
  ]) {
    assert.throws(() => verifyProductionDeploymentReceipt(altered, expected));
  }
});

test("a receipt's Web is the one its channel deploys", () => {
  // The immutable beta.6 workflow deployed the shared Web; beta.7 first
  // selected web-beta. Test both sides and later numeric beta/core versions.
  for (const [version, webUrl] of [
    ["1.3.1-beta.6", "https://xmatrix.sh"],
    ["1.3.1-beta.7", "https://beta.xmatrix.sh"],
    ["1.3.1-beta.10", "https://beta.xmatrix.sh"],
    ["1.3.2-beta.1", "https://beta.xmatrix.sh"],
    ["10.0.0-beta.1", "https://beta.xmatrix.sh"],
    ["1.3.1", "https://xmatrix.sh"],
  ]) {
    const identity = { ...expected, tag: `xmatrix-v${version}` };
    const candidate = { ...receipt, releaseTag: identity.tag, version, webUrl };
    assert.equal(verifyProductionDeploymentReceipt(candidate, identity), candidate);
    const otherWeb = webUrl === "https://xmatrix.sh" ? "https://beta.xmatrix.sh" : "https://xmatrix.sh";
    assert.throws(() => verifyProductionDeploymentReceipt({ ...candidate, webUrl: otherWeb }, identity),
      /different deployed surface/u, version);
  }
});

function runReceiptCommand(candidate, identity) {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-receipt-check-"));
  try {
    const receiptPath = path.join(directory, "production-deployment-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(candidate));
    return spawnSync(process.execPath, [
      fileURLToPath(new URL("./verify-production-deployment-receipt.mjs", import.meta.url)),
      receiptPath,
    ], {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        SOURCE_SCOPE: identity.scope,
        SOURCE_SHA: identity.sha,
        SOURCE_RUN_ID: String(identity.runId),
        SOURCE_RUN_ATTEMPT: String(identity.runAttempt),
        RELEASE_TAG: identity.tag,
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("verified receipt command exits successfully after reading R2 materialized JSON", () => {
  const result = runReceiptCommand(receipt, expected);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verified xmatrix-v0\.16\.339 scope=web run=123:1/u);
});

test("receipt recovery command rejects a modern beta claiming the stable Web", () => {
  const identity = { ...expected, tag: "xmatrix-v3.1.3-beta.32" };
  const candidate = { ...receipt, releaseTag: identity.tag, version: "3.1.3-beta.32" };
  const rejected = runReceiptCommand(candidate, identity);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /different deployed surface/u);
  assert.equal(rejected.stdout, "");
  const accepted = runReceiptCommand({ ...candidate, webUrl: "https://beta.xmatrix.sh" }, identity);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /verified xmatrix-v3\.1\.3-beta\.32/u);
});
