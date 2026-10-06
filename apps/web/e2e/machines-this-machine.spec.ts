import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRule, openWorkspaceWithStubs } from "./workspace-fixtures";

/* On the desktop app its own machine is the Hub's Machine with exactly the id
   its CLI reports, whatever name the owner gave it. Nothing else stands in for
   that id: a host name never makes another record this machine. */
const MACHINE_ID = "machine:4f1c0de0e2e000000000000000000000000000000000000000000000000000a1";
const HOST = "Daniels-MacBook-Air.local";

const workspace = (machineId: string, hostName: string, name: string) => ({
  machineId, canonicalCwd: `/Users/e2e/${name}`, ownerUserId: "e2e-user", hostId: hostName, hostName,
  displayName: name, runtimesSeen: ["claude"], boundChannelIds: [], visibility: "space",
  createdAt: E2E_NOW, updatedAt: E2E_NOW, lastSeenAt: E2E_NOW, metadata: {},
});
const daemon = (machineId: string, hostName: string, platform: string) => ({
  id: `daemon-${hostName}`, userId: "e2e-user", email: "e2e@xmatrix.test", name: `daemon-${hostName}`,
  status: "online", machineId, machineName: hostName === HOST ? "Laptop" : hostName, hostId: hostName, hostName,
  daemonVersion: "0.16.600", cliVersion: "0.16.600", connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(),
  metadata: { platform },
});

async function openAsDesktop(page: Page, machineId: string | undefined, named = true) {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(({ id, host, named }) => {
    const now = new Date().toISOString();
    (window as unknown as Record<string, unknown>).xmatrixDesktop = {
      client: "desktop", platform: "darwin",
      getContext: async () => ({ client: "desktop", platform: "darwin", version: "0.16.600", machineId: id,
        hostId: host, hostName: host, isPackaged: true, startUrl: "" }),
      setBadge: async () => undefined, setTitle: async () => undefined, notify: async () => true,
      openExternal: async () => undefined, checkCliInstalled: async () => ({ installed: true }),
      openCliInstall: async () => undefined, checkForUpdates: async () => undefined,
      getUpdateStatus: async () => ({ state: "disabled", enabled: false }),
      getDaemonStatus: async () => ({ state: named ? "running" : "stopped", pid: named ? 1 : undefined, updatedAt: now }),
      startDaemon: async () => { (window as unknown as Record<string, unknown>).__daemonStarts = Number((window as unknown as Record<string, unknown>).__daemonStarts ?? 0) + 1; return { state: "running", pid: 1, updatedAt: now }; },
      getSetupStatus: async () => ({ setupVersion: 1, completedAt: now }),
      discoverAgentPresets: async () => [],
    };
  }, { id: machineId, host: HOST, named });
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    workspaces: [workspace(MACHINE_ID, HOST, "xmatrix"), workspace("machine:other", "grok-bot", "grok")],
    machineDaemons: [{ ...daemon(MACHINE_ID, HOST, "macos"), machineName: named ? "Laptop" : undefined, activeRuns: 2,
      metadata: { platform: "macos", machineResources: { observedAt: E2E_NOW, cpuUsagePercent: 95, cpuLogicalCount: 8,
        memoryTotalBytes: 16 * 1024 ** 3, memoryAvailableBytes: 8 * 1024 ** 3,
        diskTotalBytes: 500 * 1024 ** 3, diskAvailableBytes: 400 * 1024 ** 3 } } },
      { ...daemon("machine:other", "grok-bot", "linux"), activeRuns: 0 }],
  });
  await page.goto("/app/personal-sspaceperso/machines");
}

test("the desktop's Machine id makes the Hub's renamed record its one tagged row", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID);
  const rows = page.locator('[data-testid="machine-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.getByTestId("this-machine-tag")).toHaveCount(1);
  const own = rows.filter({ has: page.getByTestId("this-machine-tag") });
  await expect(own).toContainText("Laptop");
  await expect(own).toContainText("This Mac");
  // A row says what the Machine is doing, not what is registered on it.
  await expect(own).toContainText("2 agents running");
  await expect(own).not.toContainText("director");
  await expect(rows.filter({ hasText: "grok-bot" })).toContainText("Idle");
});

test("a Machine row shows its live load as toned bars and its presence on its OS mark", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID);
  const own = page.getByTestId("machine-row").filter({ has: page.getByTestId("this-machine-tag") });
  const glance = own.getByTestId("machine-load-glance");
  await expect(glance).toHaveAttribute("aria-label", "CPU 95%, Mem 50%, Disk 20%");
  await expect(glance.locator('[data-tone="red"]')).toHaveCount(1);
  await expect(glance.locator('[data-tone="green"]')).toHaveCount(2);
  await expect(own.locator('.app-tool-state-icon[data-state="running"]')).toHaveCount(1);
  // A Machine with no load sample says only what it is doing.
  await expect(page.getByTestId("machine-row").filter({ hasText: "grok-bot" }).getByTestId("machine-load-glance"))
    .toHaveCount(0);
});

