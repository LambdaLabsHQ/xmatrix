import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnerWorker } from "./owner-worker.mjs";

const start = (call, body = {}) => call("/api/auth/cli/device/start", { method: "POST", body, anonymous: true });
const poll = (call, deviceCode) =>
  call("/api/auth/cli/device/token", { method: "POST", body: { deviceCode }, anonymous: true });
const describe = (call, body) => call("/api/auth/cli/device/describe", { method: "POST", body, anonymous: true });
const decline = (call, body) => call("/api/auth/cli/device/decline", { method: "POST", body, anonymous: true });

test("a waiting sign-in describes itself only to both of its codes and can be declined", () =>
  withOwnerWorker("Decliner", async ({ call }) => {
    const started = await start(call, { hostname: "studio-mac", platform: "darwin" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const { deviceCode, userCode } = started.body;

    // A wrong code reads as an unknown request, so the description is no oracle for codes.
    assert.equal((await describe(call, { deviceCode, userCode: "AAAA-AAAA" })).status, 404);
    assert.equal((await decline(call, { deviceCode, userCode: "AAAA-AAAA" })).status, 404);
    const described = await describe(call, { deviceCode, userCode });
    assert.equal(described.status, 200, JSON.stringify(described.body));
    assert.equal(described.body.hostname, "studio-mac");
    assert.equal(described.body.platform, "darwin");
    assert.ok(Date.parse(described.body.createdAt) > 0);

    assert.equal((await decline(call, { deviceCode, userCode })).status, 200);
    // The device still polling learns why its request ended, on every poll until the notice lapses.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ended = await poll(call, deviceCode);
      assert.equal(ended.body.status, "expired");
      assert.equal(ended.body.error, "This sign-in was declined in the browser.");
    }
    // A declined request cannot be approved afterwards, nor described.
    const approved = await call("/api/auth/cli/device/approve", { method: "POST", body: { deviceCode, userCode } });
    assert.equal(approved.status, 410);
    assert.equal((await describe(call, { deviceCode, userCode })).status, 404);
  }));

test("an approved sign-in can no longer be declined", () =>
  withOwnerWorker("Approver", async ({ call }) => {
    const { deviceCode, userCode } = (await start(call)).body;
    assert.equal((await call("/api/auth/cli/device/approve", { method: "POST", body: { deviceCode, userCode } })).status, 200);
    const refused = await decline(call, { deviceCode, userCode });
    assert.equal(refused.status, 409);
    assert.equal((await poll(call, deviceCode)).body.status, "approved");
  }));
