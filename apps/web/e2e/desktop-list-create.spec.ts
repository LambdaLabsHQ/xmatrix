import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { CREATED_CHANNEL_ID, fixtureChannelCreate, fixtureCreatedChannelId, fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { startedMarkdown } from "./page-document-fixture";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, harnessRegistrations, installPageTreeStubs, openWorkspaceWithStubs }
  from "./workspace-fixtures";

/* A desktop list leads with its +: its first row, full width and square like
   the rows, set apart by its tone. Nothing floats over what is open. */

test.use(E2E_DESKTOP_CONTEXT);

const stubPageCreate = (page: Page) => fixtureJson(page, "page-create", /\/api\/xmatrix\/spaces\/[^/]+\/pages$/u,
  { page: { pageId: "p-new", parentPageId: null, title: "Untitled", position: "Z", accessMode: "open", headRevision: 1,
    agentSuggestOnly: false, canEdit: true, updatedAt: "2026-09-27T12:00:00.000Z" } }, { method: "POST" });

test("the conversation list leads with New conversation, lit while the draft is open", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });

  const create = page.locator(".app-sidebar .app-list-create");
  await expect(create).toBeVisible();
  await expect(create).toHaveAccessibleName("New conversation");
  await expect(create).toHaveAttribute("title", /^New conversation \((⌘N|Ctrl\+N)\)$/u);
  // The phone's + stays a phone control, and nothing floats over the conversation.
  await expect(page.locator(".app-mobile-create-fab")).toBeHidden();
  await expect(page.locator(".app-main .app-list-create")).toHaveCount(0);

  // It sits above the rows, a square full-width row, not wood or glass.
  const heading = page.locator(".app-sidebar .app-list-section-heading").first();
  const row = page.locator(".app-sidebar .app-channel-row").first();
  const [createBox, headingBox, rowBox] = await Promise.all([create.boundingBox(), heading.boundingBox(),
    row.boundingBox()]);
  expect(createBox && headingBox && rowBox).toBeTruthy();
  // Directly above them: the +, then the first section's name, then its first row, with no gaps.
  expect(headingBox!.y - (createBox!.y + createBox!.height)).toBeCloseTo(0, 0);
  expect(rowBox!.y - (headingBox!.y + headingBox!.height)).toBeCloseTo(0, 0);
  const paint = await create.evaluate((button) => {
    const style = getComputedStyle(button);
    return { backdrop: style.backdropFilter, image: style.backgroundImage, radius: style.borderTopLeftRadius };
  });
  expect(paint).toEqual({ backdrop: "none", image: "none", radius: "0px" });
  // As wide and as tall as a conversation row, its label where the names start, in their type.
  expect(createBox!.width).toBeCloseTo(rowBox!.width, 0);
  expect(createBox!.height).toBeCloseTo(rowBox!.height, 0);
  const label = create.locator("span").last();
  const name = row.locator(".app-channel-row-name");
  const [labelBox, nameBox] = await Promise.all([label.boundingBox(), name.boundingBox()]);
  expect(labelBox!.x).toBeCloseTo(nameBox!.x, 0);
  const type = (element: Element) => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.fontWeight];
  };
  expect(await label.evaluate(type)).toEqual(await name.evaluate(type));

  await create.click();
  await expect(page.getByTestId("new-conversation")).toBeVisible();
  await expect(create).toHaveClass(/app-list-create-active/u);
});

test("the page tree leads with New page, and Ctrl+N there makes a page", async ({ page }) => {
  await installPageTreeStubs(page, ["Home"]);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  await expect(page.locator(".app-page-article")).toBeVisible();

  const create = page.locator(".app-sidebar .app-list-create");
  await expect(create).toBeVisible();
  await expect(create).toHaveAccessibleName("New page");
  await expect(page.locator(".app-main .app-list-create")).toHaveCount(0);
  const heading = page.locator(".app-sidebar .app-list-section-heading", { hasText: "All pages" });
  const row = page.locator(".app-sidebar .app-page-row").first();
  const [createBox, headingBox, rowBox, labelBox, titleBox] = await Promise.all([create.boundingBox(),
    heading.boundingBox(), row.boundingBox(), create.locator("span").last().boundingBox(),
    row.getByText("Home", { exact: true }).boundingBox()]);
  expect(createBox!.height).toBeCloseTo(rowBox!.height, 0);
  expect(labelBox!.x).toBeCloseTo(titleBox!.x, 0);
  // With no recent changes, the + leads straight into All pages and its first page.
  expect(headingBox!.y - (createBox!.y + createBox!.height)).toBeCloseTo(0, 0);
  expect(rowBox!.y - (headingBox!.y + headingBox!.height)).toBeCloseTo(0, 0);

  // Ctrl+N opens an untitled page at once, as Notion does, as any page opens; it is named on the page.
  await stubPageCreate(page);
  await page.keyboard.press("Control+n");
  await expect(page).toHaveURL(/page=new/u);
  await expect(page.getByTestId("page-editor").locator(".page-document")).toBeFocused();
  await expect(page.getByTestId("page-editor")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("new-conversation")).toBeHidden();
  // Left with nothing written, it is not kept.
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  await expect(page).not.toHaveURL(/page=new/u);
  expect(await fixtureRequestBodies(page, "page-create")).toEqual([]);

  // Its first write makes it, copy-on-write, from what is written; Enter goes on into its text.
  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("page-editor").locator(".page-document")).toBeFocused();
  await expect(page.getByTestId("page-title")).toHaveAttribute("data-placeholder", "Untitled");
  await page.keyboard.type("Plans");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "page-create")).length).toBe(1);
  const [made] = await fixtureRequestBodies(page, "page-create");
  expect(made).toMatchObject({ parentPageId: null });
  expect(startedMarkdown(made!.document)).toBe("# P\n");
  await expect(page).toHaveURL(/page=p-new/u);
});

