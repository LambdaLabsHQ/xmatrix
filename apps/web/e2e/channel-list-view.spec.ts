import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_DESKTOP_CONTEXT,
  E2E_SPACE,
  fixtureJson,
  fixtureRequestBodies,
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

test("pinned conversations sit under their own Pinned heading", async ({ page }) => {
  const pinned = { ...E2E_CHANNEL, id: "channel-pinned", name: "launch-plan" };
  const other = { ...E2E_CHANNEL, id: "channel-other", name: "random" };
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [pinned, other],
    channelViewPreference: { pinnedChannelIds: [pinned.id] },
  });
  const sidebar = page.locator(".app-workspace-panel > .app-sidebar");
  await expect(sidebar.locator(`[data-channel-row-id="${pinned.id}"]`)).toBeVisible();
  const order = await sidebar.locator(".app-list-section-heading, [data-channel-row-id]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.channelRowId ?? node.textContent?.trim()));
  expect(order).toEqual(["Pinned", pinned.id, "Recent", other.id]);
});

test("a conversation waiting on the reader sits under Needs you, above their pins", async ({ page }) => {
  const pinned = { ...E2E_CHANNEL, id: "channel-pinned", name: "launch-plan" };
  const other = { ...E2E_CHANNEL, id: "channel-other", name: "random" };
  // Pinned too: a conversation is listed once, where it waits on the reader.
  const waiting = {
    ...E2E_CHANNEL, id: "channel-waiting", name: "design", messageCount: 5, historyHeadSequence: 5, readSequence: 0,
    attention: {
      channelId: "channel-waiting", unreadAttentionCount: 1, lastMessageId: "waiting-mention", lastMessageSequence: 3,
      primaryTriggerKind: "mention", triggerKinds: ["mention"], updatedAt: pinned.updatedAt,
      lastMessage: { messageId: "waiting-mention", from: { kind: "agent", label: "claude:3" },
        bodyPreview: "which one ships?", sentAt: pinned.updatedAt },
    },
    // Something else was said since; the row still says who waits and on what.
    lastMessage: { messageId: "waiting-later", from: { kind: "user", label: "Alex" }, bodyPreview: "unrelated chatter",
      sentAt: pinned.updatedAt },
  };
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [pinned, other, waiting],
    channelViewPreference: { pinnedChannelIds: [pinned.id, waiting.id] },
  });
  const sidebar = page.locator(".app-workspace-panel > .app-sidebar");
  await expect(sidebar.locator(`[data-channel-row-id="${waiting.id}"]`)).toBeVisible();
  const order = await sidebar.locator(".app-list-section-heading, [data-channel-row-id]").evaluateAll((nodes) =>
    nodes.map((node) => (node as HTMLElement).dataset.channelRowId ?? node.textContent?.trim()));
  expect(order).toEqual(["Needs you1", waiting.id, "Pinned", pinned.id, "Recent", other.id]);
  await expect(sidebar.locator(`[data-channel-row-id="${waiting.id}"] .app-channel-row-preview`))
    .toHaveText("claude:3: which one ships?");
  // Each section's name is a paper label in its own ink, flat on the list.
  const labels = await sidebar.locator(".app-list-section-label").evaluateAll((nodes) => nodes.map((node) => {
    const style = getComputedStyle(node);
    return { tone: (node as HTMLElement).dataset.tone, ink: style.color, shadow: style.boxShadow, backdrop: style.backdropFilter };
  }));
  expect(labels.map((label) => label.tone)).toEqual(["attention", "primary", "plain"]);
  expect(new Set(labels.map((label) => label.ink)).size).toBe(3);
  for (const label of labels) expect([label.shadow, label.backdrop]).toEqual(["none", "none"]);

  // Done says the reader has dealt with it: the Hub clears what waited, and the row leaves Needs you.
  await fixtureJson(page, "channel-done", "**/api/xmatrix/channels/channel-waiting/read", { ok: true, readSequence: 5 });
  const row = sidebar.locator(`[data-channel-row-id="${waiting.id}"]`);
  await row.hover();
  await row.getByRole("button", { name: "Done with #design" }).click();
  await expect.poll(() => fixtureRequestBodies(page, "channel-done")).toEqual([{ sequence: 5, responded: true }]);
  await expect(sidebar.getByText("Needs you", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Done with #design" })).toHaveCount(0);
});

