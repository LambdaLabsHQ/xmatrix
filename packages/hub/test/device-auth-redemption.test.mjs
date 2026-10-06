import assert from "node:assert/strict";
import test from "node:test";

import {
  boundedRedemptionExpiry,
  DeviceAuthRedemptionCoordinator,
} from "../src/device-auth-redemption.ts";

const issuedSession = {
  token: "device-session-token",
  refreshToken: "device-refresh-token",
  authProvider: "better-auth",
  user: {
    id: "user-1",
    email: "person@example.com",
    name: "Person",
  },
};

test("device auth redemption keeps only a bounded replay window", () => {
  assert.equal(
    boundedRedemptionExpiry(
      "2026-09-15T01:10:00.000Z",
      "2026-09-15T01:01:00.000Z",
      120_000,
    ),
    "2026-09-15T01:03:00.000Z",
  );
  assert.equal(
    boundedRedemptionExpiry(
      "2026-09-15T01:02:00.000Z",
      "2026-09-15T01:01:00.000Z",
      120_000,
    ),
    "2026-09-15T01:02:00.000Z",
  );
});

test("device auth redemption replays a durably issued session", async () => {
  const coordinator = new DeviceAuthRedemptionCoordinator();
  let issueCalls = 0;
  let persistCalls = 0;

  const result = await coordinator.redeem({
    deviceCode: "device-code",
    session: { issuedSession },
    issue: async () => {
      issueCalls += 1;
      throw new Error("must not issue again");
    },
    persist: async () => {
      persistCalls += 1;
    },
  });

  assert.deepEqual(result, { issuedSession, replayed: true });
  assert.equal(issueCalls, 0);
  assert.equal(persistCalls, 0);
});

test("concurrent device token polls share one durable issuance", async () => {
  const coordinator = new DeviceAuthRedemptionCoordinator();
  let issueCalls = 0;
  const persisted = [];
  let finishIssuance;
  const issuanceGate = new Promise((resolve) => {
    finishIssuance = resolve;
  });
  const options = {
    deviceCode: "device-code",
    session: {},
    issue: async () => {
      issueCalls += 1;
      await issuanceGate;
      return issuedSession;
    },
    persist: async (value, issuedAt) => {
      persisted.push({ value, issuedAt });
    },
  };

  const first = coordinator.redeem(options);
  const second = coordinator.redeem(options);
  finishIssuance();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.deepEqual(firstResult, { issuedSession, replayed: false });
  assert.deepEqual(secondResult, { issuedSession, replayed: true });
  assert.equal(issueCalls, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].value, issuedSession);
  assert.ok(!Number.isNaN(Date.parse(persisted[0].issuedAt)));
});
