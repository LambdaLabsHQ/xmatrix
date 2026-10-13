import { expect, test } from "./fixtures";
import { E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureJson, fixtureRequestBodies, openWorkspaceWithStubs } from "./workspace-fixtures";

const key = { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine-remote", harness: "codex" };
const registration = { key, displayName: "codex", machineName: "Remote server", ownerName: "E2E", state: "enabled",
  version: 3, models: [], routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true };
const CATALOG = /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?[^#]*)?$/u;

test.use(E2E_DESKTOP_CONTEXT);
test("a Space admin sets an Agent's working mode and instructions", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "catalog", CATALOG, { registrations: [registration],
    capabilities: [{ harness: "codex", models: [], locations: [registration] }] });
  await fixtureJson(page, "details", "**/api/xmatrix/spaces/*/agent-registrations/query", {
    ...registration, configuration: { model: "gpt-5.5", instructions: "Review only.", workspaceReferences: ["/repo"] },
  }, { method: "POST" });
  await fixtureJson(page, "command", "**/api/xmatrix/spaces/*/agent-registrations/commands", { key, version: 4 },
    { method: "POST" });
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/app/personal-sspaceperso/agents");
  await page.getByTestId("agent-row").filter({ hasText: "Remote server" }).click();
  await page.getByRole("button", { name: "Configure: codex" }).click();
  const mode = page.getByLabel("Working mode");
  await expect(mode).toHaveValue("autonomous");
  await expect(page.getByLabel("Instructions")).toHaveValue("Review only.");
  await mode.selectOption("cautious");
  await page.getByLabel("Instructions").fill("Review only. Ask before merging.");
  await page.screenshot({ path: test.info().outputPath("agent-settings.png") });
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "command")).toEqual([expect.objectContaining({
    action: "configure", key, expectedVersion: 3, configuration: { model: "gpt-5.5", workingMode: "cautious",
      instructions: "Review only. Ask before merging.", workspaceReferences: ["/repo"] } })]);
  expect(errors).toEqual([]);
});

test("whoever may describe a harness writes what it is for in place, as free text", async ({ page }) => {
  const described = { ...registration, canConfigureSpace: false,
    profile: { description: "Careful code review.", revision: 2 }, canDescribe: true };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "catalog", CATALOG, { registrations: [described],
    capabilities: [{ harness: "codex", models: [], locations: [described] }] });
  await fixtureJson(page, "profile", "**/api/xmatrix/spaces/*/agent-registrations/profiles",
    { harness: "codex", description: "saved", revision: 3 }, { method: "POST" });
  await page.goto("/app/personal-sspaceperso/agents");
  await page.getByTestId("agent-row").filter({ hasText: "Remote server" }).click();
  const text = page.getByLabel("When to pick codex");
  await expect(text).toHaveValue("Careful code review.");
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  const prose = "擅长代码审计。\nKeep UI work away from it: it is slow there.";
  await text.fill(prose);
  await page.screenshot({ path: test.info().outputPath("harness-profile.png") });
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "profile")).toEqual([
    { harness: "codex", description: prose, expectedRevision: 2 }]);
});
