import { expect, test } from "./fixtures";
import { E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies,
  fixtureRule, openWorkspaceWithStubs } from "./workspace-fixtures";

test.use(E2E_MOBILE_CONTEXT);
const MACHINE = "machine:harness-test";
const CONTROL = "harness:00000000-0000-4000-8000-000000000001";
const daemon = {
  id: "daemon-harness", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Harness machine",
  machineId: MACHINE, machineName: "Harness machine", hostId: "host-harness", hostName: "Harness machine", status: "online",
  connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "0.16.593",
  metadata: { platform: "windows", capabilities: ["machine_harness_action_v1"],
    harnesses: { schemaVersion: 1, capturedAt: E2E_NOW, items: [
      { id: "codex", installed: true, probeStatus: "ok", version: "1.0.0", latestVersion: "1.1.0", autoUpdate: "disabled" },
      { id: "claude", installed: false, probeStatus: "missing", autoUpdate: "unknown" },
      { id: "junie", installed: true, probeStatus: "ok", version: "1.0.0", autoUpdate: "unknown" },
      { id: "cursor", installed: true, probeStatus: "ok", version: "2026.09.28-64d2043", autoUpdate: "unknown" },
      { id: "copilot", installed: true, probeStatus: "ok", version: "1.0.0", autoUpdate: "enabled" },
    ] } },
};

async function openMachine(page: Parameters<typeof openWorkspaceWithStubs>[0], status = "online", capabilities = daemon.metadata.capabilities) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE],
    machineDaemons: [{ ...daemon, status, metadata: { ...daemon.metadata, capabilities } }] });
  await page.goto("/app/personal-sspaceperso/machines");
  await page.locator('[data-testid="machine-row"]').filter({ hasText: "Harness machine" }).click();
  await expect(page.getByTestId("machine-harness-panel")).toBeVisible();
}

test("update runs from its row at once and shows its outcome on that row", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions",
    { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*",
    { controlId: CONTROL, presetId: "codex", action: "update", status: "succeeded",
      result: { presetId: "codex", action: "update", status: "succeeded", outputTail: "Updated successfully" } });
  const panel = page.getByTestId("machine-harness-panel");
  const row = panel.getByRole("row").filter({ hasText: "Codex" });
  await expect(row).toContainText("1.1.0");
  await expect(row.getByRole("switch", { name: "Automatic updates: Codex" })).toHaveAttribute("aria-checked", "false");
  const update = row.getByRole("button", { name: "Update", exact: true });
  await expect(update).toHaveAttribute("title", /@openai\/codex@latest/);
  await update.click();
  await expect(row.getByText("Update · codex: succeeded")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "codex", action: "update" },
  ]);
  await panel.getByText("Command output", { exact: true }).click();
  await expect(row.getByText("Updated successfully")).toBeVisible();
  const overflows = await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1);
  expect(overflows).toBe(false);
});

test("a running action holds only its own row", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*",
    { controlId: CONTROL, presetId: "codex", action: "update", status: "running" });
  const panel = page.getByTestId("machine-harness-panel");
  const codex = panel.getByRole("row").filter({ hasText: "Codex" });
  await codex.getByRole("button", { name: "Update", exact: true }).click();
  await expect(codex.getByText("Update · codex: running")).toBeVisible();
  await expect(codex.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await expect(codex.getByRole("switch")).toBeDisabled();
  const copilot = panel.getByRole("row").filter({ hasText: "Copilot" });
  await expect(copilot.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
  await expect(copilot.getByRole("switch")).toBeEnabled();
  await expect(panel.getByRole("row").filter({ hasText: "Claude" }).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
  await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await copilot.getByRole("button", { name: "Update", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "codex", action: "update" },
    { machineId: MACHINE, hostId: "host-harness", presetId: "copilot", action: "update" },
  ]);
});

test("installation uses the Windows recipe and a server refusal remains visible", async ({ page }) => {
  await openMachine(page);
  await fixtureRule(page, { id: "harness-denied", pattern: "**/api/xmatrix/machine-daemons/harness-actions", method: "POST",
    responder: { kind: "static", status: 409, json: { error: "Machine is offline" } } });
  const panel = page.getByTestId("machine-harness-panel");
  const install = panel.getByRole("row").filter({ hasText: "Claude" }).getByRole("button", { name: "Install", exact: true });
  await expect(install).toHaveAttribute("title", /powershell.*install\.ps1/);
  await install.click();
  await expect(panel.getByRole("alert")).toHaveText("Machine is offline");
});

