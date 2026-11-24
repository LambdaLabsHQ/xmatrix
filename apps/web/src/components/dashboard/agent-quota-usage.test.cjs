const assert = require("node:assert/strict");
const test = require("node:test");
const { compileTsModules } = require("./compile-ts-modules.cjs");

const compiled = compileTsModules(__dirname, ["agent-quota-usage"]);
const { agentBalanceReadings, agentUsageReadings, agentUsageGlance, formatResetIn } = compiled.exports;

test.after(compiled.dispose);

const now = Date.parse("2026-09-29T12:00:00Z");
const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
const quota = (windows) => ({ remainingPercent: 14, observedAt: at(-1), expiresAt: at(10), windows });

test("no reading shows no usage", () => {
  assert.deepEqual(agentUsageReadings(undefined, now), []);
});

test("each provider window is a reading, soonest reset first", () => {
  const readings = agentUsageReadings(quota([
    { label: "1w", usedPercent: 86, resetAt: at(3 * 24 * 60 + 90) },
    { label: "5h", usedPercent: 40.4, resetAt: at(134) },
  ]), now);
  assert.deepEqual(readings.map(({ label, value, detail, high }) => ({ label, value, detail, high })), [
    { label: "5-hour window", value: "40% used", detail: "resets in 2h 14m", high: false },
    { label: "Weekly", value: "86% used", detail: "resets in 3d 1h", high: false },
  ]);
  assert.ok(Math.abs(readings[0].fraction - 0.404) < 1e-9);
});

test("a window near its limit asks for attention; one that has reset is gone", () => {
  const readings = agentUsageReadings(quota([
    { label: "5h", usedPercent: 100, resetAt: at(-1) },
    { label: "7d", usedPercent: 93, resetAt: at(45) },
    { usedPercent: 12 },
  ]), now);
  assert.deepEqual(readings.map(({ label, value, detail, high }) => ({ label, value, detail, high })), [
    { label: "Weekly", value: "93% used", detail: "resets in 45m", high: true },
    { label: "Quota", value: "12% used", detail: undefined, high: false },
  ]);
});

test("a reading from before windows were kept shows its tightest share", () => {
  assert.deepEqual(agentUsageReadings(quota(undefined), now),
    [{ key: "quota", label: "Quota", value: "86% used", fraction: 0.86, high: false }]);
});

test("reset countdowns never go negative or show an unknown time", () => {
  assert.equal(formatResetIn(at(-5), now), "resets in 0m");
  assert.equal(formatResetIn("not a time", now), undefined);
  assert.equal(formatResetIn(undefined, now), undefined);
});

test("the provider's verdict on the account follows its windows", () => {
  const served = { ...quota([{ label: "1w", usedPercent: 100, resetAt: at(90) }]),
    account: { allowed: true, credits: { balance: 53079.6061305 } } };
  assert.deepEqual(agentUsageReadings(served, now).slice(1),
    [{ key: "credits", label: "Credits", value: "53,080 left", high: false }]);
  const refused = { ...quota([{ label: "5h", usedPercent: 20 }]), account: { allowed: false } };
  assert.deepEqual(agentUsageReadings(refused, now).slice(1),
    [{ key: "account", label: "Provider", value: "Refusing requests", high: true }]);
});

test("list glance keeps all measured windows with compact labels and reset context", () => {
  assert.deepEqual(agentUsageGlance(quota([
    { label: "1w", usedPercent: 93, resetAt: at(90) },
    { label: "5h", usedPercent: 40.4, resetAt: at(45) },
  ]), now), [
    { key: "5h:0", label: "5h", percent: 40, detail: "5-hour window: 40% used · resets in 45m" },
    { key: "1w:1", label: "1w", percent: 93, detail: "Weekly: 93% used · resets in 1h 30m" },
  ]);
  assert.deepEqual(agentUsageGlance(undefined, now), []);
  assert.deepEqual(agentUsageGlance({ ...quota(undefined), account: { credits: { unlimited: true } } }, now),
    [{ key: "quota", label: "Quota", percent: 86, detail: "Quota: 86% used" }]);
});

test("a model's own window is named by its scope", () => {
  const windows = quota([
    { label: "1w", usedPercent: 55, resetAt: at(90) },
    { label: "1w", usedPercent: 100, resetAt: at(90), scope: "Fable" },
  ]);
  assert.deepEqual(agentUsageReadings(windows, now).map(({ key, label }) => [key, label]),
    [["1w:0", "Weekly"], ["Fable:1w:1", "Fable · Weekly"]]);
  assert.deepEqual(agentUsageGlance(windows, now).map(({ label, percent, detail }) => [label, percent, detail]), [
    ["1w", 55, "Weekly: 55% used · resets in 1h 30m"],
    ["Fable · 1w", 100, "Fable · Weekly: 100% used · resets in 1h 30m"],
  ]);
});

test("a prepaid account reads as the money left, not as a window", () => {
  const prepaid = (amount, allowed) => ({ amount, currency: "CNY", allowed, observedAt: at(-1), expiresAt: at(10) });
  assert.deepEqual(agentBalanceReadings(undefined), []);
  assert.deepEqual(agentBalanceReadings(prepaid(12.3, true)),
    [{ key: "balance", label: "Balance", value: "¥12.30 left", high: false }]);
  assert.deepEqual(agentBalanceReadings(prepaid(0, false)).map(({ label, value, high }) => ({ label, value, high })), [
    { label: "Provider", value: "Refusing requests", high: true },
    { label: "Balance", value: "¥0.00 left", high: true },
  ]);
});

// An account the provider refuses (a billing hold) has no used-up window: the
// row and its card both say the provider refuses, never "Quota 100% used".
test("a provider refusing the account reads as that, not as a used-up quota", () => {
  const refused = { remainingPercent: 0, observedAt: at(-1), expiresAt: at(10), account: { allowed: false } };
  assert.deepEqual(agentUsageReadings(refused, now).map(({ label, value }) => ({ label, value })),
    [{ label: "Provider", value: "Refusing requests" }]);
  assert.deepEqual(agentUsageGlance(refused, now), []);
});
