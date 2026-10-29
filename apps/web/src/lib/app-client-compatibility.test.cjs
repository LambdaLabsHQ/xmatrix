const assert = require("node:assert/strict");
const test = require("node:test");
require("../components/dashboard/typescript-require.cjs").installTypeScriptRequire();
const { CLIENT_COMPATIBILITY_POLICY } = require("@xmatrix/protocol");

// A device remembers the Hub's admission across releases of the same client:
// the next release opens at once while the Hub is asked again in the background.
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key) };
}

test("an admitted client is remembered across its next release, and a refusal forgets it", async (t) => {
  globalThis.window = { localStorage: storage() };
  t.after(() => { delete globalThis.window; });
  const { admitAppCompatibility, admitRememberedAppCompatibility } = require("./app-client-compatibility.ts");
  const identity = (version) => ({ component: "app", version, protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion,
    platform: "MacIntel" });
  let compatible = true;
  t.mock.method(globalThis, "fetch", async () => Response.json({ compatible, code: compatible ? "compatible" : "client_upgrade_required",
    protocolVersion: CLIENT_COMPATIBILITY_POLICY.protocolVersion, upgradeUrl: CLIENT_COMPATIBILITY_POLICY.upgradeUrl },
    { status: compatible ? 200 : 426 }));

  assert.equal(admitRememberedAppCompatibility(identity("99.0.0")), false);
  await admitAppCompatibility(identity("99.0.0"));
  assert.equal(admitRememberedAppCompatibility(identity("99.0.1")), true);
  assert.equal(admitRememberedAppCompatibility({ ...identity("99.0.1"), platform: "Win32" }), false);

  compatible = false;
  await admitAppCompatibility(identity("99.0.2"));
  assert.equal(admitRememberedAppCompatibility(identity("99.0.3")), false);
});