test("a host name never makes another Machine this machine", async ({ page }) => {
  await openAsDesktop(page, "legacy-minted-id");
  const laptop = page.locator('[data-testid="machine-row"]').filter({ hasText: "Laptop" });
  await expect(laptop).toHaveCount(1);
  await expect(laptop.getByTestId("this-machine-tag")).toHaveCount(0);
});

test("missing Machine identity never creates a duplicate desktop row from its hostname", async ({ page }) => {
  await openAsDesktop(page, undefined);
  const rows = page.getByTestId("machine-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.getByTestId("this-machine-tag")).toHaveCount(0);
  await expect(page.getByText("Update xMatrix to identify this computer", { exact: false })).toBeVisible();
});

test("a retired UUID cannot create a duplicate row beside the same computer's Laptop record", async ({ page }) => {
  await openAsDesktop(page, "machine:b0be459f-bfc0-4498-9b47-2e4c7cb8957e");
  await expect(page.getByTestId("machine-row")).toHaveCount(2);
  await expect(page.getByTestId("machine-row").getByTestId("this-machine-tag")).toHaveCount(0);
});

test("Machine identity matching preserves case", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID.replace("machine:", "Machine:"));
  const laptop = page.getByTestId("machine-row").filter({ hasText: "Laptop" });
  await expect(laptop.getByTestId("this-machine-tag")).toHaveCount(0);
  await expect(page.getByTestId("machine-row")).toHaveCount(3);
});

test("an unnamed Machine asks for a name without copying its hostname", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID, false);
  await fixtureJson(page, "name-machine", "**/api/xmatrix/machines/*/name", { machineId: MACHINE_ID, name: "Portable" });
  const local = page.getByTestId("machine-row").filter({ has: page.getByTestId("this-machine-tag") });
  await expect(local).toContainText("Unnamed machine");
  await local.click();
  await page.getByRole("heading", { name: "Unnamed machine", exact: true }).hover();
  await page.getByRole("button", { name: "Name it", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Machine name", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Machine name", exact: true }).fill("Portable");
  await page.getByRole("textbox", { name: "Machine name", exact: true }).press("Enter");
  await expect(page.getByRole("heading", { name: "Portable", exact: true })).toBeVisible();
  expect(await fixtureRequestBodies(page, "name-machine")).toEqual([{ name: "Portable" }]);
});


test("desktop setup requires a chosen name before starting the daemon", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID, false);
  await fixtureRule(page, { id: "setup-machine-name", method: "POST", pattern: "**/api/xmatrix/machines/*/name",
    responder: { kind: "static", json: { machineId: MACHINE_ID, name: "Travel laptop" } } });
  await page.getByTestId("machine-row").filter({ has: page.getByTestId("this-machine-tag") }).click();
  const field = page.getByRole("textbox", { name: "Name this machine", exact: true });
  await expect(field).toBeEnabled();
  await expect(field).toHaveValue("");
  await expect(page.getByRole("button", { name: "Start", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save name", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__daemonStarts ?? 0)).toBe(0);
  await field.fill("Travel laptop");
  await page.getByRole("button", { name: "Save name", exact: true }).click();
  await expect(field).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "setup-machine-name")).toEqual([{ name: "Travel laptop" }]);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__daemonStarts)).toBe(1);
});

test("an owner keeps a Machine out of automatic assignment from its page", async ({ page }) => {
  await openAsDesktop(page, MACHINE_ID);
  await fixtureRule(page, { id: "machine-auto-assign", method: "PUT", pattern: "**/api/xmatrix/machines/*/auto-assign",
    responder: { kind: "static", json: { machineId: "machine:other", autoAssign: false } } });
  const other = page.getByTestId("machine-row").filter({ hasText: "grok-bot" });
  await expect(other).not.toContainText("Named only");
  await other.click();
  const assignment = page.getByRole("switch", { name: "Automatic assignment: grok-bot", exact: true });
  await expect(assignment).toHaveAttribute("aria-checked", "true");
  await assignment.click();
  await expect(assignment).toHaveAttribute("aria-checked", "false");
  await expect(page.getByText("Agents start here only when named, e.g. machine:grok-bot")).toBeVisible();
  await expect(other).toContainText("Named only");
  expect(await fixtureRequestBodies(page, "machine-auto-assign")).toEqual([{ autoAssign: false }]);
});
