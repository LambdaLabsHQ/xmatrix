import { expect, test } from "./fixtures";
import { AGENT_ENVIRONMENT_QUERY, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, E2E_NOW, fixtureJson,
  fixtureRule, fixtureRequestBodies, fixtureUnconfirmedAccess, fixtureUnconfirmedAccessEach, openWorkspaceWithStubs } from "./workspace-fixtures";

const machine = { id: "daemon-installed", userId: "e2e-user", name: "Remote server", machineName: "Remote server",
  machineId: "machine-remote", email: "e2e@xmatrix.test", status: "online", connectedAt: E2E_NOW, lastSeenAt: E2E_NOW,
  metadata: { platform: "linux", harnesses: { schemaVersion: 1, capturedAt: E2E_NOW,
    items: ["codex", "claude"].map((id) => ({ id, installed: true, version: "1.0.0", probeStatus: "ok", autoUpdate: "unknown" })) } } };
const key = (harness: string) => ({ spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: machine.machineId, harness });
const registration = (harness: string) => ({ key: key(harness), displayName: harness, machineName: machine.machineName,
  ownerName: "E2E", state: "enabled", version: 1, models: [], routingReady: true, canManageOwnerGrant: true,
  canConfigureSpace: true, canRemoveFromSpace: true });
const catalog = (harnesses: string[]) => ({ registrations: harnesses.map(registration), capabilities: harnesses.map((harness) =>
  ({ harness, models: [], locations: [registration(harness)] })) });
