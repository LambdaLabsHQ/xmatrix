import { startPgHubWorker as startHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { assert, json, MOCK_TOKEN, randomUUID, test } from "./agent-mention-spawn.fixture.mjs";

test("workspace registration is Authority-owned and machine-bound", async () => {
  const userId = `workspace-authority-e2e-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "workspace-authority-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Workspace Authority E2E",
    },
  });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}` };
    const machineId = `machine:workspace-authority-${randomUUID()}`;
    const hostId = `workspace-authority-host-${randomUUID()}`;
    const canonicalCwd = `/tmp/xmatrix-workspace-${randomUUID()}`;
    const created = await json(await worker.fetch("/api/workspaces", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({
        machineId,
        hostId,
        hostName: hostId,
        canonicalCwd,
        displayName: "xmatrix",
        runtime: "codex",
      }),
    }));
    assert.equal("id" in created.workspace, false);
    assert.equal(created.workspace.machineId, machineId);
    assert.equal(created.workspace.hostId, hostId);
    const listed = await json(await worker.fetch("/api/workspaces", { headers: auth }));
    const workspace = listed.workspaces.find((item) =>
      item.machineId === machineId && item.canonicalCwd === canonicalCwd
    );
    assert.equal(workspace?.canonicalCwd, canonicalCwd);
    assert.equal(workspace?.machineId, machineId);
  } finally {
    await worker.stop();
  }
});
