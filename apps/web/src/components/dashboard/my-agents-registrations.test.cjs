const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const compiled = compileTsModules(__dirname, ["my-agents-registrations", "time-display"]);
const { machineSwitch, registrationActions, registrationActivity, registrationSettingsMode, registrationSwitch,
  registrationListed, registrationRowTitle, registrationStatus } = compiled.exports;

test.after(compiled.dispose);

function registration(overrides = {}) {
  return {
    key: { spaceId: "space", ownerUserId: "owner", machineId: "machine-1", harness: "codex" },
    displayName: "Codex", ownerName: "Ada", machineName: "Workstation", version: 1,
    state: "enabled", models: [], routingReady: true, canManageOwnerGrant: false, canConfigureSpace: false,
    canRemoveFromSpace: false,
    ...overrides,
  };
}

test("a row is named by what differs between a runtime's locations", () => {
  assert.deepEqual(registrationRowTitle(registration({ displayName: "codex" })),
    { title: "Workstation", machineInLine: false }, "the default name repeats the runtime, so the machine names it");
  assert.deepEqual(registrationRowTitle(registration({ displayName: "Reviewer" })),
    { title: "Reviewer", machineInLine: true });
});

test("a row says what the location is doing, or why it cannot take work", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const titles = { c1: "ux", c2: "hub" };
  // The Instances with work in hand; every other live one waits for its next message.
  const atWork = new Set(["i1", "i2", "i3"]);
  const activity = (overrides, working = atWork) => registrationActivity(registration(overrides),
    { conversationTitle: (id) => titles[id], now, working });
  const live = (overrides = {}) => ({ machine: { online: true }, running: [], ...overrides });
  const running = (channelId, instanceId) => ({ instanceId, channelId, channelInstanceId: "1", since: "2026-09-28T11:00:00Z" });
  const says = (state, line, rank, extra = {}) => ({ state, line, brief: line, rank, working: 0, ...extra });

  assert.deepEqual(activity({ live: live({ running: [running("c1", "i1")] }) }),
    says("running", "Working in #ux", 0, { working: 1 }));
  assert.equal(activity({ live: live({ running: [running("c1", "i1"), running("c2", "i2"), running("c1", "i3")] }) }).line,
    "3 working in #ux, #hub");
  assert.equal(activity({ live: live({ running: [running("private", "i1")] }) }).line, "Working in a conversation");
  // A live process waiting for a message is not work: it is neither counted nor named.
  assert.deepEqual(activity({ live: live({ running: [running("c1", "waiting")] }) }), says("running", "Ready", 1));
  assert.deepEqual(activity({ live: live({ running: [running("c1", "i1"), running("c2", "waiting")] }) }),
    says("running", "Working in #ux", 0, { working: 1 }));
  assert.deepEqual(activity({ live: live() }), says("running", "Ready", 1));
  // The line notes a quota running low; a row that draws the quota itself reads the brief line.
  assert.deepEqual(activity({ live: live({ quota: { remainingPercent: 14.2, observedAt: "", expiresAt: "" } }) }),
    says("running", "Ready · 14% quota left", 1, { brief: "Ready" }));
  assert.deepEqual(activity({ live: live({ running: [running("c1", "i1")], quota: { remainingPercent: 14.2, observedAt: "", expiresAt: "" } }) }),
    says("running", "Working in #ux · 14% quota left", 0, { brief: "Working in #ux", working: 1 }));
  assert.equal(activity({ live: live({ quota: { remainingPercent: 60, observedAt: "", expiresAt: "" } }) }).line, "Ready");
  // A prepaid account reads as money: fine while the provider serves it, attention once it cannot pay.
  const balance = (amount, allowed) => ({ amount, currency: "CNY", allowed, observedAt: "", expiresAt: "" });
  assert.equal(activity({ live: live({ balance: balance(6.57, true) }) }).line, "Ready");
  assert.deepEqual(activity({ live: live({ balance: balance(0, false) }) }), says("attention", "Out of balance", 2));
  assert.deepEqual(activity({ live: live({ quota: { remainingPercent: 0, observedAt: "", expiresAt: "" } }) }),
    says("attention", "Out of quota · window unavailable", 2));
  assert.deepEqual(activity({ live: live(), routingReady: false, routingBlocker: "owner_environment_missing" }),
    says("attention", "Not set up on its machine", 2));
  assert.deepEqual(activity({ live: { machine: { online: false, lastSeenAt: "2026-09-07T12:00:00Z" }, running: [] } }),
    says("offline", "Offline · seen 21d ago", 3));
  assert.equal(activity({ live: { machine: { online: false }, running: [] } }).line, "Offline");
  assert.deepEqual(activity({ live: live(), routingReady: false, routingBlocker: "owner_environment_disabled" }),
    says("paused", "Disabled", 4));
  assert.equal(activity({ state: "revoked" }).line, "Removed");
  assert.deepEqual(activity({ state: "disabled", live: live() }), says("paused", "Disabled", 4));
  assert.deepEqual(activity({}), says("running", "Ready", 1),
    "a Hub that reports nothing live still shows whether it can take work");
});

test("a ready registration carries no status chip; every other state says why", () => {
  assert.equal(registrationStatus(registration()), null);
  assert.deepEqual(registrationStatus(registration({ routingReady: false, routingBlocker: "owner_environment_disabled" })),
    { label: "Disabled", tone: "secondary" });
  assert.deepEqual(registrationStatus(registration({ state: "revoked" })), { label: "Removed", tone: "secondary" });
  assert.deepEqual(registrationStatus(registration({ state: "disabled" })), { label: "Disabled", tone: "secondary" });
  assert.equal(registrationStatus(registration({ state: "unshared" })).tone, "secondary");
  assert.deepEqual(registrationStatus(registration({ routingReady: false, routingBlocker: "owner_environment_missing" })),
    { label: "Not set up on its machine", tone: "alert" });
  assert.equal(registrationStatus(registration({ routingReady: false })).label, "Not ready");
});

