import { expect, test, type Page } from "./fixtures";
import { AGENT_ENVIRONMENT_QUERY, E2E_DESKTOP_CONTEXT, E2E_SPACE, fixtureJson, fixtureRequestBodies, openWorkspaceWithStubs,
  unconfirmedAccess } from "./workspace-fixtures";

const key = { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine-remote", harness: "codex" };
const registration = { key, displayName: "codex", machineName: "Remote server", ownerName: "E2E", state: "enabled",
  version: 3, models: [], routingReady: true, canManageOwnerGrant: true, canConfigureSpace: true, canRemoveFromSpace: true };
const CATALOG = /\/api\/xmatrix\/spaces\/[^/]+\/agent-registrations(?:\?[^#]*)?$/u;

async function openAgentPage(page: Page, entry: Record<string, unknown>, configuration?: Record<string, unknown>) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "catalog", CATALOG, { registrations: [entry],
    capabilities: [{ harness: "codex", models: [], locations: [entry] }] });
  if (configuration) {
    await fixtureJson(page, "details", "**/api/xmatrix/spaces/*/agent-registrations/query",
      { ...entry, configuration }, { method: "POST" });
  }
  await page.goto("/app/personal-sspaceperso/agents");
  await page.getByRole("row", { name: "Remote server" }).getByTestId("agent-row").click();
  await page.getByTestId("fleet-cell-open-agent").click();
}

test.use(E2E_DESKTOP_CONTEXT);
test("a Space admin reads and edits an Agent's settings directly on its page", async ({ page }) => {
  const errors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await openAgentPage(page, registration, { model: "gpt-5.5", instructions: "Review only.", workspaceReferences: ["/repo"] });
  await fixtureJson(page, "command", "**/api/xmatrix/spaces/*/agent-registrations/commands", { key, version: 4 },
    { method: "POST" });
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.getByLabel("Name")).toHaveValue("codex");
  await expect(settings.getByLabel("Default model")).toHaveValue("gpt-5.5");
  const mode = settings.getByLabel("Working mode");
  await expect(mode).toHaveValue("autonomous");
  await expect(settings.getByLabel("Instructions")).toHaveValue("Review only.");
  await expect(settings.getByRole("button", { name: "Save" })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agent-settings-resting.png") });
  await mode.selectOption("cautious");
  await settings.getByLabel("Instructions").fill("Review only. Ask before merging.");
  await page.screenshot({ path: test.info().outputPath("agent-settings.png") });
  await settings.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "command")).toEqual([expect.objectContaining({
    action: "configure", key, expectedVersion: 3, configuration: { model: "gpt-5.5", workingMode: "cautious",
      instructions: "Review only. Ask before merging.", workspaceReferences: ["/repo"] } })]);
  expect(errors).toEqual([]);
});

test("a Space admin picks the Default model from the harness's models, or names another", async ({ page }) => {
  const listed = { ...registration, modelCatalog: [
    { model: "gpt-5.5", description: "Frontier", efforts: [] }, { model: "gpt-5.5-mini", description: "", efforts: [] }] };
  await openAgentPage(page, listed, { instructions: "", workspaceReferences: [] });
  await fixtureJson(page, "command", "**/api/xmatrix/spaces/*/agent-registrations/commands", { key, version: 4 },
    { method: "POST" });
  const settings = page.getByRole("region", { name: "Settings" });
  const model = settings.getByRole("combobox", { name: "Default model" });
  await expect(model).toHaveValue("");
  await expect(model.locator("option")).toHaveText(["Harness default", "gpt-5.5", "gpt-5.5-mini", "Other model…"]);
  await model.selectOption("gpt-5.5-mini");
  await expect(settings.getByLabel("Model name")).toHaveCount(0);
  await model.selectOption({ label: "Other model…" });
  await settings.getByLabel("Model name").fill("o9-preview");
  await page.screenshot({ path: test.info().outputPath("agent-settings-model-menu.png") });
  await settings.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "command")).toEqual([expect.objectContaining({
    action: "configure", configuration: expect.objectContaining({ model: "o9-preview" }) })]);
});

