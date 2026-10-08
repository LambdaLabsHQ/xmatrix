import { expect, test } from "./fixtures";
import { E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies,
  openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);
const MACHINE = "machine:worktree-test";
const LIST = "worktree:00000000-0000-4000-8000-000000000001";
const RECLAIM = "worktree:00000000-0000-4000-8000-000000000002";
const DAY = 24 * 60 * 60;
const GB = 1024 ** 3;
const daemon = {
  id: "daemon-worktree", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Worktree machine",
  machineId: MACHINE, machineName: "Worktree machine", hostId: "host-worktree", hostName: "Worktree machine", status: "online",
  connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "1.0.120",
  metadata: { platform: "linux", capabilities: ["machine_harness_action_v1", "machine_worktree_action_v1"] },
};
const trees = [
  { path: "/home/e2e/.config/xmatrix/repo-pools/b4/slot1", origin: "repo-pool", locked: false, missing: false, inUse: true,
    idleSecs: 3_600, sizeBytes: 5 * GB, branch: "main" },
  { path: "/tmp/acpcheck", origin: "manual", locked: false, missing: false, inUse: false, idleSecs: 9 * DAY, sizeBytes: 7 * GB },
  { path: "/repo/.claude/worktrees/agent-a81f", origin: "claude-code", locked: false, missing: false, inUse: false,
    idleSecs: 8 * DAY, sizeBytes: 3 * GB, unlanded: true, branch: "worktree-agent-a81f" },
  { path: "/tmp/fresh", origin: "manual", locked: false, missing: false, inUse: false, idleSecs: 2 * DAY, sizeBytes: 9 * GB },
  { path: "/tmp/review", origin: "manual", locked: true, missing: false, inUse: false, idleSecs: 20 * DAY, sizeBytes: GB },
];
const listing = { controlId: LIST, action: "list", status: "succeeded", requestedAt: new Date().toISOString(),
  result: { action: "list", status: "succeeded",
    inventory: { capturedAt: new Date().toISOString().replace(/\.\d+Z$/u, "Z"), foreignAutoReclaim: false, trees } } };

async function openMachine(page: Parameters<typeof openWorkspaceWithStubs>[0]) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [daemon] });
  await fixtureJson(page, "harness-recent", /\/api\/xmatrix\/machine-daemons\/harness-actions\?machineId=/u, { actions: [] });
  await fixtureJson(page, "worktree-latest", /\/api\/xmatrix\/machine-daemons\/worktree-actions\?machineId=/u, { listing });
  await page.goto("/app/personal-sspaceperso/machines");
  await page.locator('[data-testid="machine-row"]').filter({ hasText: "Worktree machine" }).click();
  await expect(page.getByTestId("machine-worktrees-panel")).toBeVisible();
}

test("worktrees list largest first and one button cleans up every idle one harnesses created", async ({ page }) => {
  await openMachine(page);
  const panel = page.getByTestId("machine-worktrees-panel");
  await expect(page.getByRole("region", { name: /Worktrees · 5 · 25 GB/u })).toBeVisible();
  await expect(panel.getByTestId("machine-worktree").first()).toContainText("fresh");
  await expect(panel).toContainText("4 created by harnesses · 20 GB · 2 idle 7+ days");
  await expect(panel.getByRole("switch", { name: "Clean up worktrees created by harnesses" }))
    .toHaveAttribute("aria-checked", "false");
  const xmatrixRow = panel.getByTestId("machine-worktree").filter({ hasText: "slot1" });
  await expect(xmatrixRow).toContainText("In use");
  await expect(xmatrixRow.getByRole("button")).toHaveCount(0);
  await expect(panel.getByTestId("machine-worktree").filter({ hasText: "review" }).getByRole("button")).toHaveCount(0);

  await fixtureJson(page, "worktree-action", "**/api/xmatrix/machine-daemons/worktree-actions", { controlId: RECLAIM, status: "queued" });
  await fixtureJson(page, "worktree-status", "**/api/xmatrix/machine-daemons/worktree-actions/*",
    { controlId: RECLAIM, action: "reclaim", status: "succeeded", result: { action: "reclaim", status: "succeeded",
      reclaimed: [{ path: "/tmp/acpcheck", snapshotted: false }, { path: "/repo/.claude/worktrees/agent-a81f", snapshotted: true }],
      kept: [] } });
  await panel.getByRole("button", { name: "Clean up 2 idle" }).click();
  await panel.getByRole("button", { name: "Confirm: clean up 2 · 10 GB" }).click();
  await expect(panel.getByText("Cleaned up 2 worktrees, freed 10 GB.")).toBeVisible();
  expect(await fixtureRequestBodies(page, "worktree-action")).toEqual([
    { machineId: MACHINE, action: "reclaim", paths: ["/tmp/acpcheck", "/repo/.claude/worktrees/agent-a81f"] },
  ]);
  await expect(panel.getByTestId("machine-worktree")).toHaveCount(3);
  const overflows = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(overflows).toBe(false);
});

test("automatic clean-up of harness worktrees is off until the owner turns it on", async ({ page }) => {
  await openMachine(page);
  const panel = page.getByTestId("machine-worktrees-panel");
  await fixtureJson(page, "worktree-action", "**/api/xmatrix/machine-daemons/worktree-actions", { controlId: RECLAIM, status: "queued" });
  await fixtureJson(page, "worktree-status", "**/api/xmatrix/machine-daemons/worktree-actions/*",
    { controlId: RECLAIM, action: "auto_reclaim_on", status: "succeeded",
      result: { action: "auto_reclaim_on", status: "succeeded", foreignAutoReclaim: true } });
  const toggle = panel.getByRole("switch", { name: "Clean up worktrees created by harnesses" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  await expect(panel).toContainText("cleaned up after 7 idle days");
  expect(await fixtureRequestBodies(page, "worktree-action")).toEqual([{ machineId: MACHINE, action: "auto_reclaim_on" }]);
});