const CATALOG = /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?[^#]*)?$/u;
const COMMANDS = "**/api/xmatrix/spaces/*/agent-registrations/commands";

/** The machine's page, where what is installed on it is turned on for this Space. */
async function openRemote(page: Parameters<typeof openWorkspaceWithStubs>[0]) {
  await page.goto("/app/personal-sspaceperso/machines");
  await page.getByTestId("machine-row").filter({ hasText: "Remote server" }).click();
  const panel = page.getByTestId("machine-harness-panel");
  await expect(panel).toBeVisible();
  return panel;
}

function installedHarnessTests(name: string, context: typeof E2E_DESKTOP_CONTEXT | typeof E2E_MOBILE_CONTEXT) {
  test.describe(name, () => {
    test.use(context);
    test("a machine's installed agents are offered under it, and turned on from its page without registering them first", async ({ page }) => {
      await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
      await page.goto("/app/personal-sspaceperso/status");
      // Installed and not in this Space. A desktop's matrix has a cell for each, which says Off; a phone's list
      // has one quiet line under their machine. Either opens the machine's page.
      // By test id: a phone hides the list while the machine's page is open, and it is still read below.
      const under = page.getByTestId("fleet-machine").filter({ hasText: "Remote server" });
      await expect(under.getByTestId("agent-row")).toHaveCount(0);
      const phone = name === "mobile";
      const off = phone ? under.getByTestId("fleet-machine-off") : under.locator('[data-testid="fleet-cell"][data-state="off"]');
      if (phone) await expect(off).toHaveText("2 more installed · off in this Space");
      else await expect(off).toHaveCount(2);
      // A phone opens the machine's page; a desktop edits the cell where it is.
      const codexCell = phone ? off : under.getByRole("button", { name: "codex on Remote server: off in this Space" });
      // With no agent in the Space yet, the overview says the same in words and names the machine to open.
      const empty = page.getByTestId("fleet-empty").filter({ visible: true });
      await expect(empty).toContainText("Turn on an installed agent");
      await expect(empty.getByRole("button", { name: "Open Remote server" })).toBeVisible();
      await codexCell.click();
      if (phone) await expect(page).toHaveURL(/\/machines\?machine=/u);
      else await expect(page).toHaveURL(/\/status$/u);
      const panel = page.getByTestId("machine-harness-panel").filter({ visible: true });
      await expect(panel.getByRole("switch", { name: /^Enabled: /u })).toHaveCount(phone ? 2 : 1);
      const codex = panel.getByRole("switch", { name: "Enabled: Codex" });
      await expect(codex).toHaveAttribute("aria-checked", "false");
      await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
      expect(await fixtureRequestBodies(page, "enable-command")).toEqual([]);
      await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["codex"]));
      await fixtureUnconfirmedAccess(page, "codex");
      await codex.click();
      // Its owner reads what full access adds before anything is written.
      const confirmation = page.getByRole("dialog", { name: "Codex: full access on this machine?" });
      // Both settings Codex's session starts with are named, each as written.
      await expect(confirmation.getByTestId("agent-access-lines").getByRole("listitem")).toHaveText([
        "Starts each session with sandbox=danger-full-access", "Starts each session with approvalPolicy=never"]);
      expect(await fixtureRequestBodies(page, "enable-command")).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`access-confirmation-${name}.png`) });
      await confirmation.getByRole("button", { name: "Add with full access" }).click();
      await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
        expect.objectContaining({ action: "create", key: key("codex"),
          environment: expect.objectContaining({ launch: expect.objectContaining({ access: "full" }) }) }),
      ]);
      // On, it is an agent of the Space: a row under its machine, and one fewer left to turn on.
      await expect(codex).toHaveAttribute("aria-checked", "true");
      if (phone) {
        await expect(under.getByTestId("agent-row")).toHaveCount(1);
        await expect(off).toHaveText("1 more installed · off in this Space");
      } else {
        await expect(under.getByTestId("agent-row")).toHaveCount(1);
        await expect(off).toHaveCount(1);
      }
      await page.screenshot({ path: test.info().outputPath(`installed-agents-${name}.png`) });
    });

    test("Bring them in enables every installed pair in this Space", async ({ page }) => {
      await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
      // The empty conversation screen offers installed harnesses on both viewport sizes.
      await page.goto("/app/personal-sspaceperso/chat");
      const bring = page.getByRole("button", { name: "Bring them in", exact: true });
      await expect(bring).toBeVisible();
      // A Space's empty screen is detail paper, never the setup wood board.
      await expect(page.locator(".app-tool-paper").filter({ has: bring })).toHaveCount(1);
      await expect(page.locator(".app-message-surface-space-setup")).toHaveCount(0);
      await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
      await fixtureRule(page, { id: "enabled-catalog", pattern: CATALOG, responder: { kind: "sequence",
        responses: [catalog(["claude"]), catalog(["claude", "codex"])].map((json) => ({ json })) } });
      await fixtureUnconfirmedAccessEach(page, ["claude", "codex"]);
      await bring.click();
      // One question covers every harness about to be added.
      await page.getByRole("dialog", { name: "Full access on this machine?" }).getByRole("button", { name: "Add 2 with full access" }).click();
      await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
        expect.objectContaining({ action: "create", key: key("claude") }),
        expect.objectContaining({ action: "create", key: key("codex") }),
      ]);
      await expect(bring).toHaveCount(0);
      await page.screenshot({ path: test.info().outputPath(`onboarding-enabled-${name}.png`) });
    });
  });
}

installedHarnessTests("desktop", E2E_DESKTOP_CONTEXT);
installedHarnessTests("mobile", E2E_MOBILE_CONTEXT);

test.use(E2E_DESKTOP_CONTEXT);
test("a refused owner switch stays off and reports the server failure", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  const list = await openRemote(page);
  await fixtureRule(page, { id: "enable-refused", pattern: COMMANDS, method: "POST",
    responder: { kind: "static", status: 403, json: { error: "Machine owner access was revoked" } } });
  const codex = list.getByRole("switch", { name: "Enabled: Codex" });
  await fixtureUnconfirmedAccess(page, "codex");
  await codex.click();
  await page.getByRole("button", { name: "Add with full access" }).click();
  await expect(list.getByRole("alert")).toHaveText("Couldn't save the harness switch. Machine owner access was revoked.");
  await expect(codex).toHaveAttribute("aria-checked", "false");
});

