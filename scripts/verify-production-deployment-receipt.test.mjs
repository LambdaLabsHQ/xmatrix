import { assert, execFileSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test, fileURLToPath } from "./script-test-fixture.mjs";
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

test("verified receipt command exits successfully after reading R2 materialized JSON", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-receipt-check-"));
  try {
    const receiptPath = path.join(directory, "production-deployment-receipt.json");
    writeFileSync(receiptPath, JSON.stringify(receipt));
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL("./verify-production-deployment-receipt.mjs", import.meta.url)),
      receiptPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        SOURCE_SCOPE: expected.scope,
        SOURCE_SHA: expected.sha,
        SOURCE_RUN_ID: String(expected.runId),
        SOURCE_RUN_ATTEMPT: String(expected.runAttempt),
        RELEASE_TAG: expected.tag,
      },
    });
    assert.match(output, /verified xmatrix-v0\.16\.339 scope=web run=123:1/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