test("a new page's header is empty, and calling an Agent with @ makes it", async ({ page }) => {
  await installPageTreeStubs(page, ["Home"]);
  const registrations = harnessRegistrations(["claude", "codex"]);
  await fixtureJson(page, "registration-catalog", "**/agent-registrations", { registrations,
    capabilities: registrations.map((registration) => ({ harness: registration.key.harness, models: [], locations: [registration] })) });
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  await expect(page.locator(".app-page-article")).toBeVisible();
  await stubPageCreate(page);
  await fixtureChannelCreate(page, "writer-conversation", E2E_CHANNEL);
  await fixtureJson(page, "writer-link", /\/api\/xmatrix\/spaces\/[^/]+\/page-links$/u,
    { link: {} }, { method: "POST" });
  await fixtureJson(page, "co-writing", /\/api\/xmatrix\/spaces\/[^/]+\/pages\/p-new\/co-writing$/u,
    { startedAt: "2026-10-18T00:00:00Z" }, { method: "POST" });
  await fixtureJson(page, "writer-message", new RegExp(`/api/xmatrix/channels/${CREATED_CHANNEL_ID}/messages$`, "u"),
    { message: {} }, { method: "POST" });

  await page.keyboard.press("Control+n");
  await expect(page.getByTestId("page-editor").locator(".page-document")).toBeFocused();
  // Its header is a page's; what needs a made page (History, Share) comes with the first write.
  const controls = page.getByTestId("page-controls");
  await expect(controls.getByRole("button")).toHaveCount(0);
  await page.keyboard.type("@cod");
  await page.getByTestId("page-agent-menu").getByRole("option", { name: /codex/u }).click();
  // Calling an Agent to write it is a write: the page is made for the Agent to write.
  await expect.poll(async () => (await fixtureRequestBodies(page, "page-create")).length).toBe(1);
  const [made] = await fixtureRequestBodies(page, "page-create");
  expect(made).toMatchObject({ parentPageId: null });
  await expect(page).toHaveURL(/page=p-new/u);
  await expect.poll(async () => (await fixtureRequestBodies(page, "writer-message"))[0]?.body)
    .toMatch(/^@codex launch:force page:p-new/u);
  expect(await fixtureRequestBodies(page, "co-writing")).toEqual([{
    conversationId: await fixtureCreatedChannelId(page, "writer-conversation"), live: true }]);
  expect(await page.evaluate(() => window.localStorage.getItem("xmatrix.page-writer.space-personal"))).toBe("codex");
});

test("the agent list leads with Manage machines, and an agent, its machines and the + are one height", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL],
    registrations: [{ key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "mac-id", harness: "codex" },
      displayName: "codex", machineName: "My Mac", models: [] }] });
  await page.locator(".app-rail").getByRole("button", { name: "Agents", exact: true }).click();

  const create = page.locator(".app-tool-list .app-list-create");
  await expect(create).toHaveAccessibleName("Manage machines");
  const heading = page.locator(".app-tool-list-group-title").first();
  const machine = page.locator(".app-tool-list-row").first();
  await expect(machine).toBeVisible();
  const [createBox, headingBox, machineBox, labelBox, nameBox] = await Promise.all([create.boundingBox(),
    heading.boundingBox(), machine.boundingBox(), create.locator("span").last().boundingBox(),
    heading.getByText("codex", { exact: true }).boundingBox()]);
  expect(headingBox!.height).toBeCloseTo(machineBox!.height, 0);
  expect(headingBox!.y - (createBox!.y + createBox!.height)).toBeCloseTo(0, 0);
  expect(createBox!.height).toBeCloseTo(headingBox!.height, 0);
  expect(labelBox!.x).toBeCloseTo(nameBox!.x, 0);
});

test("a page row makes a page under it from its own +, shown while the row is hovered", async ({ page }) => {
  await installPageTreeStubs(page, ["Home"]);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  const row = page.locator(".app-sidebar .app-page-row", { hasText: "Home" });
  const create = row.getByRole("button", { name: "New sub-page" });
  await expect(create).toHaveCSS("opacity", "0");
  await row.hover();
  await expect(create).toHaveCSS("opacity", "1");

  await stubPageCreate(page);
  await create.click();
  await expect(page.getByTestId("page-editor").locator(".page-document")).toBeFocused();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.keyboard.type("Child");
  // Named, it is made under that row, from its document as its first letter left it.
  await expect.poll(async () => (await fixtureRequestBodies(page, "page-create")).length).toBe(1);
  const [made] = await fixtureRequestBodies(page, "page-create");
  expect(made).toMatchObject({ parentPageId: "p-home" });
  expect(startedMarkdown(made!.document)).toBe("# C\n");
});
