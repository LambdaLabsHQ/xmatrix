import { expect, test, type Page } from "./fixtures";
import { fixtureJson, fixtureRequests } from "./in-page-api-fixtures";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
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
  const field = page.locator(".app-topbar-search-input");
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
  await page.locator(".app-global-bar").getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Search workspace" })).toBeVisible();
});

test("Enter opens every result at an address that names the search", async ({ page }) => {
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL, RELEASE] });
  await stubMessageSearch(page);
  await page.goto(`/app/${E2E_SPACE.id}/channels/${E2E_CHANNEL.name}--${E2E_CHANNEL.id}`, { waitUntil: "domcontentloaded" });
  await page.locator(".app-global-bar").getByRole("button", { name: "Search" }).click();
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

  await page.locator(".app-global-bar").getByRole("button", { name: "Search" }).click();
  await page.keyboard.type(target.name);
  const dialog = page.getByRole("dialog", { name: "Search workspace" });
  await dialog.getByRole("button", { name: new RegExp(`#${target.name}`, "u") }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/channels/${target.name}--${target.id}$`, "u"));
  await expect(row).toHaveClass(/app-channel-row-active/u);
  await expect(row).toBeInViewport();
});

test("the search capsule sits edge for edge over the details planks", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const capsule = page.locator(".app-global-bar").getByRole("button", { name: "Search" });
  const plank = page.locator(".app-details .app-detail-plank").first();
  await expect(plank).toBeVisible();
  const [capsuleBox, plankBox] = await Promise.all([capsule.boundingBox(), plank.boundingBox()]);
  expect(capsuleBox!.x).toBeCloseTo(plankBox!.x, 0);
  expect(capsuleBox!.x + capsuleBox!.width).toBeCloseTo(plankBox!.x + plankBox!.width, 0);
  expect(capsuleBox!.y + capsuleBox!.height).toBeLessThanOrEqual(plankBox!.y);
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
