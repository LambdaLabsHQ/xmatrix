import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_NOW, E2E_SPACE, fixtureJson, fixtureRequestBodies, fixtureRequests, fixtureRule,
  fixtureUnconfirmedAccess, openWorkspaceWithStubs } from "./workspace-fixtures";

/* The matrix is edited where it is read, as a table is: a cell is changed in
   place (an agent installed, signed in, turned on), a column is added (an
   agent no machine has yet) and a row is added (a machine), without leaving it. */

test.use(E2E_DESKTOP_CONTEXT);

const MACHINE = "machine:matrix";
const CONTROL = "harness:00000000-0000-4000-8000-0000000000m1";
const INTENT = "0123456789abcdef0123456789abcdef";
const daemon = {
  id: "daemon-matrix", userId: "e2e-user", email: "e2e@xmatrix.test", name: "Workbench",
  machineId: MACHINE, machineName: "Workbench", hostId: "host-workbench", hostName: "Workbench", status: "online",
  connectedAt: E2E_NOW, lastSeenAt: new Date().toISOString(), daemonVersion: "0.16.593",
  metadata: { platform: "linux", capabilities: ["machine_harness_action_v1"],
    harnesses: { schemaVersion: 1, capturedAt: E2E_NOW, items: [
      { id: "codex", installed: true, probeStatus: "ok", version: "1.0.0", autoUpdate: "disabled" },
      { id: "claude", installed: false, probeStatus: "missing", autoUpdate: "unknown" },
      { id: "antigravity", installed: false, probeStatus: "unsupported", autoUpdate: "unknown" },
    ] } },
};
const key = (harness: string) => ({ spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: MACHINE, harness });
const registration = (harness: string) => ({ key: key(harness), displayName: harness, ownerName: "E2E", machineName: "Workbench",
  version: 1, state: "enabled", models: [], routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true,
  canRemoveFromSpace: true });
const catalog = (harnesses: string[]) => ({ registrations: harnesses.map(registration),
  capabilities: harnesses.map((harness) => ({ harness, models: [], locations: [registration(harness)] })) });
const CATALOG = /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?[^#]*)?$/u;
const COMMANDS = "**/api/xmatrix/spaces/*/agent-registrations/commands";

async function openMatrix(page: import("@playwright/test").Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [daemon] });
  await fixtureJson(page, "harness-recent", /\/api\/xmatrix\/machine-daemons\/harness-actions\?machineId=/u, { actions: [] });
  await page.goto("/app/personal-sspaceperso/status");
  const matrix = page.getByTestId("fleet-matrix");
  await expect(matrix.getByRole("row", { name: "Workbench" })).toBeVisible();
  return matrix;
}

test("a cell is edited in place: an installed agent is turned on from its cell", async ({ page }) => {
  const matrix = await openMatrix(page);
  const row = matrix.getByRole("row", { name: "Workbench" });
  // Installed and not in this Space: its cell says Off. Choosing it opens its editor under it, on the same page.
  const off = row.getByRole("button", { name: "codex on Workbench: off in this Space" });
  await expect(off).toHaveText("Off");
  await off.click();
  await expect(off).toHaveAttribute("aria-expanded", "true");
  const editor = page.getByTestId("fleet-cell-editor").filter({ visible: true });
  await expect(editor).toContainText("Codex on Workbench");
  await expect(editor).toContainText("Off in this Space");
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);

  await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["codex"]));
  await fixtureUnconfirmedAccess(page, "codex");
  await editor.getByRole("switch", { name: "Enabled: Codex" }).click();
  // Its owner reads what full access adds before anything is written; answering it is not a click away from the cell.
  await page.getByRole("dialog", { name: "Codex: full access on this machine?" }).getByRole("button", { name: "Add with full access" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
    expect.objectContaining({ action: "create", key: key("codex") })]);
  // The cell is the agent now, and its editor is still the one open.
  await expect(row.getByRole("button", { name: /^codex on Workbench: Ready/u })).toHaveText("Ready");
  await expect(editor.getByRole("switch", { name: "Enabled: Codex" })).toHaveAttribute("aria-checked", "true");
  // Escape closes the editor; what is set on the agent is one step further, from the editor.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fleet-cell-editor").filter({ visible: true })).toHaveCount(0);
  await row.getByRole("button", { name: /^codex on Workbench: Ready/u }).click();
  await page.getByTestId("fleet-cell-open-agent").click();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents\?agent=/u);
});