test("automatic update control and inventory refresh send closed actions", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "copilot", action: "auto_update_off", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  const copilot = panel.getByRole("row").filter({ hasText: "Copilot" });
  await expect(copilot.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  await copilot.getByRole("switch").click();
  await expect(panel.getByText("Disable automatic updates · copilot: succeeded")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "copilot", action: "auto_update_off" },
  ]);
  await panel.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "copilot", action: "auto_update_off" },
    { machineId: MACHINE, hostId: "host-harness", presetId: "custom", action: "refresh" },
  ]);
});

test("offline machines retain observations and disable management", async ({ page }) => {
  await openMachine(page, "offline");
  const panel = page.getByTestId("machine-harness-panel");
  await expect(panel.getByText("Connect this machine to refresh or manage harnesses.")).toBeVisible();
  await expect(panel.getByRole("row").filter({ hasText: "Codex" })).toContainText("1.0.0");
  for (const button of await panel.getByRole("button").all()) await expect(button).toBeDisabled();
});


test("an unknown state reads as unknown and the switch turns it on", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "junie", action: "auto_update_on", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  const row = panel.getByRole("row").filter({ hasText: "Junie" });
  await expect(row.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(row.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  await row.getByRole("switch").click();
  await expect(panel.getByText("Enable automatic updates \u00b7 junie: succeeded")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "junie", action: "auto_update_on" },
  ]);
});

test("old daemons cannot update Cursor while other harness updates remain available", async ({ page }) => {
  await openMachine(page);
  const panel = page.getByTestId("machine-harness-panel");
  const cursor = panel.getByRole("row").filter({ hasText: "Cursor" });
  await expect(cursor.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await expect(cursor).toContainText("Update this machine's daemon before updating Cursor.");
  await expect(panel.getByRole("row").filter({ hasText: "Codex" }).getByRole("button", { name: "Update", exact: true })).toBeEnabled();
});

test("uninstall takes a second tap on its row and is offered only where one exists", async ({ page }) => {
  await openMachine(page, "online", ["machine_harness_action_v1", "machine_harness_uninstall_v1"]);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "codex", action: "uninstall", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  // No verified uninstaller upstream, and nothing to remove where it is not installed.
  await expect(panel.getByRole("row").filter({ hasText: "Junie" }).getByRole("button", { name: "Uninstall" })).toHaveCount(0);
  await expect(panel.getByRole("row").filter({ hasText: "Claude" }).getByRole("button", { name: "Uninstall" })).toHaveCount(0);
  const codex = panel.getByRole("row").filter({ hasText: "Codex" });
  await expect(codex.getByRole("button", { name: "Uninstall", exact: true })).toHaveAttribute("title", "npm uninstall -g @openai/codex");
  await codex.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(codex).toContainText("Settings and sessions are kept.");
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([]);
  await codex.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await expect(codex.getByText("Uninstall \u00b7 codex: succeeded")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "codex", action: "uninstall" },
  ]);
});

test("old daemons cannot uninstall", async ({ page }) => {
  await openMachine(page);
  const codex = page.getByTestId("machine-harness-panel").getByRole("row").filter({ hasText: "Codex" });
  await expect(codex.getByRole("button", { name: "Uninstall", exact: true })).toBeDisabled();
  await expect(codex).toContainText("Update this machine's daemon to uninstall.");
});

test.describe("desktop automatic update status", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

  test("reported states remain distinct and the table carries no placeholder text", async ({ page }) => {
    await openMachine(page);
    const panel = page.getByTestId("machine-harness-panel");
    const row = (harness: string) => panel.getByRole("row").filter({ hasText: harness });
    await expect(row("Codex").getByRole("switch")).toHaveAttribute("aria-checked", "false");
    await expect(row("Copilot").getByRole("switch")).toHaveAttribute("aria-checked", "true");
    await expect(row("Junie").getByText("Unknown", { exact: true })).toBeVisible();
    await expect(row("Codex").getByText("Unknown", { exact: true })).toHaveCount(0);
    for (const placeholder of ["Not checked", "Not installed", "Not available", "Update available", "\u2014"]) {
      await expect(panel.getByText(placeholder, { exact: true })).toHaveCount(0);
    }
    await expect(panel.getByRole("row").filter({ hasText: "Claude" }).getByRole("switch")).toHaveCount(0);
    const order = await panel.locator("tbody > tr").evaluateAll((rows) => rows.map((row) =>
      row.getAttribute("data-testid") === "harness-install-divider" ? "divider" : (row.querySelector("th")?.textContent ?? "").trim()));
    expect(order.indexOf("Codex")).toBeLessThan(order.indexOf("divider"));
    expect(order.indexOf("divider")).toBeLessThan(order.indexOf("Claude Code"));
    expect(order.indexOf("Cursor")).toBeLessThan(order.indexOf("GitHub Copilot CLI"));
    expect(await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await panel.screenshot({ path: test.info().outputPath("auto-update-status.png") });
  });
});
