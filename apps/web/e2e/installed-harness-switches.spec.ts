import { expect, test } from "./fixtures";
import { AGENT_ENVIRONMENT_QUERY, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, E2E_NOW, fixtureJson,
  fixtureRule, fixtureRequestBodies, fixtureUnconfirmedAccess, openWorkspaceWithStubs } from "./workspace-fixtures";

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

function installedHarnessTests(name: string, context: typeof E2E_DESKTOP_CONTEXT | typeof E2E_MOBILE_CONTEXT) {
  test.describe(name, () => {
    test.use(context);
    test("Agents offers installed harnesses from a remote machine without registering them", async ({ page }) => {
      await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
      await page.goto("/app/personal-sspaceperso/agents");
      const list = page.getByRole("region", { name: "Agents", exact: true }).getByTestId("installed-harness-switches");
      await expect(list.getByRole("switch")).toHaveCount(2);
      const codex = list.getByRole("switch", { name: "Enabled: Codex on Remote server" });
      await expect(codex).toHaveAttribute("aria-checked", "false");
      await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
      expect(await fixtureRequestBodies(page, "enable-command")).toEqual([]);
      await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["codex"]));
      await fixtureUnconfirmedAccess(page);
      await codex.click();
      // Its owner reads what full access adds before anything is written.
      const confirmation = page.getByRole("dialog", { name: "Codex: full access on this machine?" });
      await expect(confirmation.getByTestId("agent-access-lines")).toContainText("Starts each session with sandbox=danger-full-access");
      expect(await fixtureRequestBodies(page, "enable-command")).toEqual([]);
      await page.screenshot({ path: test.info().outputPath(`access-confirmation-${name}.png`) });
      await confirmation.getByRole("button", { name: "Add with full access" }).click();
      await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
        expect.objectContaining({ action: "create", key: key("codex"),
          environment: expect.objectContaining({ launch: expect.objectContaining({ access: "full" }) }) }),
      ]);
      await expect(list.getByRole("switch")).toHaveCount(1);
      await expect(page.getByTestId("agent-row").filter({ hasText: "Remote server" })).toBeVisible();
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
      await fixtureUnconfirmedAccess(page);
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
  await page.goto("/app/personal-sspaceperso/agents");
  await fixtureRule(page, { id: "enable-refused", pattern: COMMANDS, method: "POST",
    responder: { kind: "static", status: 403, json: { error: "Machine owner access was revoked" } } });
  const list = page.getByRole("region", { name: "Agents", exact: true }).getByTestId("installed-harness-switches");
  const codex = list.getByRole("switch", { name: "Enabled: Codex on Remote server" });
  await fixtureUnconfirmedAccess(page);
  await codex.click();
  await page.getByRole("button", { name: "Add with full access" }).click();
  await expect(list.getByRole("alert")).toHaveText("Couldn't save the harness switch. Machine owner access was revoked.");
  await expect(codex).toHaveAttribute("aria-checked", "false");
});

test("another owner's inventory is never offered as an owner switch", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [{ ...machine, userId: "another-owner" }] });
  await page.goto("/app/personal-sspaceperso/agents");
  await expect(page.getByTestId("installed-harness-switches")).toHaveCount(0);
});

test("bulk failure stays visible and retry continues with the remaining pair", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  await page.goto("/app/personal-sspaceperso/chat");
  const bring = page.getByRole("button", { name: "Bring them in", exact: true });
  await expect(bring).toBeVisible();
  await fixtureRule(page, { id: "partial-enable", pattern: COMMANDS, method: "POST", responder: { kind: "sequence",
    responses: [{ json: { version: 1 } }, { status: 409, json: { error: "Space policy changed. Try again." } }] } });
  await fixtureJson(page, "partial-catalog", CATALOG, catalog(["claude"]));
  await fixtureUnconfirmedAccess(page);
  await bring.click();
  await page.getByRole("button", { name: "Add 2 with full access" }).click();
  await expect(page.getByTestId("installed-harness-switches").getByRole("alert")).toHaveText("Couldn't save the harness switch. Space policy changed. Try again.");
  await expect(bring).toBeVisible();
  await fixtureJson(page, "retry-enable", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "retry-catalog", CATALOG, catalog(["claude", "codex"]));
  await bring.click();
  await page.getByRole("button", { name: "Add with full access" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "retry-enable")).toEqual([
    expect.objectContaining({ action: "create", key: key("codex") }),
  ]);
  await expect(bring).toHaveCount(0);
});

test("declining the access question adds nothing, and a harness confirmed earlier is not asked again", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], machineDaemons: [machine] });
  await page.goto("/app/personal-sspaceperso/agents");
  const list = page.getByRole("region", { name: "Agents", exact: true }).getByTestId("installed-harness-switches");
  const codex = list.getByRole("switch", { name: "Enabled: Codex on Remote server" });
  await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureUnconfirmedAccess(page);
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
  await page.goto("/app/personal-sspaceperso/agents");
  const list = page.getByRole("region", { name: "Agents", exact: true }).getByTestId("installed-harness-switches");
  await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "enabled-catalog", CATALOG, catalog(["claude"]));
  await fixtureJson(page, "environment", AGENT_ENVIRONMENT_QUERY, { version: 0, environment: null, accessModes: ["full", "ask"],
    fullAccess: { mode: "full", args: ["--dangerously-skip-permissions"], env: {}, session: {}, approvesRequests: true } },
  { method: "POST" });
  await list.getByRole("switch", { name: "Enabled: Claude Code on Remote server" }).click();
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
