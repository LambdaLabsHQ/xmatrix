import { test } from "node:test";
import assert from "node:assert/strict";
import { withOwnerWorker } from "./owner-worker.mjs";

async function intentInPersonalSpace(call) {
  const space = (await call("/api/personal-space", { method: "POST" })).body.space;
  const created = await call("/api/setup-intents", { method: "POST", body: { spaceId: space.id } });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  return created.body;
}
const startTerminal = (call, body) => call("/api/auth/cli/device/start", { method: "POST", body, anonymous: true });
const pollTerminal = (call, deviceCode) =>
  call("/api/auth/cli/device/token", { method: "POST", body: { deviceCode }, anonymous: true });

test("a setup intent links one terminal, approved by its owner on the page", () =>
  withOwnerWorker("Owner", async ({ call }) => {
    const intent = await intentInPersonalSpace(call);
    assert.match(intent.intentId, /^[a-f0-9]{32}$/u);
    assert.equal(intent.phase, "waiting");
    const read = async () => (await call(`/api/setup-intents/${intent.intentId}`)).body;

    // An unknown intent tells the terminal to fetch a fresh command.
    const stale = await startTerminal(call, { setupIntentId: "0".repeat(32) });
    assert.equal(stale.status, 404);
    assert.equal(stale.body.code, "setup_intent_expired");

    const started = await startTerminal(call,
      { setupIntentId: intent.intentId, hostname: "daniel-laptop\u0007", platform: "linux-x64" });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const waiting = await read();
    assert.equal(waiting.phase, "approval");
    assert.deepEqual(waiting.terminal,
      { userCode: started.body.userCode, hostname: "daniel-laptop", platform: "linux-x64" });

    // One terminal at a time per command.
    const second = await startTerminal(call, { setupIntentId: intent.intentId });
    assert.equal(second.status, 409);
    assert.equal(second.body.code, "setup_intent_busy");

    // The code must be the one the terminal shows.
    const approve = (userCode) =>
      call(`/api/setup-intents/${intent.intentId}/approve`, { method: "POST", body: { userCode } });
    assert.equal((await approve("AAAA-AAAA")).status, 403);
    assert.equal((await pollTerminal(call, started.body.deviceCode)).body.status, "pending");

    const approved = await approve(started.body.userCode);
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await read()).phase, "connecting");
    const issued = await pollTerminal(call, started.body.deviceCode);
    assert.equal(issued.body.status, "approved");

    // The signed-in terminal names its Machine; until its daemon reports, it is still connecting.
    const machine = await call(`/api/setup-intents/${intent.intentId}/machine`, {
      method: "POST", body: { machineId: `machine-${crypto.randomUUID()}` }, bearer: issued.body.token,
    });
    assert.equal(machine.status, 200, JSON.stringify(machine.body));
    const after = await read();
    assert.equal(after.phase, "connecting");
    assert.deepEqual(after.registeredHarnesses, []);
  }));

test("declining a waiting terminal frees the command; a foreign Space cannot be named", () =>
  withOwnerWorker("Decliner", async ({ call }) => {
    const intent = await intentInPersonalSpace(call);
    const first = await startTerminal(call, { setupIntentId: intent.intentId });
    assert.equal(first.status, 200);
    assert.equal((await call(`/api/setup-intents/${intent.intentId}/decline`, { method: "POST", body: {} })).status, 200);
    assert.equal((await pollTerminal(call, first.body.deviceCode)).status, 404);
    const again = await startTerminal(call, { setupIntentId: intent.intentId });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    const foreign = await call("/api/setup-intents", { method: "POST", body: { spaceId: `elsewhere-${crypto.randomUUID()}` } });
    assert.notEqual(foreign.status, 200);
  }));