test("another owner's inventory is never offered as an owner switch", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [{ ...machine, userId: "another-owner" }] });
  await page.goto("/app/personal-sspaceperso/status");
  // Nothing of theirs is the reader's to turn on or install: with no machine of their own, the Space
  // reads how one is connected, and no cell offers another member's.
  await expect(page.getByTestId("connect-machine")).toBeVisible();
  await expect(page.getByTestId("fleet-cell")).toHaveCount(0);
  // Where the reader's list does carry that machine, its page offers them no switch either.
  if (await page.getByTestId("machine-row").filter({ hasText: "Remote server" }).count()) {
    const panel = await openRemote(page);
    await expect(panel.getByRole("switch", { name: /^Enabled: /u })).toHaveCount(0);
    await expect(panel).toContainText("Only this machine's owner can manage its agents.");
  }
});

test("bulk failure stays visible and retry continues with the remaining pair", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  await page.goto("/app/personal-sspaceperso/chat");
  const bring = page.getByRole("button", { name: "Bring them in", exact: true });
  await expect(bring).toBeVisible();
  await fixtureRule(page, { id: "partial-enable", pattern: COMMANDS, method: "POST", responder: { kind: "sequence",
    responses: [{ json: { version: 1 } }, { status: 409, json: { error: "Space policy changed. Try again." } }] } });
  await fixtureJson(page, "partial-catalog", CATALOG, catalog(["claude"]));
  await fixtureUnconfirmedAccessEach(page, ["claude", "codex"]);
  await bring.click();
  await page.getByRole("button", { name: "Add 2 with full access" }).click();
  await expect(page.getByTestId("installed-harness-switches").getByRole("alert")).toHaveText("Couldn't save the harness switch. Space policy changed. Try again.");
  await expect(bring).toBeVisible();
  await fixtureJson(page, "retry-enable", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "retry-catalog", CATALOG, catalog(["claude", "codex"]));
  await fixtureUnconfirmedAccess(page, "codex");
  await bring.click();
  await page.getByRole("button", { name: "Add with full access" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "retry-enable")).toEqual([
    expect.objectContaining({ action: "create", key: key("codex") }),
  ]);
  await expect(bring).toHaveCount(0);
});

test("declining the access question adds nothing, and a harness confirmed earlier is not asked again", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  const list = await openRemote(page);
  const codex = list.getByRole("switch", { name: "Enabled: Codex" });
  await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureUnconfirmedAccess(page, "codex");
  await codex.click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(codex).toHaveAttribute("aria-checked", "false");
  await expect(list.getByRole("alert")).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "enable-command")).toEqual([]);
  // Confirmed for this machine in another Space: the add writes no mode and asks nothing.
  await fixtureJson(page, "environment-confirmed", AGENT_ENVIRONMENT_QUERY, { version: 2,
    environment: { schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [],
      launch: { runtime: "codex", runtimeArgs: [], access: "full" } } }, { method: "POST" });
  await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["codex"]));
  await codex.click();
  await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toHaveLength(1);
  const [create] = await fixtureRequestBodies(page, "enable-command") as Array<{ environment: { launch: Record<string, unknown> } }>;
  expect(create!.environment.launch.access).toBeUndefined();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a harness whose permission requests can be shown is added asking first when its owner chooses that", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  const list = await openRemote(page);
  await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["claude"]));
  await fixtureUnconfirmedAccess(page, "claude");
  await list.getByRole("switch", { name: "Enabled: Claude Code" }).click();
  const confirmation = page.getByRole("dialog", { name: "Claude Code: access on this machine" });
  // Full access is the default; the other mode says what it means before it is chosen.
  await expect(confirmation.getByRole("radio", { name: "Full access" })).toBeChecked();
  await expect(confirmation.getByRole("button", { name: "Add with full access" })).toBeVisible();
  await confirmation.getByRole("radio", { name: /^Ask first/u }).check();
  await page.screenshot({ path: test.info().outputPath("access-ask-choice.png") });
  await confirmation.getByRole("button", { name: "Add, asking first" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
    expect.objectContaining({ action: "create", key: key("claude"),
      environment: expect.objectContaining({ launch: expect.objectContaining({ access: "ask" }) }) }),
  ]);
});
