import { expect, test, type Page } from "./fixtures";
import { fixtureJson, fixtureRequests } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_MOBILE_CONTEXT,
  E2E_NOW,
  E2E_SPACE,
  installPageTreeStubs,
  installWorkspaceStubs,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

const RELEASE = { ...E2E_CHANNEL, id: "channel-release", name: "release-train", updatedAt: "2026-06-30T00:00:00.000Z" };

function hit(index: number, channelId: string) {
  return {
    kind: "message", entityId: `m-${index}`, entityVersion: 1, matchTier: "verified_substring", field: "body",
    fieldPriority: 0, searchRankSeq: `${100 - index}`, snippet: `deploy the hub (${index})`, channelId,
    messageId: `m-${index}`, timelineSequence: index, senderLabel: "Yiming Hu", sentAt: E2E_NOW,
  };
}

async function stubMessageSearch(page: Page) {
  await fixtureJson(page, "message-search", /\/api\/xmatrix\/messages\/search(?:\?.*)?$/u, {
    execution: "proven", results: [hit(1, E2E_CHANNEL.id), hit(2, RELEASE.id)],
  });
}

function searchParams(url: string) {
  return new URL(url, "http://localhost").searchParams;
}

test("⌘F inside a conversation searches only it, and Backspace widens it to the Space", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  await page.goto(`/app/${E2E_SPACE.id}/channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".app-rail")).toBeVisible();

  await page.keyboard.press("Control+f");
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await expect(dialog).toBeVisible();
  const field = page.locator(".app-search-panel-field");
  await expect(field.getByText("in #general")).toBeVisible();
  await page.keyboard.type("deploy");
  await expect(dialog.getByText("deploy the hub (1)")).toBeVisible();
  await expect.poll(async () => (await fixtureRequests(page, "message-search"))
    .some((url) => searchParams(url).get("channelId") === E2E_CHANNEL.id)).toBe(true);

  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(field.getByText("in #general")).toHaveCount(0);
});

test("search is the window's, not the rail's: the top bar opens it in every view", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await expect(page.locator(".app-rail")).toBeVisible();
  await expect(page.locator(".app-rail").getByRole("button", { name: /Search/u })).toHaveCount(0);
  for (const path of ["pages", "agents", "settings"]) {
    await page.goto(`/app/${E2E_SPACE.id}/${path}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-global-bar").getByRole("button", { name: "Search" })).toBeVisible();
  }
  // A bare magnifier like the conversation header's: no fill, border or shadow, even on hover.
  const icon = page.locator(".app-global-bar").getByRole("button", { name: "Search" });
  await icon.hover();
  expect(await icon.evaluate((node) => {
    const style = getComputedStyle(node);
    return [style.backgroundColor, style.borderWidth, style.boxShadow, node.getBoundingClientRect().width];
  })).toEqual(["rgba(0, 0, 0, 0)", "0px", "none", 32]);
  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});

test("Enter opens the active result, and the panel lists every message hit", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  await page.goto(`/app/${E2E_SPACE.id}/channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await page.keyboard.type("deploy");
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await expect(dialog.getByText("deploy the hub (1)")).toBeVisible();
  await expect(dialog.getByText("deploy the hub (2)")).toBeVisible();
  // The Enter that commits an input method's candidate is not the field's.
  const address = page.url();
  for (const ime of [{ isComposing: true, keyCode: 229 }, { isComposing: false, keyCode: 229 }]) {
    const claimed = await dialog.getByRole("textbox").evaluate((node, init) => !node.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", ...init })), ime);
    expect(claimed).toBe(false);
  }
  await expect(dialog).toBeVisible();
  expect(page.url()).toBe(address);
  await page.keyboard.press("Enter");

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}#message:m-1$`, "u"));

  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await page.keyboard.type("deploy");
  await expect(dialog.getByText("deploy the hub (2)")).toBeVisible();
  await dialog.getByText("deploy the hub (2)").click();
  await expect(page).toHaveURL(new RegExp(`/channels/${RELEASE.name}--${RELEASE.id}#message:m-2$`, "u"));
});

