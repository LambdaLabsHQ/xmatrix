import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

test("a Space owner deletes a Space, finds it among restorable deletions, and restores it", async () => {
  const token = "space-deletion-owner";
  const userId = `space-deleter-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: token,
    XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "space-deleter@example.com",
    XMATRIX_MOCK_AUTH_NAME: "Space Deleter",
  } });
  try {
    const headers = { Authorization: `Bearer ${token}`, "content-type": "application/json" };
    const created = await worker.fetch("/api/spaces", {
      method: "POST", headers, body: JSON.stringify({ name: "Doomed team" }),
    });
    assert.equal(created.status, 200, await created.clone().text());
    const { space } = await created.json();
    const channel = await worker.fetch("/api/channels", {
      method: "POST", headers, body: JSON.stringify({ name: "general", spaceId: space.id }),
    });
    assert.equal(channel.status < 300, true, await channel.clone().text());
    const listed = async () => (await (await worker.fetch("/api/spaces", { headers })).json())
      .spaces.map((item) => item.id);
    assert.ok((await listed()).includes(space.id));

    const deleted = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}`, {
      method: "DELETE", headers,
    });
    assert.equal(deleted.status, 200, await deleted.clone().text());
    const { deletion } = await deleted.json();
    assert.equal(deletion.spaceId, space.id);
    assert.equal(deletion.state, "scheduled");
    assert.equal(Date.parse(deletion.purgeAfter) - Date.parse(deletion.requestedAt), 7 * 24 * 60 * 60 * 1000);
    assert.equal((await listed()).includes(space.id), false, "a deleted Space leaves the owner's list at once");
    const read = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}`, { headers });
    assert.equal(read.status >= 400, true, "and can no longer be read");

    const deletions = await (await worker.fetch("/api/space-deletions", { headers })).json();
    assert.deepEqual(deletions.deletions.map((item) => [item.spaceId, item.spaceName]), [[space.id, "Doomed team"]]);

    const restored = await worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}/restore`, {
      method: "POST", headers,
    });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.ok((await listed()).includes(space.id), "the restored Space is back with its members");
    assert.deepEqual((await (await worker.fetch("/api/space-deletions", { headers })).json()).deletions, []);

    const remove = () => worker.fetch(`/api/spaces/${encodeURIComponent(space.id)}`, { method: "DELETE", headers });
    const again = await remove();
    assert.equal(again.status, 200, await again.clone().text());
    const scheduled = (await again.json()).deletion;
    assert.notEqual(scheduled.requestedAt, deletion.requestedAt, "a restored Space can be deleted again");
    const repeated = await remove();
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.deepEqual((await repeated.json()).deletion, scheduled, "repeating the request returns the same deletion");
  } finally {
    await worker.stop();
  }
});
