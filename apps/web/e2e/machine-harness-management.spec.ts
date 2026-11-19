import { expect, test } from "./fixtures";
import { E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureUnconfirmedAccess,
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

async function openMachine(page: Parameters<typeof openWorkspaceWithStubs>[0], status = "online", capabilities = daemon.metadata.capabilities,
  { recorded = [], unansweredSince, registrations = [] }: { recorded?: unknown[]; unansweredSince?: string; registrations?: NonNullable<Parameters<typeof openWorkspaceWithStubs>[1]>["registrations"] } = {}) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], registrations,
    machineDaemons: [{ ...daemon, status, metadata: { ...daemon.metadata, capabilities },
      ...(unansweredSince ? { unansweredSince } : {}) }] });
  await fixtureJson(page, "harness-recent", /\/api\/xmatrix\/machine-daemons\/harness-actions\?machineId=/u,
    { actions: recorded });
  await page.goto("/app/personal-sspaceperso/machines");
  await page.locator('[data-testid="machine-row"]').filter({ hasText: "Harness machine" }).click();
  await expect(page.getByTestId("machine-harness-panel")).toBeVisible();
}

type Panel = ReturnType<import("@playwright/test").Page["getByTestId"]>;
/** An agent's line on its machine's page: what it does here, the step it waits on, its switch for this Space. */
const agentRow = (panel: Panel, name: string) => panel.getByTestId("harness-row").filter({ hasText: name });
/** The same line with its upkeep open: version, updates, uninstall. */
async function upkeep(panel: Panel, name: string) {
  const row = agentRow(panel, name);
  const toggle = row.getByRole("button", { name: /^Manage / });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  return row;
}
/** What is not installed yet is offered under "Add an agent". */
async function offered(panel: Panel, name: string) {
  const add = panel.getByTestId("harness-add");
  if (await add.getAttribute("aria-expanded") !== "true") await add.click();
  return agentRow(panel, name);
}

test("update runs from its row at once and shows its outcome on that row", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions",
    { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*",
    { controlId: CONTROL, presetId: "codex", action: "update", status: "succeeded",
      result: { presetId: "codex", action: "update", status: "succeeded", outputTail: "Updated successfully" } });
  const panel = page.getByTestId("machine-harness-panel");
  // Behind its latest release and not updating itself, its line says so before it is opened.
  await expect(agentRow(panel, "Codex").getByTestId("harness-state")).toHaveText("Off in this Space · 1.1.0 available");
  const row = await upkeep(panel, "Codex");
  await expect(row).toContainText("1.0.0");
  await expect(row.getByRole("switch", { name: "Automatic updates: Codex" })).toHaveAttribute("aria-checked", "false");
  const update = row.getByRole("button", { name: "Update", exact: true });
  await expect(update).toHaveAttribute("title", /@openai\/codex@latest/);
  await update.click();
  await expect(row.getByText("Update · Codex: Done")).toBeVisible();
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
  const codex = await upkeep(panel, "Codex");
  await codex.getByRole("button", { name: "Update", exact: true }).click();
  await expect(codex.getByText("Update · Codex: Running on the machine…")).toBeVisible();
  await expect(codex.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await expect(codex.getByRole("switch", { name: "Automatic updates: Codex" })).toBeDisabled();
  const copilot = await upkeep(panel, "Copilot");
  await expect(copilot.getByRole("button", { name: "Update", exact: true })).toBeEnabled();
  await expect(copilot.getByRole("switch", { name: "Automatic updates: GitHub Copilot CLI" })).toBeEnabled();
  await expect((await offered(panel, "Claude")).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
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
  // Nothing not installed is listed until it is asked for.
  await expect(agentRow(panel, "Claude")).toHaveCount(0);
  const install = (await offered(panel, "Claude")).getByRole("button", { name: "Install", exact: true });
  await expect(install).toHaveAttribute("title", /powershell.*install\.ps1/);
  await install.click();
  await expect(panel.getByRole("alert")).toHaveText("Couldn't send that to the machine. Machine is offline.");
});

test("automatic update control and inventory refresh send closed actions", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "copilot", action: "auto_update_off", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  const copilot = await upkeep(panel, "Copilot");
  const copilotUpdates = copilot.getByRole("switch", { name: "Automatic updates: GitHub Copilot CLI" });
  await expect(copilotUpdates).toHaveAttribute("aria-checked", "true");
  await copilotUpdates.click();
  await expect(panel.getByText("Disable automatic updates · GitHub Copilot CLI: Done")).toBeVisible();
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
  await expect(panel.getByText("Connect this machine to manage its agents.")).toBeVisible();
  await expect(await upkeep(panel, "Codex")).toContainText("1.0.0");
  await offered(panel, "Claude");
  // Nothing that needs the machine can be asked of it; its lines still open and close.
  for (const name of ["Refresh", "Update", "Install", "Uninstall"]) {
    for (const button of await panel.getByRole("button", { name, exact: true }).all()) await expect(button).toBeDisabled();
  }
  await expect(panel.getByRole("switch", { name: "Automatic updates: Codex" })).toBeDisabled();
});


