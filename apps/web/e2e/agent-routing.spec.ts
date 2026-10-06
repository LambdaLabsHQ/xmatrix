import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_SPACE, fixtureJson, fixtureRequestBodies,
  installWorkspaceStubs } from "./workspace-fixtures";

test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 });
test.beforeEach(async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, { ...E2E_CHANNEL, id: "channel-random", name: "random" }] });
  await fixtureJson(page, "routing-source", "**/api/xmatrix/channels/channel-general/messages",
    { message: { id: "routing-source-id" } }, { method: "POST" });
  await fixtureJson(page, "registration-catalog", "**/agent-registrations",
    { code: "registration_cutover_required", error: "Not activated" }, { status: 503 });
});

test("composer routes with @mentions and does not expose a separate auto-route form", async ({ page }) => {
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  await expect(page.locator("textarea.composer-textarea").first()).toBeVisible();
  await expect(page.getByText("Auto route this task", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send and auto route", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Model", { exact: true })).toHaveCount(0);
});


async function installCanonicalCatalog(page: import("@playwright/test").Page) {
  const locations = ["Workstation", "MacBook"].map((machineName, index) => ({
    key: { spaceId: E2E_SPACE.id, ownerUserId: `owner-${index}`, machineId: `machine-${index}`, harness: "codex" },
    displayName: "codex", ownerName: `Owner ${index + 1}`, machineName, version: 1, state: "enabled",
    models: ["same-model"], routingReady: true, canManageOwnerGrant: false, canConfigureSpace: false, canRemoveFromSpace: false,
  }));
  await fixtureJson(page, "registration-catalog", "**/agent-registrations", {
    registrations: locations, capabilities: [{ harness: "codex", models: ["same-model"], locations }],
  });
  return locations;
}

async function canonicalComposer(page: import("@playwright/test").Page) {
  const locations = await installCanonicalCatalog(page);
  await page.goto("/app/personal-sspaceperso/channels/channel-general");
  const draft = page.locator("textarea.composer-textarea").first();
  return { draft, locations };
}

async function selectMacBook(page: import("@playwright/test").Page, draft: import("@playwright/test").Locator) {
  await draft.fill("@codex/mac");
  await page.getByRole("option", { name: /owner:Owner 2 · machine:MacBook/u }).click();
  await expect(page.getByLabel("Selected Agents", { exact: true })).toContainText("owner:Owner 2 · machine:MacBook");
}

async function sendSelectedDraft(page: import("@playwright/test").Page, draft: import("@playwright/test").Locator) {
  await draft.press("Escape"); await draft.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "routing-source")).length).toBe(1);
  return (await fixtureRequestBodies(page, "routing-source"))[0];
}

async function expectSelectedMachineSent(page: import("@playwright/test").Page,
  draft: import("@playwright/test").Locator, key: { spaceId: string; ownerUserId: string; machineId: string; harness: string }) {
  const request = await sendSelectedDraft(page, draft);
  expect(request.invocationSelections.selections[0].target).toEqual({ kind: "registration", key });
}

test("composer sends one capability selection bound to its final message text", async ({ page }) => {
  const { draft } = await canonicalComposer(page);
  await draft.fill("@cod");
  const candidate = page.getByRole("option", { name: /codex.*Choose automatically/u });
  await expect(candidate).toHaveCount(1);
  await candidate.click();
  await draft.fill("@codex fix this");
  const request = await sendSelectedDraft(page, draft);
  expect(request.body).toBe("@codex fix this");
  expect(request.invocationSelections).toMatchObject({ schemaVersion: 1, sourceRevision: 1,
    selections: [{ start: 0, end: 6, text: "@codex", target: { kind: "capability", harness: "codex" } }] });
  expect(request.invocationSelections.sourceBodyHash).toMatch(/^[a-f0-9]{64}$/u);
});

test("an edited selection is sent as written, never bound to the old pick", async ({ page }) => {
  const { draft } = await canonicalComposer(page);
  await selectMacBook(page, draft);
  await draft.fill("@changed task");
  const request = await sendSelectedDraft(page, draft);
  expect(request.body).toBe("@changed task");
  expect(request.invocationSelections).toBeUndefined();
});


test("restored channel drafts keep an explicit machine selection", async ({ page }) => {
  const { draft, locations } = await canonicalComposer(page);
  await selectMacBook(page, draft);
  await draft.fill("@codex task");
  await draft.press("Escape");
  await page.getByRole("button", { name: /random/i }).first().click();
  await draft.fill("Unrelated draft");
  await page.getByRole("button", { name: /general/i }).first().click();
  await expect(draft).toHaveValue("@codex task");
  await expectSelectedMachineSent(page, draft, locations[1].key);
});
