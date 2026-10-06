const assert = require("node:assert/strict");
const test = require("node:test");
require("./typescript-require.cjs").installTypeScriptRequire();
const { messageMachineIdentity, registrationMachineBusy, registrationMachineName } = require("./machine-name-presentation.ts");
const row = (ownerUserId, machineId, machineName) => ({
  key: { spaceId: "space", ownerUserId, machineId, harness: "grok" }, machineName,
});

test("Machine labels come from exact catalog identity and follow renames", () => {
  const rows = [row("owner", "machine:grok", "Grok Bot Machine"), row("owner", "machine:mac", "Laptop")];
  assert.equal(registrationMachineName(rows, "machine:grok", "owner"), "Grok Bot Machine");
  assert.equal(registrationMachineName([row("owner", "machine:mac", "Travel Mac")], "machine:mac", "owner"), "Travel Mac");
  assert.equal(registrationMachineName(rows, "cursor", "owner"), undefined);
  assert.equal(registrationMachineName(rows, "machine:grok", "other"), undefined);
  assert.equal(registrationMachineName(rows, undefined), undefined);
});

test("old notices resolve only an unambiguous Machine within the authorized catalog", () => {
  const rows = [row("owner", "machine:grok", "Grok Bot Machine"), row("other", "machine:grok", "Other")];
  assert.equal(registrationMachineName(rows, "machine:grok"), undefined);
  assert.equal(registrationMachineName(rows, "machine:grok", "owner"), "Grok Bot Machine");
  assert.equal(registrationMachineName([rows[0], rows[0]], "machine:grok"), "Grok Bot Machine");
});

const runningRow = (owner, machine, name, instanceId) => ({
  ...row(owner, machine, name),
  live: { machine: { online: true }, running: [{ instanceId, channelId: "origin", channelInstanceId: "1" }] },
});

test("cross-Channel historical messages resolve their exact authorized Instance", () => {
  const rows = [runningRow("owner", "server", "fixture-node", "origin:1"),
    runningRow("owner", "laptop", "Laptop", "local:1")];
  assert.deepEqual(messageMachineIdentity(rows, { senderInstanceId: "origin:1" }), { machineId: "server", ownerUserId: "owner" });
  assert.equal(messageMachineIdentity(rows, { senderInstanceId: "missing:1" }), undefined);
  assert.equal(messageMachineIdentity(rows, {}), undefined);
  assert.equal(messageMachineIdentity([], { senderInstanceId: "origin:1" }), undefined);
  assert.equal(messageMachineIdentity([...rows, runningRow("other", "other-server", "Other", "origin:1")],
    { senderInstanceId: "origin:1" }), undefined);
});

test("send-time Machine identity survives stop and rename without following another live Instance", () => {
  const message = { senderMachineId: "server", senderMachineOwnerUserId: "owner", senderInstanceId: "origin:1" };
  const rows = [row("owner", "server", "Renamed server"), runningRow("other", "laptop", "Laptop", "origin:1")];
  const identity = messageMachineIdentity(rows, message);
  assert.deepEqual(identity, { machineId: "server", ownerUserId: "owner" });
  assert.equal(registrationMachineName(rows, identity.machineId, identity.ownerUserId), "Renamed server");
  assert.equal(registrationMachineName([rows[1]], identity.machineId, identity.ownerUserId), undefined);
  assert.equal(registrationMachineName([row("other", "server", "Other owner's server")], identity.machineId, identity.ownerUserId), undefined);
});

test("a Machine tag excludes disk from its load but includes disk in its hover readings", () => {
  const resources = { observedAt: "2026-09-25T00:00:00.000Z", cpuUsagePercent: 40, memoryTotalBytes: 100, memoryAvailableBytes: 40,
    diskTotalBytes: 100, diskAvailableBytes: 5 };
  const live = (online) => ({ ...row("owner", "machine:grok", "Grok"), live: { machine: { online, resources }, running: [] } });
  assert.deepEqual(registrationMachineBusy([live(true)], "machine:grok", "owner"),
    { percent: 60, glance: [{ key: "cpu", label: "CPU", percent: 40 }, { key: "memory", label: "Mem", percent: 60 },
      { key: "disk", label: "Disk", percent: 95 }] });
  assert.equal(registrationMachineBusy([live(false)], "machine:grok", "owner"), undefined);
  assert.equal(registrationMachineBusy([row("owner", "machine:grok", "Grok")], "machine:grok", "owner"), undefined);
});