test("an Agent's owner who cannot administer the Space still sees its settings read-only", async ({ page }) => {
  const owned = { ...registration, canConfigureSpace: false, canManageOwnerGrant: true };
  await openAgentPage(page, owned, { model: "gpt-5.5", workingMode: "cautious", instructions: "Review only.", workspaceReferences: [] });
  const settings = page.getByRole("region", { name: "Settings" });
  await expect(settings.getByTestId("agent-settings-readonly")).toContainText("gpt-5.5");
  await expect(settings.getByTestId("agent-settings-readonly")).toContainText("Cautious");
  await expect(settings.getByTestId("agent-settings-readonly")).toContainText("Review only.");
  await expect(settings.getByRole("textbox")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("agent-settings-readonly.png") });
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
  /* The text is the agent's, whichever machine runs it: a machine's page does not carry it. */
  const text = page.getByLabel("What codex is good at");
  await page.getByRole("row", { name: "Remote server" }).getByTestId("agent-row").click();
  await page.getByTestId("fleet-cell-open-agent").click();
  await expect(page.getByTestId("agent-open-machine")).toHaveCount(0);
  await expect(page.locator(".app-tool-detail").getByRole("heading", { level: 2, name: "codex" })).toBeVisible();
  await expect(text).toHaveCount(0);
  // Its page names the agent, which opens what is set on it everywhere.
  await page.getByTestId("agent-open-harness").click();
  await expect(page.getByTestId("agent-location")).toHaveText("Remote server");
  await expect(text).toHaveValue("Careful code review.");
  await expect(page.getByRole("button", { name: "Save" })).toHaveCount(0);
  const prose = "擅长代码审计。\nKeep UI work away from it: it is slow there.";
  await text.fill(prose);
  await page.screenshot({ path: test.info().outputPath("harness-profile.png") });
  await page.getByRole("button", { name: "Save" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "profile")).toEqual([
    { harness: "codex", description: prose, expectedRevision: 2 }]);
});

test("an Agent's page lists exactly what its launch adds, and its owner confirms an access they were never asked about", async ({ page }) => {
  const launch = { runtime: "codex", runtimeArgs: [] };
  const environment = { schemaVersion: 1, enabled: true, models: [], description: "", availability: "unknown", capabilities: [], launch };
  // One Agent per kind of thing a launch adds, each with the grant the Hub
  // resolves from its real preset: session values, an argument, an
  // environment variable, and nothing but the answered requests.
  const held = ["codex", "claude", "deepseek", "opencode"].map((harness) => ({ ...registration, key: { ...key, harness },
    displayName: harness, access: { ...unconfirmedAccess(harness).fullAccess, confirmed: false } }));
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE] });
  await fixtureJson(page, "catalog", CATALOG, { registrations: held,
    capabilities: held.map((location) => ({ harness: location.key.harness, models: [], locations: [location] })) });
  await fixtureJson(page, "environment", AGENT_ENVIRONMENT_QUERY, { ...unconfirmedAccess("codex"), key, version: 5, environment }, { method: "POST" });
  await fixtureJson(page, "environment-command", "**/api/xmatrix/agent-environments/commands", { key, version: 6 }, { method: "POST" });
  for (const location of [...held].reverse()) {
    const grant = location.access;
    await page.goto(`/app/personal-sspaceperso/agents`);
    await page.getByRole("row", { name: "Remote server" })
      .getByRole("button", { name: new RegExp(`^${location.key.harness} on Remote server`, "u") }).click();
    await page.getByTestId("fleet-cell-open-agent").click();
    const lines = page.getByTestId("agent-access").getByTestId("agent-access-lines").getByRole("listitem");
    // One line for each thing the grant adds, written as the grant writes it:
    // none missing, none borrowed from another harness.
    const written = [...grant.args, ...Object.entries(grant.env).map(([name, value]) => `${name}=${value}`),
      ...Object.entries(grant.session).map(([name, value]) => `${name}=${value}`)];
    await expect(lines, location.key.harness).toHaveCount((written.length || 1) + (grant.approvesRequests ? 1 : 0));
    for (const [index, value] of written.entries()) await expect(lines.nth(index), location.key.harness).toContainText(value);
    await page.screenshot({ path: test.info().outputPath(`agent-access-${location.key.harness}.png`) });
  }
  // Codex was shown last. Its owner confirms what they just read.
  await page.getByTestId("agent-access").getByRole("button", { name: "Review and confirm" }).click();
  await page.getByRole("dialog", { name: "Codex: full access on this machine?" }).getByRole("button", { name: "Confirm with full access" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "environment-command")).toEqual([expect.objectContaining({
    expectedVersion: 5, environment: { ...environment, launch: { ...launch, access: "full" } } })]);
});