test("a plain member sees an agent they do not own without any actions", () => {
  assert.deepEqual(registrationActions(registration()), []);
});

test("settings are edited in place by Space admins, read-only for the owner or once removed, and absent for plain members", () => {
  assert.equal(registrationSettingsMode(registration({ canConfigureSpace: true })), "edit");
  assert.equal(registrationSettingsMode(registration({ canConfigureSpace: true, state: "disabled" })), "edit");
  assert.equal(registrationSettingsMode(registration({ canConfigureSpace: true, state: "revoked" })), "read");
  assert.equal(registrationSettingsMode(registration({ canManageOwnerGrant: true })), "read");
  assert.equal(registrationSettingsMode(registration()), "none");
  assert.deepEqual(registrationActions(registration({ canConfigureSpace: true })), []);
  assert.deepEqual(registrationActions(registration({ canConfigureSpace: true, state: "disabled" })), []);
});

test("one switch per agent in the Space, for its owner and for Space owners/admins", () => {
  assert.equal(registrationSwitch(registration()), null, "a plain member has no switch");
  for (const who of [{ canConfigureSpace: true }, { canManageOwnerGrant: true }]) {
    assert.deepEqual(registrationSwitch(registration(who)), { on: true, changes: ["space-disable"] });
    assert.deepEqual(registrationSwitch(registration({ ...who, state: "disabled" })), { on: false, changes: ["space-enable"] });
  }
  assert.equal(registrationSwitch(registration({ canManageOwnerGrant: true, state: "revoked" })), null);
});

test("an agent its owner turned off on its machine shows off, and its owner's switch turns it back on", () => {
  const machineOff = { routingReady: false, routingBlocker: "owner_environment_disabled" };
  assert.deepEqual(registrationSwitch(registration({ ...machineOff, canManageOwnerGrant: true, state: "disabled" })),
    { on: false, changes: ["space-enable", "enable"] });
  assert.deepEqual(registrationSwitch(registration({ ...machineOff, canConfigureSpace: true })), { on: false, changes: [] },
    "only its owner can turn its machine back on");
});

test("only an agent's owner turns it off on its machine, and only one that is on and set up there", () => {
  assert.deepEqual(machineSwitch(registration(), "owner"), { off: false, canTurnOff: true });
  assert.deepEqual(machineSwitch(registration(), "someone-else"), { off: false, canTurnOff: false });
  assert.deepEqual(machineSwitch(undefined, "owner"), { off: false, canTurnOff: false }, "no agent here, nothing to turn off");
  assert.deepEqual(machineSwitch(registration({ routingReady: false, routingBlocker: "owner_environment_disabled" }), "owner"),
    { off: true, canTurnOff: false }, "already off there");
  assert.deepEqual(machineSwitch(registration({ routingReady: false, routingBlocker: "owner_environment_missing" }), "owner"),
    { off: false, canTurnOff: false }, "not set up there, so it has no switch");
  assert.deepEqual(machineSwitch(registration({ state: "disabled" }), "owner"), { off: false, canTurnOff: false },
    "off in this Space already takes no work here");
});

test("an agent removed from the Space is added back only by its owner", () => {
  assert.deepEqual(registrationActions(registration({ canManageOwnerGrant: true, canRemoveFromSpace: true })), []);
  assert.deepEqual(registrationActions(registration({ canManageOwnerGrant: true, state: "revoked" })), ["restore"]);
  assert.deepEqual(registrationActions(registration({ canManageOwnerGrant: true, canConfigureSpace: true, state: "revoked" })),
    ["restore"]);
  assert.deepEqual(registrationActions(registration({ canManageOwnerGrant: true, state: "unshared" })), []);
});

test("a Space admin cannot add back an agent its owner removed", () => {
  const admin = { canConfigureSpace: true, canRemoveFromSpace: true };
  assert.deepEqual(registrationActions(registration({ ...admin, state: "revoked" })), []);
});

test("a removed agent leaves the list for everyone but its owner, who can add it back", () => {
  assert.equal(registrationListed(registration()), true);
  assert.equal(registrationListed(registration({ routingReady: false, routingBlocker: "owner_environment_disabled" })), true);
  assert.equal(registrationListed(registration({ state: "revoked" })), false);
  assert.equal(registrationListed(registration({ state: "revoked", canConfigureSpace: true, canRemoveFromSpace: true })), false);
  assert.equal(registrationListed(registration({ state: "revoked", canManageOwnerGrant: true })), true);
});

test("quota status names exhausted windows and drops windows that have reset", () => {
  const now = Date.parse("2026-10-08T12:00:00Z");
  const activity = windows => registrationActivity(registration({ live: {
    machine: { online: true }, running: [], quota: { remainingPercent: 0, windows },
  } }), { conversationTitle: () => undefined, now });
  const five = { label: "5h", usedPercent: 100 };
  const week = { label: "1w", usedPercent: 100 };
  assert.equal(activity([five, { ...week, usedPercent: 50 }]).line, "5h limit reached");
  assert.equal(activity([{ ...five, usedPercent: 50 }, week]).line, "1w limit reached");
  assert.equal(activity([five, week, five]).line, "5h + 1w limit reached");
  assert.equal(activity([{ ...five, resetAt: "2026-10-08T11:00:00Z" }, week]).line, "1w limit reached");
  assert.equal(activity([{ usedPercent: 100 }]).line, "Out of quota · window unavailable");
});