test("an unknown state reads as unknown and the switch turns it on", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "junie", action: "auto_update_on", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  const row = await upkeep(panel, "Junie");
  await expect(row.getByText("Unknown", { exact: true })).toBeVisible();
  const updates = row.getByRole("switch", { name: "Automatic updates: Junie" });
  await expect(updates).toHaveAttribute("aria-checked", "false");
  await updates.click();
  await expect(panel.getByText("Enable automatic updates \u00b7 Junie: Done")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "junie", action: "auto_update_on" },
  ]);
});

test("old daemons cannot update Cursor while other harness updates remain available", async ({ page }) => {
  await openMachine(page);
  const panel = page.getByTestId("machine-harness-panel");
  const cursor = await upkeep(panel, "Cursor");
  await expect(cursor.getByRole("button", { name: "Update", exact: true })).toBeDisabled();
  await expect(cursor).toContainText("Update this machine's daemon before updating Cursor.");
  await expect((await upkeep(panel, "Codex")).getByRole("button", { name: "Update", exact: true })).toBeEnabled();
});

test("uninstall takes a second tap on its row and is offered only where one exists", async ({ page }) => {
  await openMachine(page, "online", ["machine_harness_action_v1", "machine_harness_uninstall_v1"]);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "codex", action: "uninstall", status: "succeeded",
  });
  const panel = page.getByTestId("machine-harness-panel");
  // No verified uninstaller upstream, and nothing to remove where it is not installed.
  await expect((await upkeep(panel, "Junie")).getByRole("button", { name: "Uninstall" })).toHaveCount(0);
  await expect((await offered(panel, "Claude")).getByRole("button", { name: "Uninstall" })).toHaveCount(0);
  const codex = await upkeep(panel, "Codex");
  await expect(codex.getByRole("button", { name: "Uninstall", exact: true })).toHaveAttribute("title", "npm uninstall -g @openai/codex");
  await codex.getByRole("button", { name: "Uninstall", exact: true }).click();
  await expect(codex).toContainText("Settings and sessions are kept.");
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([]);
  await codex.getByRole("button", { name: "Confirm uninstall", exact: true }).click();
  await expect(codex.getByText("Uninstall \u00b7 Codex: Done")).toBeVisible();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-harness", presetId: "codex", action: "uninstall" },
  ]);
});

test("a reload still shows how an earlier install ended, and says when it found nothing", async ({ page }) => {
  const recorded = { controlId: CONTROL, presetId: "claude", action: "install", status: "succeeded",
    requestedAt: E2E_NOW, completedAt: E2E_NOW,
    result: { presetId: "claude", action: "install", status: "succeeded", exitCode: 0,
      item: { id: "claude", installed: false, probeStatus: "missing" } } };
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", recorded);
  await openMachine(page, "online", daemon.metadata.capabilities, { recorded: [recorded] });
  // An install that found nothing keeps its line, though nothing else not installed is listed.
  const claude = agentRow(page.getByTestId("machine-harness-panel"), "Claude Code");
  await expect(agentRow(page.getByTestId("machine-harness-panel"), "Gemini")).toHaveCount(0);
  await expect(claude).toContainText("Install · Claude Code: Install finished, but Claude Code was not found on this machine's PATH");
  await expect(claude).not.toContainText("succeeded");
});

