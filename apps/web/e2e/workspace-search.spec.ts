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
  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});

test("Enter opens every result at an address that names the search", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  await page.goto(`/app/${E2E_SPACE.id}/channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Search", exact: true }).filter({ visible: true }).click();
  await page.keyboard.type("deploy");
  await expect(page.getByRole("dialog", { name: "Search workspace" }).getByText("deploy the hub (1)")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(/\/search\?q=deploy$/u);
  const results = page.getByRole("region", { name: "Search" });
  await expect(results.getByText("deploy the hub (2)")).toBeVisible();
  // The address alone brings the search back.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL(/\/search\?q=deploy$/u);
  await expect(results.getByText("deploy the hub (2)")).toBeVisible();
  await results.getByText("deploy the hub (2)").click();
  await expect(page).toHaveURL(new RegExp(`/channels/${RELEASE.name}--${RELEASE.id}`, "u"));
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
  const actions = header.getByRole("button", { name: `Actions for #${E2E_CHANNEL.name}` });
  const search = header.getByRole("button", { name: "Search", exact: true });
  await expect(search).toBeVisible();
  await expect(page.locator(".app-global-bar")).toHaveCount(0);
  const [nameBox, actionsBox, searchBox] = await Promise.all([name.boundingBox(), actions.boundingBox(), search.boundingBox()]);
  expect(actionsBox!.x - (nameBox!.x + nameBox!.width)).toBeLessThanOrEqual(8);
  expect(searchBox!.x - (actionsBox!.x + actionsBox!.width)).toBeGreaterThan(100);
  const headerBox = await header.boundingBox();
  const paddingRight = await header.evaluate((node) => parseFloat(getComputedStyle(node).paddingRight));
  expect(searchBox!.x + searchBox!.width).toBeCloseTo(headerBox!.x + headerBox!.width - paddingRight, 0);
  expect(searchBox!.y).toBeCloseTo(actionsBox!.y, 0);
  expect(await search.evaluate((node) => getComputedStyle(node).borderWidth)).toBe("0px");
  await search.hover();
  expect(await search.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
  await actions.click();
  const menu = page.getByRole("menu", { name: `Actions for #${E2E_CHANNEL.name}` });
  await expect(menu.getByRole("menuitem", { name: /Copy.*link/u })).toBeVisible();
  await page.keyboard.press("Escape");
  await search.click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
  await expect(page.locator(".app-search-panel-field").getByText("in #general")).toHaveCount(0);
});

test("a page's controls end before the search capsule", async ({ page }) => {
  await installPageTreeStubs(page, ["Home"]);
  await page.goto(`/app/${encodeURIComponent(E2E_SPACE.id)}/pages`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-sidebar").getByText("Home", { exact: true }).click();
  const controls = page.getByTestId("page-controls");
  await expect(controls.getByRole("button", { name: /Share/u })).toBeVisible();
  const capsule = await page.locator(".app-global-bar").getByRole("button", { name: "Search" }).boundingBox();
  const share = await controls.getByRole("button", { name: /Share/u }).boundingBox();
  expect(share!.x + share!.width).toBeLessThanOrEqual(capsule!.x);
});

test("a long conversation name keeps its search and actions visible without a details column", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 800 });
  const channel = { ...E2E_CHANNEL, name: "a-very-long-conversation-name-".repeat(3) + "end" };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [channel] });
  const header = page.locator(".app-main .app-panel-header").first();
  await expect(header).toBeVisible();
  const search = header.getByRole("button", { name: "Search", exact: true });
  await expect(search).toBeInViewport();
  await expect(header.getByRole("button", { name: `Actions for #${channel.name}` })).toBeInViewport();
  await expect(header.getByRole("button", { name: "Channel details" })).toBeInViewport();
  await search.click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});

test("the search panel drops from the control that opened it, one glass with nothing glass inside", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  for (const path of [`channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, "pages"]) {
    await page.goto(`/app/${E2E_SPACE.id}/${path}`, { waitUntil: "domcontentloaded" });
    const anchor = page.locator("[data-search-anchor]").filter({ visible: true }).first();
    await expect.poll(() => anchor.boundingBox()).not.toBeNull();
    const control = (await anchor.boundingBox())!;
    await anchor.click();
    const panel = page.getByRole("dialog", { name: "Search workspace" });
    await expect(panel).toBeVisible();
    await page.keyboard.type("deploy");
    await expect(panel.getByText("deploy the hub (1)")).toBeVisible();
    // Let the drop-down animation settle before measuring.
    await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).opacity)).toBe("1");
    await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/u);
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

  test("search is the whole screen, down to its foot, with text iOS will not zoom", async ({ page }) => {
    await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
    await stubMessageSearch(page);
    await page.goto(`/app/${E2E_SPACE.id}/channels`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Search workspace" }).filter({ visible: true }).first().click();
    const panel = page.getByRole("dialog", { name: "Search workspace" });
    await expect(panel).toBeVisible();
    await expect(page.locator("[data-workspace-search-input]")).toBeFocused();
    await expect.poll(() => panel.evaluate((node) => getComputedStyle(node).transform)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/u);
    const box = (await panel.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.x).toBeCloseTo(8, 0);
    expect(box.x + box.width).toBeCloseTo(viewport.width - 8, 0);
    expect(box.y + box.height).toBeCloseTo(viewport.height - 8, 0);
    expect(await page.locator("[data-workspace-search-input]").evaluate((node) => getComputedStyle(node).fontSize)).toBe("16px");
  });
});
