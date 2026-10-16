import assert from "node:assert/strict";
import test from "node:test";
import { XUploadExecutor } from "../src/connectors/x-upload-executor.ts";

const ref = { requestId: "upload-request-1", spaceId: "space-1", channelId: "channel-1" };
const result = { status: "completed", receipt: "private-media-receipt" };
const canonical = { request: { ...ref, connectionId: "space-1:x", providerId: "x", actionId: "upload_video", requestedBy: "owner" },
  payload: { messageId: "command-1", senderKind: "agent", senderId: "agent-1", statement: { target: "101", text: "message/video" },
    prepared: { accountId: "101", accountGeneration: "grant-1", sourceName: "private-source.mp4" }, preview: {} } };

function fixture() {
  let job, alarmAt = null, clock = 1000, outcome = null, executing = canonical;
  const calls = { execution: [], settlement: [], publication: [], clear: [] };
  const storage = {
    async get() { return structuredClone(job); },
    async put(_key, value) { job = structuredClone(value); },
    async setAlarm(at) { alarmAt = at; },
    async deleteAlarm() { alarmAt = null; },
    async transaction(operation) {
      let staged = structuredClone(job), nextAlarm = alarmAt;
      const value = await operation({
        async get() { return structuredClone(staged); },
        async put(_key, value) { staged = structuredClone(value); },
        async setAlarm(at) { nextAlarm = at; }, async deleteAlarm() { nextAlarm = null; },
      });
      job = staged; alarmAt = nextAlarm;
      return value;
    },
  };
  // Ports stand for independently tested PostgreSQL approval/outcome authority
  // and the idempotent Channel publisher. Assertions here own the executor's
  // durable scheduling, privacy and no-repeat provider lifecycle only.
  const operations = {
    async executingUpload() { return executing; },
    async settleUpload(input) {
      calls.settlement.push(input);
      executing = null;
      outcome = { request: canonical.request, payload: { messageId: canonical.payload.messageId,
        senderKind: canonical.payload.senderKind, senderId: canonical.payload.senderId }, status: input.status, receipt: input.receipt };
      return { stored: true };
    },
    async uploadOutcome() { return outcome; },
    async clearUploadOutcome(input) { calls.clear.push(input); outcome = null; },
    async execute(input) { calls.execution.push(input); return result; },
    async publish(input) { calls.publication.push(input); },
  };
  const create = () => new XUploadExecutor(storage, operations, () => clock);
  return { storage, operations, calls, create, job: () => structuredClone(job), alarm: () => alarmAt,
    advance: ms => { clock += ms; }, setExecuting: value => { executing = value; },
    setOutcome: value => { outcome = value; } };
}

test("X upload admission durably stores only a scoped reference and alarm before returning", async () => {
  const f = fixture(), executor = f.create();
  await executor.enqueue({ ...ref, accessToken: "must-never-be-stored", payload: canonical.payload });
  assert.deepEqual(f.job(), { ...ref, phase: "queued", attempts: 0 });
  assert.equal(f.alarm(), 1001);
  assert.equal(f.calls.execution.length, 0, "admission cannot run the provider inside the HTTP request");
  await executor.enqueue(ref);
  for (const changed of [{ spaceId: "other" }, { channelId: "other" }, { requestId: "other" }]) {
    await assert.rejects(executor.enqueue({ ...ref, ...changed }), /reference mismatch/u);
  }
  for (const changed of [{ spaceId: "" }, { channelId: "\nchannel" }, { requestId: "a".repeat(241) }]) {
    await assert.rejects(executor.enqueue({ ...ref, ...changed }), /Invalid X upload reference/u);
  }
  assert.deepEqual(f.job(), { ...ref, phase: "queued", attempts: 0 });
});

test("X upload persists started and a recovery alarm before its single provider execution", async () => {
  const f = fixture();
  f.operations.execute = async job => {
    assert.deepEqual(f.job(), { ...ref, phase: "started", attempts: 0 });
    assert.equal(f.alarm(), 151000);
    assert.deepEqual(job, canonical, "execution input comes from the canonical approval owner");
    f.calls.execution.push(job);
    return result;
  };
  await f.create().enqueue(ref);
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1);
  assert.equal(f.calls.publication.length, 1);
  assert.deepEqual(f.calls.settlement, [{ ...ref, ...result }]);
  assert.equal(f.calls.clear.length, 1);
  assert.equal(f.job().phase, "done");
  assert.equal(f.alarm(), null);
  assert.doesNotMatch(JSON.stringify(f.job()), /private-source|private-media-receipt|prepared|payload|token/iu);
  await f.create().enqueue(ref);
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1, "replayed admission and alarms cannot repeat a completed upload");
});

