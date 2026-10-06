import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_SPACE,
  fixtureRule,
  openGeneralChannelWithHistory,
  openWorkspaceWithStubs,
} from "./workspace-fixtures";


test.use(E2E_DESKTOP_CONTEXT);

test("desktop channels sidebar resize handle has no visible line", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const handle = page.getByRole("separator", { name: "Resize sidebar" });
  await expect(handle).toBeVisible();
  await expect(handle.locator("*")).toHaveCount(0);
  await expect(handle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("rail destinations reuse the chat list resize handle", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const handle = page.getByRole("separator", { name: "Resize sidebar" });

  for (const view of ["machines", "automation", "agents", "apps", "team", "settings", "pages"]) {
    await page.goto(`/app/personal-sspaceperso/${view}`);
    await expect(handle).toHaveCount(1);
    await expect(handle).toBeVisible();
    const grip = await handle.boundingBox();
    const column = page.locator(view === "pages" ? ".app-workspace-panel > .app-sidebar" : ".app-tool-list");
    const list = await column.boundingBox();
    expect(grip && list).toBeTruthy();
    expect(Math.abs((grip!.x + grip!.width / 2) - (list!.x + list!.width))).toBeLessThan(12);
  }

  await page.goto("/app/personal-sspaceperso/machines");
  const list = page.locator(".app-tool-list");
  const before = (await list.boundingBox())!.width;
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2 + 64, grip.y + 40);
  await page.mouse.up();
  await expect.poll(async () => (await list.boundingBox())?.width ?? 0).toBeGreaterThan(before + 32);

  await page.getByRole("button", { name: "Channels", exact: true }).click();
  const sidebar = page.locator(".app-workspace-panel > .app-sidebar");
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeGreaterThan(before + 32);
});

test("hovered channel rows stay on the sidebar compositor surface", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const row = page.locator(`[data-channel-row-id="${E2E_CHANNEL.id}"]`);
  await expect(row).toBeVisible();
  await row.hover();

  const hoverChrome = await row.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
      afterContent: getComputedStyle(element, "::after").content,
    };
  });
  expect(hoverChrome.backdrop, JSON.stringify(hoverChrome)).toBe("none");
  expect(hoverChrome.afterContent === "none" || hoverChrome.afterContent === "").toBeTruthy();
});

test("hovered and selected rows take the conversation's paper, a shade off the list", async ({ page }) => {
  const other = { ...E2E_CHANNEL, id: "channel-other", name: "other" };
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, [], [other]);
  const selected = page.locator(`[data-channel-row-id="${E2E_CHANNEL.id}"]`);
  const hovered = page.locator(`[data-channel-row-id="${other.id}"]`);
  await expect(selected).toHaveClass(/app-channel-row-active/);
  const background = (selector: string) =>
    page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);
  const rowTone = (row: typeof selected) => row.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, shadow: style.boxShadow };
  });

  const paper = await background(".app-workspace-panel");
  const list = await background(".app-workspace-panel > .app-sidebar");
  expect(list).not.toBe(paper);
  expect((await rowTone(hovered)).background).toBe("rgba(0, 0, 0, 0)");
  await hovered.hover();
  await expect.poll(() => rowTone(hovered)).toEqual({ background: paper, shadow: "none" });
  expect(await rowTone(selected)).toEqual({ background: paper, shadow: "none" });
});

test("the desktop column is the Channels list itself, with no category header", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const list = page.locator('.app-sidebar .app-sidebar-pane-body');
  await expect(list.locator("[data-channel-row-id]").first()).toBeVisible();
  await expect(page.locator(".app-sidebar").getByText("Channels", { exact: true })).toHaveCount(0);
  await expect(page.locator(".app-sidebar button[aria-expanded]").filter({ hasText: "Channels" })).toHaveCount(0);
});

function visibleChannelRowIds(page: Page) {
  const channelRows = page.locator("[data-channel-row-id]:visible");
  return () => channelRows.evaluateAll((rows) => rows.map((row) => row.getAttribute("data-channel-row-id")));
}

