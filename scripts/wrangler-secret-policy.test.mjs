import { assert, spawnSync, mkdtempSync, rmSync, writeFileSync, tmpdir, path, test, fileURLToPath } from "./script-test-fixture.mjs";
import {
  assertSecretPolicy,
  secretNamesFromWrangler,
} from "./wrangler-secret-policy.mjs";

const PROXY_NOTICE = "Proxy environment variables detected. We'll use your proxy for fetch requests.\n";

test("secret names are recovered from noisy Wrangler JSON and normalized", () => {
  const raw = PROXY_NOTICE + JSON.stringify([
    { name: "XMATRIX_MOCK_AUTH_TOKEN", type: "secret_text" },
    { name: "BETTER_AUTH_SECRET", type: "secret_text" },
    { name: "BETTER_AUTH_SECRET", type: "secret_text" },
  ]);
  assert.deepEqual(secretNamesFromWrangler(raw), [
    "BETTER_AUTH_SECRET",
    "XMATRIX_MOCK_AUTH_TOKEN",
  ]);
  assert.deepEqual(secretNamesFromWrangler("[]\nDone\n"), []);
});

test("required and forbidden-prefix policies fail closed", () => {
  assert.deepEqual(
    assertSecretPolicy(["A", "B"], { required: ["A"], forbiddenPrefixes: ["MOCK_"] }),
    ["A", "B"],
  );
  assert.throws(
    () => assertSecretPolicy(["A"], { required: ["A", "B"] }),
    /required Worker secrets are missing: B/u,
  );
  assert.throws(
    () => assertSecretPolicy(["A", "XMATRIX_MOCK_AUTH_TOKEN"], {
      forbiddenPrefixes: ["XMATRIX_MOCK_AUTH"],
    }),
    /forbidden Worker secrets/u,
  );
});

test("CLI applies production, Test, and Next auth policies to provider readback", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "xmatrix-secret-policy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "secrets.json");
  const baseNames = [
    "BETTER_AUTH_SECRET",
    "RELAY_R2_CAPABILITY_HMAC_SECRET",
    "XMATRIX_SECRET_CATALOG_KEY",
    "XMATRIX_MOCK_AUTH_TOKEN",
  ];
  writeFileSync(
    file,
    JSON.stringify(baseNames.map((name) => ({ name, type: "secret_text" }))),
  );
  const script = fileURLToPath(new URL("./wrangler-secret-policy.mjs", import.meta.url));
  const production = spawnSync(process.execPath, [
    script,
    file,
    "--policy=production-hub",
  ], { encoding: "utf8" });
  assert.notEqual(production.status, 0);
  assert.match(production.stderr, /forbidden Worker secrets/u);

  writeFileSync(
    file,
    JSON.stringify([{ name: "XMATRIX_SECRET_CATALOG_KEY", type: "secret_text" }]),
  );
  const validProduction = spawnSync(process.execPath, [
    script,
    file,
    "--policy=production-hub",
  ], { encoding: "utf8" });
  assert.equal(validProduction.status, 0, validProduction.stderr);

  const billingNames = [
    "XMATRIX_SECRET_CATALOG_KEY",
    "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET",
    "STRIPE_PRO_MONTHLY_PRICE_ID", "STRIPE_PRO_ANNUAL_PRICE_ID",
  ];
  writeFileSync(file, JSON.stringify(billingNames.map((name) => ({ name, type: "secret_text" }))));
  const billing = spawnSync(process.execPath, [script, file, "--policy=production-hub-billing"], { encoding: "utf8" });
  assert.equal(billing.status, 0, billing.stderr);
  for (const missing of billingNames.slice(1)) {
    writeFileSync(file, JSON.stringify(billingNames.filter((name) => name !== missing)
      .map((name) => ({ name, type: "secret_text" }))));
    const incomplete = spawnSync(process.execPath, [script, file, "--policy=production-hub-billing"], { encoding: "utf8" });
    assert.notEqual(incomplete.status, 0);
    assert.ok(incomplete.stderr.includes(missing));
  }

  writeFileSync(file, "[]");
  const productionMissing = spawnSync(process.execPath, [
    script,
    file,
    "--policy=production-hub",
  ], { encoding: "utf8" });
  assert.notEqual(productionMissing.status, 0);
  assert.match(productionMissing.stderr, /XMATRIX_SECRET_CATALOG_KEY/u);

  writeFileSync(
    file,
    JSON.stringify(baseNames.map((name) => ({ name, type: "secret_text" }))),
  );

  const emailOnly = spawnSync(process.execPath, [script, file, "--policy=test-hub-email-only"], {
    encoding: "utf8",
  });
  assert.equal(emailOnly.status, 0, emailOnly.stderr);

  const next = spawnSync(process.execPath, [script, file, "--policy=next-hub"], {
    encoding: "utf8",
  });
  assert.equal(next.status, 0, next.stderr);

  const googleMissing = spawnSync(process.execPath, [script, file, "--policy=test-hub-google"], {
    encoding: "utf8",
  });
  assert.notEqual(googleMissing.status, 0);
  assert.match(googleMissing.stderr, /GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET/u);

  writeFileSync(
    file,
    JSON.stringify([...baseNames, "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
      .map((name) => ({ name, type: "secret_text" }))),
  );
  const google = spawnSync(process.execPath, [script, file, "--policy=test-hub-google"], {
    encoding: "utf8",
  });
  assert.equal(google.status, 0, google.stderr);
  const emailWithGoogle = spawnSync(
    process.execPath,
    [script, file, "--policy=test-hub-email-only"],
    { encoding: "utf8" },
  );
  assert.notEqual(emailWithGoogle.status, 0);
  assert.match(emailWithGoogle.stderr, /forbidden Worker secrets/u);
});
