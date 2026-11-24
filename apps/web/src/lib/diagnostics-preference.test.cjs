const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DIAGNOSTICS_STORAGE_KEY,
  isDiagnosticsEnabled,
} = require("./diagnostics-preference.ts");

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
  };
}

test("diagnostics are enabled by default and respect Do Not Track and Global Privacy Control", () => {
  assert.equal(isDiagnosticsEnabled({ storage: memoryStorage() }), true);
  assert.equal(isDiagnosticsEnabled({ storage: memoryStorage(), doNotTrack: "1" }), false);
  assert.equal(isDiagnosticsEnabled({ storage: memoryStorage(), doNotTrack: "yes" }), false);
  assert.equal(isDiagnosticsEnabled({ storage: memoryStorage(), globalPrivacyControl: true }), false);
});

test("explicit stored choice overrides browser signals and handles throwing storage", () => {
  assert.equal(
    isDiagnosticsEnabled({
      storage: memoryStorage({ [DIAGNOSTICS_STORAGE_KEY]: "false" }),
      doNotTrack: null,
      globalPrivacyControl: false,
    }),
    false,
  );
  assert.equal(
    isDiagnosticsEnabled({
      storage: memoryStorage({ [DIAGNOSTICS_STORAGE_KEY]: "true" }),
      doNotTrack: "1",
      globalPrivacyControl: true,
    }),
    true,
  );
  const throwingStorage = {
    getItem() {
      throw new Error("storage blocked");
    },
  };
  assert.equal(isDiagnosticsEnabled({ storage: throwingStorage }), true);
  assert.equal(isDiagnosticsEnabled({ storage: throwingStorage, globalPrivacyControl: true }), false);
});
