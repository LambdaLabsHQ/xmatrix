import { createClosedChannel, homeSpaceId, startMockUserHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

async function preference(worker, spaceId, name, body) {
  return json(await worker.fetch(`/api/spaces/${encodeURIComponent(spaceId)}/${name}-preference`, {
    method: body ? "PATCH" : "GET",
    headers: { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
}

test("a Human's Channel pins and locale persist through the preference routes", async () => {
  const worker = await startMockUserHubWorker({ id: `preferences-${randomUUID()}`, email: "preferences@example.com", name: "Preferences" });
  try {
    const spaceId = await homeSpaceId(worker);
    const channel = await createClosedChannel(worker, `pinned-${randomUUID()}`);

    const view = await preference(worker, spaceId, "channel-view");
    assert.deepEqual(view.pinnedChannelIds, []);
    const pinned = await preference(worker, spaceId, "channel-view",
      { expectedVersion: view.version, pinnedChannelIds: [channel.id] });
    assert.deepEqual(pinned.pinnedChannelIds, [channel.id]);
    assert.equal(pinned.version, view.version + 1);
    assert.deepEqual((await preference(worker, spaceId, "channel-view")).pinnedChannelIds, [channel.id]);

    const locale = await preference(worker, spaceId, "locale");
    const updated = await preference(worker, spaceId, "locale",
      { expectedVersion: locale.version, displayLocale: "zh-CN" });
    assert.equal(updated.displayLocale, "zh-CN");
    assert.equal((await preference(worker, spaceId, "locale")).displayLocale, "zh-CN");
  } finally {
    await worker.stop();
  }
});
