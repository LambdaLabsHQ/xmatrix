import assert from "node:assert/strict";
import { integration, isolatedPostgres } from "../../db/test/postgres-database.fixture.mjs";
import { PostgresPushDeviceRepository, PushDeviceError } from "../../db/src/index.ts";
import { pushToPeople } from "../src/push/notify.ts";

// The existing provider tests own expiry evidence and deadlines. This real
// database boundary catches retirement silently dropping the tail of a batch;
// a mocked forget method cannot detect that loss.
integration("one notification retires its whole gone set and preserves other registrations", async (t) => {
  const f = await isolatedPostgres("push_retirement", { shard: true });
  t.mock.method(console, "warn", () => {});
  const devices = new PostgresPushDeviceRepository(f.session);
  const notification = { channelId: "channel", messageId: "message", title: "Agent", body: "Ready" };
  const config = { fcm: { projectId: "test", clientEmail: "test@example.test", privateKey: "unused" } };
  const id = n => n.toString(16).padStart(64, "0");
  try {
    for (const [total, gone] of [[1020, 1001], [10000, 10000]]) {
      await f.run("TRUNCATE control.push_devices");
      await f.run(`INSERT INTO control.push_devices(device_id,user_id,platform,token)
        SELECT lpad(to_hex(n),64,'0'),'recipient-'||((n-1)/20),'fcm',n::text
        FROM generate_series(1,$1::integer) n`, [total]);
      await devices.register({ requestId: "outside", userId: "outside", platform: "fcm", token: "outside" });
      const userIds = Array.from({ length: total / 20 }, (_, n) => `recipient-${n}`);
      const listed = await devices.listForUsers({ requestId: "before", userIds });
      assert.equal(listed.length, total);
      const attempted = new Set();
      const result = await pushToPeople({ config, devices, userIds, notification, send: async device => {
        attempted.add(device.deviceId);
        const n = Number(device.token);
        return n <= gone ? "gone" : n === gone + 1 ? "failed" : n === gone + 2 ? "skipped" : "sent";
      } });
      assert.equal(attempted.size, total);
      assert.deepEqual(result, { gone, failed: total > gone ? 1 : 0, sent: total > gone ? total - gone - 2 : 0 });
      const remaining = async () => (await f.run("SELECT device_id FROM control.push_devices ORDER BY device_id"))
        .map(row => row.device_id).sort();
      const outside = await devices.listForUsers({ requestId: "outside-read", userIds: ["outside"] });
      const expected = [...Array.from({ length: total - gone }, (_, n) => id(gone + n + 1)), outside[0].deviceId].sort();
      assert.deepEqual(await remaining(), expected, "only timely gone outcomes authorize retirement");
      // Duplicate evidence and an acknowledgement replay are both harmless.
      const goneIds = Array.from({ length: gone }, (_, n) => id(n + 1));
      await devices.forget({ requestId: "replay", deviceIds: [...goneIds, ...goneIds] });
      assert.deepEqual(await remaining(), expected);
    }
    // Oversized evidence must fail before any mutation rather than look complete.
    await assert.rejects(devices.forget({ requestId: "oversized", deviceIds: Array.from({ length: 10001 }, (_, n) => id(n)) }),
      error => error instanceof PushDeviceError && error.status === 400);
    assert.equal((await f.run("SELECT count(*)::integer AS n FROM control.push_devices"))[0].n, 1);
    // A real refusal after earlier deletions must roll the complete set back.
    await f.run(`INSERT INTO control.push_devices(device_id,user_id,platform,token)
      SELECT lpad(to_hex(n),64,'0'),'rollback-'||((n-1)/20),'fcm',n::text
      FROM generate_series(1,1001) n;
      CREATE FUNCTION control.refuse_push_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.token='1001' THEN RAISE EXCEPTION 'test retirement refusal'; END IF; RETURN OLD; END $$;
      CREATE TRIGGER refuse_retirement BEFORE DELETE ON control.push_devices
        FOR EACH ROW EXECUTE FUNCTION control.refuse_push_retirement()`);
    const deviceIds = Array.from({ length: 1001 }, (_, n) => id(n + 1));
    await assert.rejects(devices.forget({ requestId: "refused", deviceIds }), /test retirement refusal/);
    assert.equal((await f.run("SELECT count(*)::integer AS n FROM control.push_devices"))[0].n, 1002);
    await f.run("DROP TRIGGER refuse_retirement ON control.push_devices");
    await devices.forget({ requestId: "retry", deviceIds });
    assert.deepEqual((await f.run("SELECT user_id FROM control.push_devices")), [{ user_id: "outside" }]);
  } finally { await f.close(); }
});