test("a machine that left work unanswered is not responding, and its actions stay available", async ({ page }) => {
  await openMachine(page, "online", daemon.metadata.capabilities, { unansweredSince: E2E_NOW });
  const panel = page.getByTestId("machine-harness-panel");
  await expect(panel).toContainText("This machine is not responding");
  await expect(panel).toContainText("a new action may not reach it");
  await expect(panel.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
  await expect((await offered(panel, "Claude Code")).getByRole("button", { name: "Install", exact: true })).toBeEnabled();
});

test("old daemons cannot uninstall", async ({ page }) => {
  await openMachine(page);
  const codex = await upkeep(page.getByTestId("machine-harness-panel"), "Codex");
  await expect(codex.getByRole("button", { name: "Uninstall", exact: true })).toBeDisabled();
  await expect(codex).toContainText("Update this machine's daemon to uninstall.");
});

test.describe("desktop automatic update status", () => {
  test.use({ viewport: { width: 1440, height: 1000 }, isMobile: false, hasTouch: false });

  test("reported states remain distinct and the list carries no placeholder text", async ({ page }) => {
    await openMachine(page);
    const panel = page.getByTestId("machine-harness-panel");
    for (const harness of ["Codex", "Copilot", "Junie"]) await upkeep(panel, harness);
    const row = (harness: string) => agentRow(panel, harness);
    await expect(row("Codex").getByRole("switch", { name: "Automatic updates: Codex" })).toHaveAttribute("aria-checked", "false");
    await expect(row("Copilot").getByRole("switch", { name: "Automatic updates: GitHub Copilot CLI" })).toHaveAttribute("aria-checked", "true");
    await expect(row("Junie").getByText("Unknown", { exact: true })).toBeVisible();
    await expect(row("Codex").getByText("Unknown", { exact: true })).toHaveCount(0);
    await expect((await offered(panel, "Claude")).getByRole("switch")).toHaveCount(0);
    for (const placeholder of ["Not checked", "Not installed", "Not available", "Update available", "\u2014"]) {
      await expect(panel.getByText(placeholder, { exact: true })).toHaveCount(0);
    }
    // What is installed comes first, then "Add an agent", then what it offers.
    const order = await panel.locator("ul.app-tool-lines > li").evaluateAll((items) => items.map((item) =>
      item.querySelector("[data-testid=harness-add]") ? "add" : (item.querySelector(".font-semibold")?.textContent ?? "").trim()));
    expect(order.indexOf("Codex")).toBeLessThan(order.indexOf("add"));
    expect(order.indexOf("add")).toBeLessThan(order.indexOf("Claude Code"));
    expect(order.indexOf("Cursor")).toBeLessThan(order.indexOf("GitHub Copilot CLI"));
    expect(await panel.evaluate((element) => element.scrollWidth > element.clientWidth + 1)).toBe(false);
    await expect(row("Codex").getByRole("switch", { name: "Enabled: Codex" })).toHaveAttribute("aria-checked", "false");
    await expect(row("Codex").getByTestId("harness-state")).toContainText("Off in this Space");
    await panel.screenshot({ path: test.info().outputPath("auto-update-status.png") });
  });
});

const CATALOG = "**/api/xmatrix/spaces/*/agent-registrations";
const COMMANDS = "**/api/xmatrix/spaces/*/agent-registrations/commands";
const spaceKey = (harness: string) => ({ spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: MACHINE, harness });
const spaceRegistration = (harness: string, state = "enabled") => ({ key: spaceKey(harness), displayName: harness,
  ownerName: "E2E", machineName: "Harness machine", version: 1, state, models: [], routingReady: true,
  canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true });
const catalogOf = (registrations: ReturnType<typeof spaceRegistration>[]) => ({ registrations,
  capabilities: registrations.map((registration) => ({ harness: registration.key.harness, models: [], locations: [registration] })) });

test("an installed harness is summoned in this Space once its owner turns it on", async ({ page }) => {
  await openMachine(page);
  const panel = page.getByTestId("machine-harness-panel");
  const codex = panel.getByRole("switch", { name: "Enabled: Codex" });
  await expect(codex).toHaveAttribute("aria-checked", "false");
  // Not installed, nothing to summon.
  await expect(panel.getByRole("switch", { name: "Enabled: Claude Code" })).toHaveCount(0);
  await fixtureJson(page, "space-command", COMMANDS, { key: spaceKey("codex"), version: 1 }, { method: "POST" });
  await fixtureJson(page, "registration-catalog-on", CATALOG, catalogOf([spaceRegistration("codex")]));
  await fixtureUnconfirmedAccess(page, "codex");
  await codex.click();
  await page.getByRole("button", { name: "Add with full access" }).click();
  await expect(codex).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("machine-harness-panel").screenshot({ path: test.info().outputPath("space-switch-mobile.png") });
  const [create] = await fixtureRequestBodies(page, "space-command") as Array<Record<string, unknown>>;
  expect(create).toMatchObject({ action: "create", key: spaceKey("codex"), displayName: "codex",
    environment: { enabled: true, launch: { runtime: "codex", access: "full" } } });
});

test("turning it off disables it in this Space only", async ({ page }) => {
  await openMachine(page, "online", daemon.metadata.capabilities, { registrations: [spaceRegistration("codex")] });
  await fixtureJson(page, "space-query", "**/api/xmatrix/spaces/*/agent-registrations/query", {
    ...spaceRegistration("codex"), access: { grant: { revision: 3, limits: {} }, policy: { revision: 4 } } }, { method: "POST" });
  await fixtureJson(page, "space-command", COMMANDS, { key: spaceKey("codex"), version: 1 }, { method: "POST" });
  const codex = page.getByTestId("machine-harness-panel").getByRole("switch", { name: "Enabled: Codex" });
  await expect(codex).toHaveAttribute("aria-checked", "true");
  await fixtureJson(page, "registration-catalog-off", CATALOG, catalogOf([spaceRegistration("codex", "disabled")]));
  await codex.click();
  await expect(codex).toHaveAttribute("aria-checked", "false");
  expect(await fixtureRequestBodies(page, "space-command")).toEqual([
    expect.objectContaining({ key: spaceKey("codex"), action: "space-state", state: "disabled", expectedRevision: 4 }),
  ]);
});

test("a harness installed from here is turned on in this Space", async ({ page }) => {
  await openMachine(page);
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*", {
    controlId: CONTROL, presetId: "claude", action: "install", status: "succeeded",
    result: { presetId: "claude", action: "install", status: "succeeded",
      item: { id: "claude", installed: true, probeStatus: "ok", version: "2.0.0", autoUpdate: "unknown" } } });
  await fixtureJson(page, "space-command", COMMANDS, { key: spaceKey("claude"), version: 1 }, { method: "POST" });
  await fixtureJson(page, "registration-catalog-on", CATALOG, catalogOf([spaceRegistration("claude")]));
  await fixtureUnconfirmedAccess(page, "claude");
  const panel = page.getByTestId("machine-harness-panel");
  await (await offered(panel, "Claude")).getByRole("button", { name: "Install", exact: true }).click();
  // Installed, it is added once its owner read what full access adds.
  const confirmation = page.getByRole("dialog", { name: "Claude Code: access on this machine" });
  await expect(confirmation.getByTestId("agent-access-lines")).toContainText("Adds the argument --dangerously-skip-permissions");
  await confirmation.getByRole("button", { name: "Add with full access" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "space-command")).toEqual([
    expect.objectContaining({ action: "create", key: spaceKey("claude") }),
  ]);
});

test("restoring a successful install from machine history does not enable it in this Space", async ({ page }) => {
  await openMachine(page, "online", daemon.metadata.capabilities, { recorded: [{
    controlId: CONTROL, presetId: "codex", action: "install", status: "succeeded", requestedAt: E2E_NOW,
    result: { presetId: "codex", action: "install", status: "succeeded",
      item: { id: "codex", installed: true, probeStatus: "ok", version: "1.0.0" } },
  }] });
  await fixtureJson(page, "space-command", COMMANDS, { version: 1 }, { method: "POST" });
  const panel = page.getByTestId("machine-harness-panel");
  await expect(panel.getByRole("switch", { name: "Enabled: Codex" })).toHaveAttribute("aria-checked", "false");
  // How an earlier action ended is read under its line's upkeep, not on every visit.
  await expect(panel.getByText("Install · Codex: Done")).toHaveCount(0);
  await upkeep(panel, "Codex");
  await expect(panel.getByText("Install · Codex: Done")).toBeVisible();
  expect(await fixtureRequestBodies(page, "space-command")).toEqual([]);
});
