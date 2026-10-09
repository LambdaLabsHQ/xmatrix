const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { installedHarnessCandidates } = require("./installed-harness-candidates.ts");

const daemon = { id: "daemon", name: "Laptop", userId: "owner", machineId: "machine", status: "online",
  metadata: { harnesses: { schemaVersion: 1, capturedAt: "2026-10-07T00:00:00Z", items: [
    { id: "codex", installed: true, version: "1.0.0", probeStatus: "ok", autoUpdate: "unknown" },
    { id: "claude", installed: false, probeStatus: "missing", autoUpdate: "unknown" },
  ] } } };

test("only installed pairs on the viewer's machines are offered, once per machine", () => {
  const rows = installedHarnessCandidates("space", "owner", [daemon, { ...daemon, id: "reconnected" },
    { ...daemon, userId: "other", machineId: "other" }, { ...daemon, machineId: undefined }], []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].preset.id, "codex");
  assert.equal(rows[0].machineName, "Laptop");
  assert.equal(rows[0].registration, undefined);
});

test("existing disabled and revoked states remain attached without changing them", () => {
  for (const state of ["disabled", "revoked", "enabled"]) {
    const registration = { key: { spaceId: "space", ownerUserId: "owner", machineId: "machine", harness: "codex" }, state };
    const [row] = installedHarnessCandidates("space", "owner", [daemon], [registration]);
    assert.equal(row.registration, registration);
    assert.equal(installedHarnessCandidates("other-space", "owner", [daemon], [registration])[0].registration, undefined);
  }
});

test("offline observations stay visible; missing or invalid inventory creates no candidates", () => {
  assert.equal(installedHarnessCandidates("space", "owner", [{ ...daemon, status: "offline" }], []).length, 1);
  for (const metadata of [{}, { harnesses: { ...daemon.metadata.harnesses, schemaVersion: 99 } }]) {
    assert.deepEqual(installedHarnessCandidates("space", "owner", [{ ...daemon, metadata }], []), []);
  }
});