test("the Channel list is flat and ordered by activity", async ({ page }) => {
  const rootOld = { ...E2E_CHANNEL, id: "channel-root-old", name: "root-old", updatedAt: "2026-07-01T08:00:00.000Z" };
  const childNewest = { ...E2E_CHANNEL, id: "channel-child-newest", name: "child-newest",
    updatedAt: "2026-07-01T12:00:00.000Z" };
  const rootMiddle = { ...E2E_CHANNEL, id: "channel-root-middle", name: "root-middle",
    updatedAt: "2026-07-01T10:00:00.000Z" };
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [rootOld, childNewest, rootMiddle] });
  await expect.poll(visibleChannelRowIds(page)).toEqual([childNewest.id, rootMiddle.id, rootOld.id]);
  await expect(page.getByRole("group", { name: "Channel views" })).toHaveCount(0);
});

test("the list adds a newly committed conversation from the Space catalog revision frame", async ({ page }) => {
  const thread = {
    ...E2E_CHANNEL,
    id: "channel-flat-new-thread",
    name: "flat-new-thread",
    updatedAt: "2026-07-01T00:01:00.000Z",
  };
  let publishCatalogChange: (() => void) | undefined;
  await page.routeWebSocket("**/ws/humans*", (socket) => {
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as { type?: string; requestId?: string };
      if (message.type !== "human_connect") return;
      socket.send(JSON.stringify({
        type: "human_connected",
        requestId: message.requestId,
        user: { id: "e2e-user", email: "e2e@xmatrix.test", name: "E2E Tester" },
      }));
      publishCatalogChange = () => socket.send(JSON.stringify({
        type: "space_channel_catalog_changed",
        spaceId: E2E_SPACE.id,
        revision: 2,
      }));
    });
  });
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const pageResponse = (revision: number, channels: typeof E2E_CHANNEL[]) => ({
    protocolVersion: 1,
    catalogRevision: revision,
    rows: channels.map((channel) => ({
      channel,
      ownActivityAt: channel.updatedAt,
      hasChildren: channel.id === E2E_CHANNEL.id && revision > 1,
    })),
    nextCursor: null,
    counts: { active: channels.length, archive: 0, unread: 0, mentions: 0 },
  });
  await fixtureRule(page, {
    id: "flat-catalog-revision",
    pattern: /\/api\/xmatrix\/channels\/page\?.*view=flat/u,
    responder: { kind: "sequence", responses: [
      { json: pageResponse(1, [E2E_CHANNEL]) },
      { json: pageResponse(2, [thread, E2E_CHANNEL]) },
    ] },
  });

  await expect(page.locator(`[data-channel-row-id="${E2E_CHANNEL.id}"]`)).toBeVisible();
  await expect(page.locator(`[data-channel-row-id="${thread.id}"]`)).toHaveCount(0);
  await expect.poll(() => Boolean(publishCatalogChange)).toBe(true);
  publishCatalogChange!();
  await expect(page.locator(`[data-channel-row-id="${thread.id}"]`)).toBeVisible();
});

test("the list loads its next page into the same list", async ({ page }) => {
  const older = { ...E2E_CHANNEL, id: "channel-older", name: "older", updatedAt: "2026-06-01T00:00:00.000Z" };
  const pageResponse = (channels: typeof E2E_CHANNEL[], nextCursor: string | null) => ({
    protocolVersion: 1, catalogRevision: 1,
    rows: channels.map((channel) => ({ channel, ownActivityAt: channel.updatedAt })),
    nextCursor, counts: { active: 2, unread: 0, mentions: 0 },
  });
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureRule(page, {
    id: "flat-first", pattern: /\/api\/xmatrix\/channels\/page\?(?!.*cursor=).*view=flat/u,
    responder: { kind: "static", json: pageResponse([E2E_CHANNEL], "cursor-2") },
  });
  await fixtureRule(page, {
    id: "flat-next", pattern: /\/api\/xmatrix\/channels\/page\?.*cursor=cursor-2/u,
    responder: { kind: "static", json: pageResponse([older], null) },
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(visibleChannelRowIds(page)).toEqual([E2E_CHANNEL.id, older.id]);
});
