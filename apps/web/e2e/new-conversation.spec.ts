import { channelHistoryFixture, E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_MOBILE_CONTEXT, E2E_SPACE, fixtureConversationCreate, installWorkspaceStubs, startNewConversation } from "./workspace-fixtures";
import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";

// A new conversation is an empty conversation with the usual composer: + or Ctrl+N, type, send.
test.describe("on a desktop", () => {
test.use(E2E_DESKTOP_CONTEXT);
test("a new conversation completes the Space's repos after a summon", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness: "codex" },
      displayName: "codex", machineName: "My Mac", models: [] }],
    launchTargets: { repos: [{ value: "owner/xmatrix" }], workspaces: [] } });
  await page.goto("/app", { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar .app-list-create").click();
  const input = page.getByTestId("new-conversation").getByLabel("What should happen");
  await input.pressSequentially("@codex rep");
  await expect(page.locator(".app-mention-suggestions").getByRole("option")
    .filter({ hasText: "repo:owner/xmatrix" })).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue("@codex repo:owner/xmatrix ");
});

test("the empty composer takes turns teaching what typing @, /, [[ and # opens, caret or not", async ({ page }) => {
  await page.clock.install();
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const composer = await startNewConversation(page);
  await expect(composer.getByLabel("What should happen")).toBeFocused();
  const hint = composer.getByTestId("composer-hint");
  await expect(hint).toHaveText("@ to summon an agent");
  await page.clock.runFor(4000);
  await expect(hint).toHaveText("/ for commands");
  await composer.getByLabel("What should happen").fill("hello");
  await expect(hint).toHaveCount(0);
});

test("+ and Ctrl+N open an empty conversation, and its first message creates it, named from what it asks", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const created = { ...E2E_CHANNEL, id: "c-new", name: "fix the flaky login test" };
  await fixtureConversationCreate(page, created);
  await fixtureJson(page, "channel-general-history", "**/api/xmatrix/channels/channel-general/history**",
    { messages: channelHistoryFixture(1, "general"), hasMore: false });

  const composer = await startNewConversation(page);
  await expect(composer).toBeVisible();
  await composer.getByLabel("What should happen").press("Escape");
  await expect(composer).toBeHidden();

  // With a conversation open, + and Ctrl+N still open a new one in its place; Escape brings it back.
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const open = page.getByText("Message 1.", { exact: false }).first();
  await expect(open).toBeVisible();
  await page.locator(".app-sidebar .app-list-create").click();
  await expect(composer).toBeVisible();
  await composer.getByLabel("What should happen").press("Escape");
  await expect(composer).toBeHidden();
  await expect(open).toBeVisible();

  await page.keyboard.press("Control+n");
  await expect(composer).toBeVisible();
  await composer.getByTitle("Open: everyone in the Space can see it").click();
  await expect(composer.getByTitle("Closed: only people you add can see it")).toBeVisible();
  await composer.getByLabel("What should happen").fill("@auto fix the flaky login test\nand open a PR");
  await page.screenshot({ path: test.info().outputPath("new-conversation.png") });
  await composer.getByLabel("What should happen").press("Enter");

  await expect(composer).toBeHidden();
  await expect.poll(() => fixtureRequestBodies(page, "conversation-create")).toEqual([expect.objectContaining({
    spaceId: E2E_SPACE.id, name: "fix the flaky login test", mode: "closed",
    metadata: { createdBy: "web", autoName: true },
  })]);
  await expect.poll(() => fixtureRequestBodies(page, "conversation-first-message"))
    .toEqual([expect.objectContaining({ body: "@auto fix the flaky login test\nand open a PR" })]);
  await expect(page).toHaveURL(/c-new/u);
});

test("a new conversation opens as soon as it exists, its first message pending while it sends", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const created = { ...E2E_CHANNEL, id: "c-new", name: "check the deploy" };
  await fixtureConversationCreate(page, created);
  // The first message's append is slow (an Agent launch answers only once it is handed over).
  await fixtureJson(page, "conversation-first-message", /\/api\/xmatrix\/channels\/c-new\/messages$/u,
    { message: { messageId: "m-1" } }, { method: "POST", delayMs: 5_000 });

  const composer = await startNewConversation(page);
  await composer.getByLabel("What should happen").fill("@auto check the deploy");
  await composer.getByLabel("What should happen").press("Enter");

  await expect(composer).toBeHidden({ timeout: 2_000 });
  await expect(page).toHaveURL(/c-new/u, { timeout: 2_000 });
  await expect(page.locator(".app-main").getByText("@auto check the deploy").first()).toBeVisible({ timeout: 2_000 });
  await expect.poll(() => fixtureRequestBodies(page, "conversation-first-message"))
    .toEqual([expect.objectContaining({ body: "@auto check the deploy" })]);
});

test("an open draft gives way to every other rail destination and does not come back", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels/general-cchannelgen", { waitUntil: "domcontentloaded" });
  const composer = page.getByTestId("new-conversation");
  const rail = page.locator(".app-rail");
  for (const label of ["Machines", "Schedules", "Settings"]) {
    // A destination with a list of its own shows it in the conversation list's place.
    await rail.getByRole("button", { name: "Channels", exact: true }).click();
    await page.locator(".app-sidebar .app-list-create").click();
    await expect(composer).toBeVisible();
    await rail.getByRole("button", { name: label, exact: true }).click();
    await expect(composer).toBeHidden();
    await expect(page.locator(".app-main").getByRole("heading", { level: 1, name: label, exact: true })).toBeVisible();
  }
  await rail.getByRole("button", { name: "Channels", exact: true }).click();
  await expect(composer).toBeHidden();
});
});

test.describe("on a phone", () => {
  test.use(E2E_MOBILE_CONTEXT);
  test("the + on the Channels list pushes an empty conversation, and sending opens it", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await fixtureJson(page, "conversation-create", /\/api\/xmatrix\/channels$/u,
      { channel: { ...E2E_CHANNEL, id: "c-phone", name: "check the release" } }, { method: "POST" });
    await fixtureJson(page, "conversation-first-message", /\/api\/xmatrix\/channels\/c-phone\/messages$/u,
      { message: { messageId: "m-1" } }, { method: "POST" });

    await page.goto("/app", { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Channels" }).tap();
    await page.getByRole("button", { name: "New conversation" }).tap();
    const composer = page.getByTestId("new-conversation");
    await expect(composer).toBeVisible();
    await expect(page.getByText("New conversation", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Back to channels" }).tap();
    await expect(composer).toBeHidden();
    await page.getByRole("button", { name: "New conversation" }).tap();
    await composer.getByLabel("What should happen").fill("check the release");
    await page.screenshot({ path: test.info().outputPath("new-conversation-phone.png") });
    await composer.getByRole("button", { name: "Start conversation" }).tap();
    await expect(composer).toBeHidden();
    await expect.poll(() => fixtureRequestBodies(page, "conversation-create")).toEqual([expect.objectContaining({
      name: "check the release", metadata: { createdBy: "web", autoName: true } })]);
    await expect(page).toHaveURL(/c-phone/u);
  });
});