test("a conversation found by name opens and is revealed in the list", async ({ page }) => {
  const channels = Array.from({ length: 18 }, (_, index) => ({
    ...E2E_CHANNEL,
    id: `channel-${index.toString().padStart(2, "0")}`,
    name: `project-${index.toString().padStart(2, "0")}`,
    updatedAt: `2026-07-01T00:${(59 - index).toString().padStart(2, "0")}:00.000Z`,
  }));
  const target = channels[17];
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });
  await stubMessageSearch(page);
  const row = page.locator(".app-sidebar-pane-body").locator(`[data-channel-row-id="${target.id}"]`);
  await expect(row).toBeAttached();
  await expect(row).not.toBeInViewport();

  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await page.keyboard.type(target.name);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("button", { name: new RegExp(`#${target.name}`, "u") }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/${target.name}--${target.id}$`, "u"));
  await expect(row).toHaveClass(/app-channel-row-active/u);
  await expect(row).toBeInViewport();
});

test("conversation actions sit beside its name and borderless search aligns right", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const header = page.locator(".app-main .app-panel-header").first();
  const name = header.getByText(E2E_CHANNEL.name, { exact: true });
  const actions = header.getByRole("button", { name: "Copy channel link" });
  const search = header.getByRole("button", { name: "Search", exact: true });
  await expect(search).toBeVisible();
  await expect(page.locator(".app-global-bar")).toHaveCount(0);
  const [nameBox, actionsBox, searchBox] = await Promise.all([name.boundingBox(), actions.boundingBox(), search.boundingBox()]);
  expect(actionsBox!.x - (nameBox!.x + nameBox!.width)).toBeLessThanOrEqual(16);
  expect(searchBox!.x - (actionsBox!.x + actionsBox!.width)).toBeGreaterThan(100);
  const headerBox = await header.boundingBox();
  const paddingRight = await header.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight));
  expect(searchBox!.x + searchBox!.width).toBeCloseTo(headerBox!.x + headerBox!.width - paddingRight, 0);
  expect(searchBox!.y).toBeCloseTo(actionsBox!.y, 0);
  expect(await search.evaluate((node) => getComputedStyle(node).borderWidth)).toBe("0px");
  await search.hover();
  expect(await search.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
  await search.click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
  await expect(page.locator(".app-search-panel-field").getByText("in #general")).toHaveCount(0);
});

test("a page's controls end before the search icon", async ({ page }) => {
  await installPageTreeStubs(page, ["Home"]);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  const controls = page.getByTestId("page-controls");
  await expect(controls.getByRole("button", { name: /Share/u })).toBeVisible();
  const icon = await page.locator(".app-global-bar").getByRole("button", { name: "Search" }).boundingBox();
  const share = await controls.getByRole("button", { name: /Share/u }).boundingBox();
  expect(share!.x + share!.width).toBeLessThanOrEqual(icon!.x);
});

test("nothing scrolls under the window's search: a page scrolls below its controls, a paper below the band", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 760 });
  await installPageTreeStubs(page, ["Home"]);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  const icon = page.locator(".app-global-bar").getByRole("button", { name: "Search" });
  /** What scrolls in the window and reaches under its search icon. */
  const scrollingUnderIcon = () => icon.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return Array.from(document.querySelectorAll<HTMLElement>(".xmatrix-app *")).filter((element) => {
      if (!/auto|scroll/u.test(getComputedStyle(element).overflowY)) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.top < box.bottom && rect.bottom > box.top && rect.left < box.right && rect.right > box.left;
    }).map((element) => String(element.className).split(" ")[0]);
  });
  const controls = page.getByTestId("page-controls");
  await expect(controls.getByRole("button", { name: /Share/u })).toBeVisible();
  expect(await scrollingUnderIcon(), "pages").toEqual([]);
  // The page's controls hold the band; the page starts below them.
  const band = (await controls.boundingBox())!;
  const article = (await page.locator(".app-page-article").boundingBox())!;
  expect(article.y).toBeGreaterThanOrEqual(band.y + band.height);

  for (const path of ["status", "apps", "team", "settings", "profile"]) {
    await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/${path}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".app-tool-detail-scroll").first(), path).toBeVisible();
    await expect(icon).toBeVisible();
    expect(await scrollingUnderIcon(), path).toEqual([]);
  }
});

test("a long conversation name keeps its search and actions visible without a details column", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const channel = { ...E2E_CHANNEL, name: "a-very-long-conversation-name-".repeat(3) + "end" };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  const header = page.locator(".app-main .app-panel-header").first();
  await expect(header).toBeVisible();
  const search = header.getByRole("button", { name: "Search", exact: true });
  await expect(search).toBeInViewport();
  await expect(header.getByRole("button", { name: "Copy channel link" })).toBeInViewport();
  await expect(header.getByRole("button", { name: "Channel details" })).toBeInViewport();
  await search.click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});

/**
 * Opens search from the visible search control, types a query and waits for
 * the drop-down to settle; returns where the control was and the panel.
 */
async function openSearchFromControl(page: Page) {
  const anchor = page.locator("[data-search-anchor]").filter({ visible: true }).first();
  await expect.poll(() => anchor.boundingBox()).not.toBeNull();
  const control = (await anchor.boundingBox())!;
  await anchor.click();
  const panel = page.getByRole("dialog", { name: "Search workspace" });
  await expect(page.locator("[data-workspace-search-input]")).toBeFocused();
  await page.keyboard.type("deploy");
  await expect(panel.getByText("deploy the hub (1)")).toBeVisible();
  await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
  await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/u);
  return { control, panel };
}

test("the search panel drops from the control that opened it, one glass with nothing glass inside", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  for (const path of [`channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, "pages"]) {
    await page.goto(`/app/${E2E_SPACE.id}/${path}`, { waitUntil: "domcontentloaded" });
    const { control, panel } = await openSearchFromControl(page);
    const field = (await page.locator(".app-search-panel-field").boundingBox())!;
    const close = (await panel.getByRole("button", { name: "Close search" }).boundingBox())!;
    expect(field.y + field.height / 2).toBeCloseTo(control.y + control.height / 2, 0);
    expect(close.x + close.width).toBeGreaterThan(control.x);
    expect(close.x).toBeLessThan(control.x + control.width);
    // The control is under the field row; the panel takes its place.
    await expect(page.locator("[data-search-anchor]").filter({ visible: true })).toHaveCount(0);
    expect(await panel.evaluate((node) => getComputedStyle(node).backdropFilter)).not.toBe("none");
    const nestedGlass = await panel.evaluate((node) => Array.from(node.querySelectorAll("*"))
      .filter((child) => getComputedStyle(child).backdropFilter !== "none").length);
    expect(nestedGlass).toBe(0);
    await panel.getByRole("button", { name: "Close search" }).click();
    await expect(panel).toHaveCount(0);
  }
});

