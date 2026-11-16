import { homeSpaceId, inTestTransaction, startPgHubWorker as startHubWorker } from "./agent-launch-postgres.fixture.mjs";
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

/* A Run's worktree once registered itself as a Workspace and was then offered
   as a `pwd:` launch target long after its Run was gone. */
test("a directory xMatrix owns is never a Workspace or a launch target", async () => {
  const userId = `workspace-owned-dir-e2e-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "workspace-owned-dir-e2e@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Workspace Owned Dir E2E",
    },
  });
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const machineId = `machine:workspace-owned-dir-${randomUUID()}`;
    const register = canonicalCwd => worker.fetch("/api/workspaces", {
      method: "POST", headers: auth, body: JSON.stringify({ machineId, canonicalCwd }),
    });
    for (const canonicalCwd of [
      `/Users/dev/.xmatrix/worktrees/${randomUUID()}`,
      "/home/dev/.xmatrix/repos/mirror",
      `/home/dev/.config/xmatrix/repo-pools/c86b1295/${randomUUID()}`,
      String.raw`C:\Users\Dev\.xmatrix\worktrees\run`,
    ]) {
      assert.equal((await register(canonicalCwd)).status, 400, canonicalCwd);
    }
    const project = `/home/dev/Projects/xmatrix-${randomUUID()}`;
    const legacy = `/home/dev/Projects/legacy-${randomUUID()}`;
    assert.equal((await register(project)).status, 201);
    assert.equal((await register(legacy)).status, 201);
    // A record an older client registered before the Hub refused these paths.
    const worktree = `/Users/dev/.xmatrix/worktrees/${randomUUID()}`;
    await inTestTransaction(tx => tx.query({
      text: "UPDATE data.workspaces SET canonical_cwd = $1 WHERE machine_id = $2 AND canonical_cwd = $3",
      values: [worktree, machineId, legacy],
    }));
    const spaceId = await homeSpaceId(worker);
    const targets = await json(await worker.fetch(
      `/api/spaces/${encodeURIComponent(spaceId)}/launch-targets`, { headers: auth }));
    assert.deepEqual(targets.workspaces.map(workspace => workspace.canonicalCwd), [project]);
    // The owner still sees it, so it can be unregistered.
    const listed = await json(await worker.fetch("/api/workspaces", { headers: auth }));
    assert.ok(listed.workspaces.some(workspace => workspace.canonicalCwd === worktree));
  } finally {
    await worker.stop();
  }
});