test("a column is added for an agent no machine has yet, and it is installed from its cell while the cell says so", async ({ page }) => {
  const matrix = await openMatrix(page);
  const row = matrix.getByRole("row", { name: "Workbench" });
  // Only what some machine holds is a column.
  await expect(matrix.getByTestId("fleet-agent-column")).toHaveText(["codex"]);

  // The + after the last agent lists the rest; choosing one adds its column.
  await page.getByTestId("fleet-add-column").click();
  const menu = page.getByRole("menu", { name: "Agents no machine has yet" });
  await expect(menu.getByRole("menuitem", { name: "Codex" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Claude Code" }).click();
  await expect(matrix.getByTestId("fleet-agent-column")).toHaveText(["codex", "claude"]);
  await expect(menu).toBeHidden();

  // Its cell on the reader's machine is a +, edited like any other: Install runs there.
  await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
  await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*",
    { controlId: CONTROL, presetId: "claude", action: "install", status: "running" });
  const cell = row.getByRole("button", { name: "claude is not installed on Workbench" });
  await cell.click();
  const editor = page.getByTestId("fleet-cell-editor").filter({ visible: true });
  const install = editor.getByRole("button", { name: "Install", exact: true });
  await expect(install).toHaveAttribute("title", /claude\.ai\/install\.sh|install/u);
  await install.click();
  expect(await fixtureRequestBodies(page, "harness-action")).toEqual([
    { machineId: MACHINE, hostId: "host-workbench", presetId: "claude", action: "install" }]);
  // While its machine works the cell says what is being done, and goes on saying it once its editor is closed.
  const busy = row.getByRole("button", { name: "claude on Workbench: Installing…" });
  await expect(busy).toHaveText("Installing…");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("fleet-cell-editor").filter({ visible: true })).toHaveCount(0);
  await expect(busy).toHaveText("Installing…");
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);

  // An agent a machine cannot run is a dash there, with nothing to choose.
  await page.getByTestId("fleet-add-column").click();
  await page.getByRole("menuitem", { name: "Google Antigravity" }).click();
  const dash = row.locator('[data-testid="fleet-cell"][data-state="unsupported"]');
  await expect(dash).toContainText("antigravity cannot run on Workbench");
  await expect(row.getByRole("button", { name: /antigravity/u })).toHaveCount(0);
});

test("the add-agent menu stays within a short viewport and scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await openMatrix(page);
  await page.getByTestId("fleet-add-column").click();
  const editor = page.getByTestId("fleet-cell-editor").filter({ visible: true });
  await expect(editor).toBeVisible();
  await expect.poll(async () => editor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 12 && rect.bottom <= window.innerHeight - 12 && element.scrollHeight > element.clientHeight;
  })).toBe(true);
  const menu = page.getByRole("menu", { name: "Agents no machine has yet" });
  await menu.getByRole("menuitem").last().scrollIntoViewIfNeeded();
  await expect(menu.getByRole("menuitem").last()).toBeInViewport();
});

test("a row is added from the table's last row: another machine is connected in place", async ({ page }) => {
  const base = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };
  const matrix = await openMatrix(page);
  await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
    responder: { kind: "static", json: { ...base, phase: "waiting" } } });
  await fixtureRule(page, { id: "funnel", pattern: "**/api/xmatrix/observable/onboarding-step", method: "POST",
    responder: { kind: "static", status: 202, json: {} } });
  // Nothing is asked of the Hub until the row is opened.
  expect(await fixtureRequests(page, "intent-create")).toHaveLength(0);
  const add = matrix.getByTestId("fleet-add-row");
  await expect(add).toHaveText("Add a machine");
  await add.click();
  await expect(add).toHaveAttribute("aria-expanded", "true");
  // The same connection a first machine makes, followed for this one alone: the Space already having
  // agents does not read as this machine being done, and nobody is counted through onboarding again.
  const steps = matrix.getByTestId("add-machine");
  await expect(steps).toContainText("Run this on the computer you are adding.");
  await expect(steps).toContainText(`bash -s -- --connect ${INTENT}`);
  await expect(steps).toContainText("Waiting for your computer…");
  await expect(steps).toContainText("It joins the table");
  expect(await fixtureRequests(page, "funnel")).toHaveLength(0);
  await add.click();
  await expect(steps).toHaveCount(0);
});