test.describe("on a phone", () => {
  test.use(E2E_MOBILE_CONTEXT);

  test("search is the whole screen, down to its foot, its columns on the top bar's", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await stubMessageSearch(page);
    await page.goto(`/app/${E2E_SPACE.id}/channels`, { waitUntil: "domcontentloaded" });
    const { control, panel } = await openSearchFromControl(page);
    const input = page.locator("[data-workspace-search-input]");
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    const centre = (b: { x: number; width: number }) => b.x + b.width / 2;
    // Edge to edge with the phone's margin, down to the screen's foot.
    expect(box.x).toBeCloseTo(viewport.width - (box.x + box.width), 0);
    expect(box.y + box.height).toBeCloseTo(viewport.height - 8, 0);
    // The close button is where the top bar's search button was.
    const close = (await panel.getByRole("button", { name: "Close search" }).boundingBox())!;
    expect(centre(close)).toBeCloseTo(centre(control), 0);
    // The field's magnifier and text start on the rows' icon and text columns.
    const glyph = (await page.locator(".app-search-panel-field > svg").boundingBox())!;
    const rowIcon = (await page.locator(".app-search-panel-row > svg").first().boundingBox())!;
    const inputBox = (await input.boundingBox())!;
    const rowText = (await page.locator(".app-search-panel-row > span").first().boundingBox())!;
    expect(glyph.x).toBeCloseTo(rowIcon.x, 0);
    expect(inputBox.x).toBeCloseTo(rowText.x, 0);
    expect(centre(glyph) - box.x).toBeCloseTo(box.x + box.width - centre(close), 0);
    expect(await input.evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
  });
});
