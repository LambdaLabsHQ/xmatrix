import assert from "node:assert/strict";
import test from "node:test";
import { registrationLiveQuota } from "../dist/agent-registration-quota-probe.js";

const reading = { remainingPercent: 100, observedAt: "2026-11-14T21:40:09.471Z", expiresAt: "2026-11-14T21:55:09.471Z" };
const window = { label: "1mo", usedPercent: 33, resetAt: "2026-12-10T17:29:34.000Z" };

test("a prepaid balance is listed as money and never as a share a balance-unaware client draws as a percentage", () => {
  const listed = registrationLiveQuota(reading, [], { allowed: true, credits: { balance: 6.57, currency: "CNY" } });
  assert.deepEqual(listed, { balance: { amount: 6.57, currency: "CNY", allowed: true,
    observedAt: reading.observedAt, expiresAt: reading.expiresAt } });
  assert.equal("quota" in listed, false, "an older `agent list` reads live.quota.remainingPercent and finds none");
  assert.deepEqual(registrationLiveQuota({ ...reading, remainingPercent: 0 }, [],
    { allowed: false, credits: { balance: 0, currency: "USD" } }).balance,
    { amount: 0, currency: "USD", allowed: false, observedAt: reading.observedAt, expiresAt: reading.expiresAt });
});

test("a windowed reading, with or without credit units, stays a quota", () => {
  const credits = { allowed: true, credits: { balance: 52445.47 } };
  assert.deepEqual(registrationLiveQuota({ ...reading, remainingPercent: 67 }, [window], credits),
    { quota: { remainingPercent: 67, observedAt: reading.observedAt, expiresAt: reading.expiresAt,
      windows: [window], account: credits } });
  // Money beside a window is the window's account detail, not a prepaid reading.
  const money = { credits: { balance: 3, currency: "USD" } };
  assert.deepEqual(Object.keys(registrationLiveQuota(reading, [window], money)), ["quota"]);
  assert.deepEqual(registrationLiveQuota(reading, [], undefined), { quota: reading });
  assert.deepEqual(registrationLiveQuota(undefined, [], money), {});
});
