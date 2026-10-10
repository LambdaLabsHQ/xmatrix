import assert from "node:assert/strict";
import test from "node:test";

import { PostgresPushDeviceRepository, PushDeviceError } from "../dist/index.js";
import { recordingDatabase } from "./recording-database.fixture.mjs";

const invalidDevice = (error) => error instanceof PushDeviceError && error.status === 400;

test("a phone registers its token and a person keeps a bounded number of devices", async () => {
  const db = recordingDatabase();
  const devices = new PostgresPushDeviceRepository(db);
  const first = await devices.register({ requestId: "r1", userId: "user-1", platform: "apns", token: "ab".repeat(32) });
  const again = await devices.register({ requestId: "r2", userId: "user-2", platform: "apns", token: "ab".repeat(32) });
  const other = await devices.register({ requestId: "r3", userId: "user-1", platform: "fcm", token: "ab".repeat(32) });
  assert.match(first.deviceId, /^[0-9a-f]{64}$/u);
  assert.equal(again.deviceId, first.deviceId, "the same token is the same device, whoever registers it");
  assert.notEqual(other.deviceId, first.deviceId, "the same token on another platform is another device");

  const writes = db.calls.filter((call) => call.name === "push_device_register_v1");
  assert.deepEqual(writes.map((call) => call.values.slice(0, 5)), [
    [first.deviceId, "user-1", "apns", "ab".repeat(32), null],
    [first.deviceId, "user-2", "apns", "ab".repeat(32), null],
    [other.deviceId, "user-1", "fcm", "ab".repeat(32), null],
  ]);
  const trims = db.calls.filter((call) => call.name === "push_device_trim_v1");
  assert.deepEqual(trims.map((call) => call.values), [["user-1", 20], ["user-2", 20], ["user-1", 20]]);
});

test("a browser registers its subscription with its keys", async () => {
  const db = recordingDatabase();
  const devices = new PostgresPushDeviceRepository(db);
  await devices.register({ requestId: "r1", userId: "user-1", platform: "webpush",
    token: "https://push.example.test/send/abc", keys: { p256dh: "BPubKey_-1", auth: "authSecret" } });
  const write = db.calls.find((call) => call.name === "push_device_register_v1");
  assert.deepEqual(JSON.parse(write.values[4]), { p256dh: "BPubKey_-1", auth: "authSecret" });
});

test("what is not a device is refused before anything is written", async () => {
  const db = recordingDatabase();
  const devices = new PostgresPushDeviceRepository(db);
  const base = { requestId: "r1", userId: "user-1" };
  for (const device of [
    { platform: "sms", token: "123" },
    { platform: "apns", token: "" },
    { platform: "apns", token: "not hexadecimal" },
    { platform: "webpush", token: "http://push.example.test/send/abc", keys: { p256dh: "a", auth: "b" } },
    { platform: "webpush", token: "https://push.example.test/send/abc" },
    { platform: "webpush", token: "https://push.example.test/send/abc", keys: { p256dh: "a b", auth: "b" } },
  ]) await assert.rejects(devices.register({ ...base, ...device }), invalidDevice, JSON.stringify(device));
  await assert.rejects(devices.unregister({ ...base, deviceId: "nope" }), invalidDevice);
  assert.equal(db.calls.some((call) => call.name), false);
});

test("devices are listed for the people asked and forgotten by id", async () => {
  const db = recordingDatabase((query) => query.name === "push_device_list_v1" ? [
    { device_id: "a".repeat(64), user_id: "user-1", platform: "apns", token: "ab".repeat(32), keys_json: null },
    { device_id: "b".repeat(64), user_id: "user-2", platform: "webpush", token: "https://push.example.test/x",
      keys_json: { p256dh: "pub", auth: "secret" } },
  ] : []);
  const devices = new PostgresPushDeviceRepository(db);
  assert.deepEqual(await devices.listForUsers({ requestId: "r1", userIds: [] }), []);
  assert.deepEqual(await devices.listForUsers({ requestId: "r2", userIds: ["user-1", "user-2", "user-1"] }), [
    { deviceId: "a".repeat(64), userId: "user-1", platform: "apns", token: "ab".repeat(32) },
    { deviceId: "b".repeat(64), userId: "user-2", platform: "webpush", token: "https://push.example.test/x",
      keys: { p256dh: "pub", auth: "secret" } },
  ]);
  const list = db.calls.find((call) => call.name === "push_device_list_v1");
  assert.deepEqual(list.values, [["user-1", "user-2"], 40]);

  await devices.unregister({ requestId: "r3", userId: "user-1", deviceId: "a".repeat(64) });
  await devices.forget({ requestId: "r4", deviceIds: ["b".repeat(64), "b".repeat(64)] });
  assert.deepEqual(db.calls.find((call) => call.name === "push_device_unregister_v1").values, ["a".repeat(64), "user-1"]);
  assert.deepEqual(db.calls.find((call) => call.name === "push_device_forget_v1").values, [["b".repeat(64)]]);
});
