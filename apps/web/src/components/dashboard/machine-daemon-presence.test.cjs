const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();

const {
  daemonPresenceLabel,
  isLiveMachineDaemon,
  machineIdentityKeys,
  normalizedMachineKeys,
  preferredMachineDaemon,
} = require("./machine-daemon-presence.ts");

const NOW = Date.parse("2026-09-07T02:00:00.000Z");

function isoAgo(ms) {
  return new Date(NOW - ms).toISOString();
}

test("Machine identity never uses a shared host label or missing-id fallback", () => {
  assert.deepEqual(
    machineIdentityKeys({
      machineId: "machine:windows",
      hostId: "Workstation",
      hostName: "Workstation",
    }),
    ["machine:windows"],
  );
  assert.deepEqual(
    machineIdentityKeys({
      machineId: "machine:wsl",
      hostId: "Workstation",
      hostName: "Workstation",
    }),
    ["machine:wsl"],
  );
  assert.deepEqual(
    machineIdentityKeys({ hostId: "Workstation", hostName: "Workstation" }),
    [],
  );
  assert.deepEqual(machineIdentityKeys({ fallback: "Workstation" }), []);
  assert.deepEqual(normalizedMachineKeys(["Machine:A", "machine:a"]), ["Machine:A", "machine:a"]);
});

test("catalog online is live presence regardless of lastSeen age", () => {
  const agedOnline = {
    status: "online",
    lastSeenAt: isoAgo(60 * 60 * 1000),
  };
  const enrolled = {
    status: "enrolled",
    lastSeenAt: isoAgo(30_000),
  };
  const live = {
    status: "online",
    lastSeenAt: isoAgo(30_000),
  };
  assert.equal(isLiveMachineDaemon(agedOnline), true);
  assert.equal(isLiveMachineDaemon(enrolled), false);
  assert.equal(isLiveMachineDaemon(live), true);
  assert.equal(daemonPresenceLabel(agedOnline), "online");
  assert.equal(daemonPresenceLabel(enrolled), "enrolled");
  assert.equal(daemonPresenceLabel(live), "online");
  assert.equal(daemonPresenceLabel({ status: "offline", lastSeenAt: isoAgo(1_000) }), "offline");
});

test("preferred daemon keeps an online row over a recent enrolled row", () => {
  const online = {
    status: "online",
    machineId: "machine:linux",
    lastSeenAt: isoAgo(5 * 24 * 60 * 60 * 1000),
  };
  const recentEnrolled = {
    status: "enrolled",
    machineId: "machine:windows",
    lastSeenAt: isoAgo(30_000),
  };
  assert.equal(preferredMachineDaemon(online, recentEnrolled), online);
  assert.equal(preferredMachineDaemon(recentEnrolled, online), online);
});
