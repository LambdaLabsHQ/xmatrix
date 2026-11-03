import type { Page } from "@playwright/test";

import { expect, test } from "./fixtures";
import { fixtureJson, fixtureRequestBodies } from "./in-page-api-fixtures";
import { startedMarkdown } from "./page-document-fixture";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_SPACE, installPageTreeStubs, openWorkspaceWithStubs }
  from "./workspace-fixtures";

/* A desktop list leads with its +: its first row, full width and square like
   the rows, set apart by its tone. Its label sits centred in a quieter ink
   than the rows' names, Ctrl/⌘+N at the row's end on the label's baseline.
   Nothing floats over what is open. */

/** Where a text box's baseline sits: an empty inline-block's bottom rests on it. */
const baseline = (element: Element) => {
  const probe = document.createElement("span");
  probe.style.display = "inline-block";
  element.append(probe);
  const y = probe.getBoundingClientRect().bottom;
  probe.remove();
  return y;
};

/** The label is centred in the row; the shortcut ends at the row's inset, on the label's baseline. */
async function expectCentredWithShortcut(create: ReturnType<Page["locator"]>) {
  const label = create.locator(".app-list-row-title");
  const hint = create.locator(".app-list-create-shortcut");
  await expect(hint).toHaveText(/^(⌘N|Ctrl\+N)$/u);
  const [box, labelBox, hintBox] = await Promise.all([create.boundingBox(), label.boundingBox(), hint.boundingBox()]);
  expect(labelBox!.x + labelBox!.width / 2).toBeCloseTo(box!.x + box!.width / 2, 0);
  expect(box!.x + box!.width - (hintBox!.x + hintBox!.width)).toBeCloseTo(20, 0);
  expect(await hint.evaluate(baseline)).toBeCloseTo(await label.evaluate(baseline), 0);
}

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
  // As wide and as tall as a conversation row, centred, in the names' size but lighter.
  expect(createBox!.width).toBeCloseTo(rowBox!.width, 0);
  expect(createBox!.height).toBeCloseTo(rowBox!.height, 0);
  await expectCentredWithShortcut(create);
  const label = create.locator(".app-list-row-title");
  const name = row.locator(".app-channel-row-name");
  const type = (element: Element) => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, weight: Number(style.fontWeight), color: style.color };
  };
  const [labelType, nameType] = await Promise.all([label.evaluate(type), name.evaluate(type)]);
  expect(labelType.size).toBe(nameType.size);
  expect(labelType.weight).toBeLessThan(nameType.weight);
  expect(labelType.color).not.toBe(nameType.color);

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
  const [createBox, headingBox, rowBox] = await Promise.all([create.boundingBox(), heading.boundingBox(),
    row.boundingBox()]);
  expect(createBox!.height).toBeCloseTo(rowBox!.height, 0);
  await expectCentredWithShortcut(create);
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
  // Its header has nothing until then: no Co-write (an Agent is called with @ in the text), no History or Share.
  await expect(page.getByTestId("page-controls").getByRole("button")).toHaveCount(0);
  await page.keyboard.type("Plans");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await fixtureRequestBodies(page, "page-create")).length).toBe(1);
  const [made] = await fixtureRequestBodies(page, "page-create");
  expect(made).toMatchObject({ parentPageId: null });
  expect(startedMarkdown(made!.document)).toBe("# P\n");
  await expect(page).toHaveURL(/page=p-new/u);
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
  const [createBox, headingBox, machineBox] = await Promise.all([create.boundingBox(), heading.boundingBox(),
    machine.boundingBox()]);
  expect(headingBox!.height).toBeCloseTo(machineBox!.height, 0);
  expect(headingBox!.y - (createBox!.y + createBox!.height)).toBeCloseTo(0, 0);
  expect(createBox!.height).toBeCloseTo(headingBox!.height, 0);
  await expectCentredWithShortcut(create);
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
