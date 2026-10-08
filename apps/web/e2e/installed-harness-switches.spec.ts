import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, E2E_NOW, fixtureJson,
  fixtureRule, fixtureRequestBodies, openWorkspaceWithStubs } from "./workspace-fixtures";

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
      await codex.click();
      await expect.poll(() => fixtureRequestBodies(page, "enable-command")).toEqual([
        expect.objectContaining({ action: "create", key: key("codex") }),
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
      await fixtureJson(page, "enable-command", COMMANDS, { version: 1 }, { method: "POST" });
      await fixtureRule(page, { id: "enabled-catalog", pattern: CATALOG, responder: { kind: "sequence",
        responses: [catalog(["claude"]), catalog(["claude", "codex"])].map((json) => ({ json })) } });
      await bring.click();
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
  await codex.click();
  await expect(list.getByRole("alert")).toHaveText("Machine owner access was revoked");
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
  await bring.click();
  await expect(page.getByTestId("installed-harness-switches").getByRole("alert")).toHaveText("Space policy changed. Try again.");
  await expect(bring).toBeVisible();
  await fixtureJson(page, "retry-enable", COMMANDS, { version: 1 }, { method: "POST" });
  await fixtureJson(page, "retry-catalog", CATALOG, catalog(["claude", "codex"]));
  await bring.click();
  await expect.poll(() => fixtureRequestBodies(page, "retry-enable")).toEqual([
    expect.objectContaining({ action: "create", key: key("codex") }),
  ]);
  await expect(bring).toHaveCount(0);
});