test("X upload restart with started and no outcome publishes uncertainty without repeating provider I/O", async () => {
  const f = fixture();
  await f.create().enqueue(ref);
  await f.storage.put("job:v1", { ...ref, phase: "started", attempts: 0 });
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 0);
  assert.equal(f.calls.settlement.length, 1);
  assert.equal(f.calls.settlement[0].status, "failed");
  assert.match(f.calls.settlement[0].receipt, /without a confirmed result.*not automatically retried/u);
  assert.equal(f.calls.publication[0].receipt, f.calls.settlement[0].receipt);
  assert.equal(f.job().phase, "done");
});

test("X upload exceptions produce one uncertain result and no provider retry", async () => {
  const f = fixture();
  f.operations.execute = async input => { f.calls.execution.push(input); throw new Error("private-provider-secret"); };
  await f.create().enqueue(ref);
  await f.create().alarm();
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1);
  assert.equal(f.calls.publication.length, 1);
  assert.equal(f.calls.publication[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(f.calls.publication), /private-provider-secret/u);
});

test("X upload retries a persisted result after restart and clears it only after confirmed publication", async () => {
  const f = fixture();
  await f.create().enqueue(ref);
  const publish = f.operations.publish;
  let attempts = 0;
  f.operations.publish = async outcome => {
    await publish(outcome);
    if (++attempts === 1) throw new Error("append response lost");
  };
  await f.create().alarm();
  assert.equal(f.job().phase, "started");
  assert.equal(f.job().attempts, 1);
  assert.equal(f.alarm(), 3000);
  assert.equal(f.calls.clear.length, 0, "an uncertain Channel append retains the PostgreSQL outcome");
  f.advance(2000);
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1);
  assert.equal(f.calls.publication.length, 2);
  assert.deepEqual(f.calls.publication[0], f.calls.publication[1], "delivery reuses the same canonical immutable result");
  assert.equal(f.calls.clear.length, 1);
  assert.equal(f.job().phase, "done");
});

test("X upload settlement failure cannot cause a second provider mutation on recovery", async () => {
  const f = fixture();
  const settle = f.operations.settleUpload;
  let attempts = 0;
  f.operations.settleUpload = async input => {
    if (++attempts === 1) throw new Error("database unavailable after provider completion");
    return settle(input);
  };
  await f.create().enqueue(ref);
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1);
  assert.equal(f.job().phase, "started");
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 1);
  assert.equal(f.calls.publication[0].status, "failed");
  assert.match(f.calls.publication[0].receipt, /without a confirmed result/u);
});

test("X upload missing canonical execution and outcome terminates without inventing authority", async () => {
  const f = fixture();
  f.setExecuting(null);
  await f.create().enqueue(ref);
  await f.create().alarm();
  assert.equal(f.job().phase, "done");
  assert.equal(f.calls.execution.length, 0);
  assert.equal(f.calls.settlement.length, 0);
  assert.equal(f.calls.publication.length, 0);
});

test("X upload delivery retries are bounded with capped backoff and explicit wake resumes delivery only", async t => {
  const f = fixture();
  await f.create().enqueue(ref);
  await f.storage.put("job:v1", { ...ref, phase: "started", attempts: 0 });
  const outcome = { request: canonical.request, payload: { messageId: "command-1", senderKind: "agent", senderId: "agent-1" }, ...result };
  f.setOutcome(outcome);
  const publish = f.operations.publish;
  f.operations.publish = async value => { f.calls.publication.push(value); throw new Error("private-delivery-diagnostic"); };
  const warn = t.mock.method(console, "warn", () => {});
  for (let attempt = 1; attempt <= 12; attempt++) {
    await f.create().alarm();
    assert.equal(f.job().attempts, attempt);
    if (attempt < 12) {
      const delay = f.alarm() - (1000 + (attempt - 1) * 60000);
      assert.equal(delay, Math.min(60000, 2000 * 2 ** (attempt - 1)));
      f.advance(60000);
    }
  }
  assert.equal(f.alarm(), null);
  assert.equal(f.calls.clear.length, 0);
  assert.equal(f.calls.execution.length, 0);
  assert.equal(warn.mock.callCount(), 1);
  assert.doesNotMatch(JSON.stringify(warn.mock.calls), /private-delivery-diagnostic|private-media-receipt/u);
  f.operations.publish = publish;
  await f.create().enqueue(ref);
  assert.equal(f.job().attempts, 0);
  await f.create().alarm();
  assert.equal(f.calls.execution.length, 0);
  assert.equal(f.calls.clear.length, 1);
  assert.equal(f.job().phase, "done");
});