test("unpinning the last conversation removes Pinned and saves an empty list", async ({ page }) => {
  const pinned = { ...E2E_CHANNEL, id: "channel-pinned", name: "launch-plan",
    updatedAt: "2026-07-01T08:00:00.000Z" };
  const other = { ...E2E_CHANNEL, id: "channel-other", name: "random",
    updatedAt: "2026-07-01T12:00:00.000Z" };
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE], channels: [pinned, other],
    channelViewPreference: { pinnedChannelIds: [pinned.id] },
  });
  const sidebar = page.locator(".app-workspace-panel > .app-sidebar");
  await sidebar.getByRole("button", { name: "Unpin #launch-plan", exact: true }).click();
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
  await expect.poll(visibleChannelRowIds(page)).toEqual([other.id, pinned.id]);
  await expect(sidebar.getByRole("button", { name: "Pin #launch-plan", exact: true })).toHaveCount(1);
  await expect.poll(() => page.evaluate(async (spaceId) => {
    const response = await fetch(`/api/xmatrix/spaces/${spaceId}/channel-view-preference`);
    return (await response.json()).pinnedChannelIds;
  }, E2E_SPACE.id)).toEqual([]);
});

test("unpin while a pin is saving keeps the person's last choice", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  const sidebar = page.locator(".app-workspace-panel > .app-sidebar");
  await expect(sidebar.getByRole("button", { name: "Pin #general", exact: true })).toHaveCount(1);
  await page.evaluate(() => {
    const original = window.fetch;
    let release: () => void;
    let releaseUnpin: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const unpinGate = new Promise<void>((resolve) => { releaseUnpin = resolve; });
    const control = { started: false, unpinStarted: false,
      release: () => release(), releaseUnpin: () => releaseUnpin() };
    Object.assign(window, { pinSaveControl: control });
    window.fetch = async (url, init) => {
      if (!control.started && init?.method === "PATCH" && String(url).endsWith("/channel-view-preference")) {
        control.started = true;
        await gate;
      } else if (!control.unpinStarted && init?.method === "PATCH" && String(url).endsWith("/channel-view-preference")) {
        control.unpinStarted = true;
        await unpinGate;
      }
      return original(url, init);
    };
  });
  await sidebar.getByRole("button", { name: "Pin #general", exact: true }).click({ force: true });
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { pinSaveControl: { started: boolean } }).pinSaveControl.started)).toBe(true);
  await sidebar.getByRole("button", { name: "Unpin #general", exact: true }).click();
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
  // The old request returns after the person has already undone it.
  await page.evaluate(() =>
    (window as typeof window & { pinSaveControl: { release: () => void } }).pinSaveControl.release());
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { pinSaveControl: { unpinStarted: boolean } }).pinSaveControl.unpinStarted)).toBe(true);
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
  await page.evaluate(() =>
    (window as typeof window & { pinSaveControl: { releaseUnpin: () => void } }).pinSaveControl.releaseUnpin());
  await expect.poll(() => page.evaluate(async (spaceId) => {
    const response = await fetch(`/api/xmatrix/spaces/${spaceId}/channel-view-preference`);
    const preference = await response.json();
    return { version: preference.version, pins: preference.pinnedChannelIds };
  }, E2E_SPACE.id)).toEqual({ version: 3, pins: [] });
  await expect(sidebar.getByText("Pinned", { exact: true })).toHaveCount(0);
});