test.describe("mobile agents grid and bottom sheets", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("compact chips, 2-column machine cells, bottom-sheet install, attention sheet, and add machine", async ({ page }) => {
    const base = { intentId: INTENT, spaceId: E2E_SPACE.id, expiresAt: "2099-01-01T00:00:00.000Z", registeredHarnesses: [] };
    await openWorkspaceWithStubs(page, {
      spaces: [E2E_SPACE],
      machineDaemons: [{
        ...daemon,
        metadata: {
          ...daemon.metadata,
          harnesses: {
            schemaVersion: 1,
            capturedAt: E2E_NOW,
            items: [
              { id: "codex", installed: true, probeStatus: "ok", version: "1.0.0", autoUpdate: "disabled", login: "signed_out" },
              { id: "claude", installed: false, probeStatus: "missing", autoUpdate: "unknown" },
              { id: "antigravity", installed: false, probeStatus: "unsupported", autoUpdate: "unknown" },
            ],
          },
        },
      }],
    });
    await fixtureJson(page, "catalog", CATALOG, {
      registrations: [{
        ...registration("codex"),
        live: { machine: { online: true, lastSeenAt: new Date().toISOString(), platform: "linux" }, running: [] },
      }],
      capabilities: [{ harness: "codex", models: [], locations: [registration("codex")] }],
    });
    await fixtureJson(page, "harness-recent", /\/api\/xmatrix\/machine-daemons\/harness-actions\?machineId=/u, { actions: [] });
    await fixtureRule(page, { id: "intent-create", pattern: "**/api/xmatrix/setup-intents",
      responder: { kind: "static", json: { ...base, phase: "waiting" } } });
    await fixtureRule(page, { id: "intent-read", pattern: `**/api/xmatrix/setup-intents/${INTENT}`,
      responder: { kind: "static", json: { ...base, phase: "waiting" } } });

    await page.goto("/app/personal-sspaceperso/status");
    const machine = page.getByTestId("fleet-machine").filter({ hasText: "Workbench" });
    await expect(machine).toBeVisible();

    // Compact Space chip renders with status-runtime test id.
    const chip = page.getByTestId("status-runtime").filter({ hasText: "codex" });
    await expect(chip).toBeVisible();

    // Tapping a Needs attention item on a phone opens the in-place Bottom Sheet editor without navigating away.
    const attention = page.getByTestId("status-attention");
    await expect(attention).toContainText("codex on Workbench");
    await attention.first().click();
    const sheet = page.getByTestId("fleet-cell-editor").filter({ visible: true });
    await expect(sheet).toContainText("Codex on Workbench");
    await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/status$/u);
    await sheet.getByRole("button", { name: "Close" }).click();
    await expect(page.getByTestId("fleet-cell-editor").filter({ visible: true })).toHaveCount(0);

    // + Add agent opens the picker bottom sheet (excluding unsupported antigravity), chooses Claude Code, and installs in place.
    await machine.getByTestId("fleet-mobile-add-cell").click();
    const picker = page.getByTestId("fleet-mobile-add-menu");
    await expect(picker).toBeVisible();
    await expect(picker).not.toContainText("Antigravity");
    await picker.getByRole("button", { name: "Claude Code" }).click();

    await fixtureJson(page, "harness-action", "**/api/xmatrix/machine-daemons/harness-actions", { controlId: CONTROL, status: "queued" });
    await fixtureJson(page, "harness-status", "**/api/xmatrix/machine-daemons/harness-actions/*",
      { controlId: CONTROL, presetId: "claude", action: "install", status: "running" });
    const installEditor = page.getByTestId("fleet-cell-editor").filter({ visible: true });
    await expect(installEditor).toContainText("Claude Code on Workbench");
    await installEditor.getByRole("button", { name: "Install", exact: true }).click();
    await expect(machine.getByRole("button", { name: "claude on Workbench: Installing…" })).toContainText("Installing…");

    await installEditor.getByRole("button", { name: "Close" }).click();
    await expect(machine.getByRole("button", { name: "claude on Workbench: Installing…" })).toContainText("Installing…");

    // Interactive Add a machine row works on phone as well.
    const add = page.getByTestId("fleet-add-row");
    await add.scrollIntoViewIfNeeded();
    await add.click();
    await expect(page.getByTestId("add-machine")).toBeVisible();
    await expect(add).toHaveAttribute("aria-expanded", "true");
  });
});
