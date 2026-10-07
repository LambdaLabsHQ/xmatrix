import { expect, test } from "./fixtures";
import { type Page } from "@playwright/test";
import {
  E2E_CHANNEL,
  E2E_NOW,
  E2E_SPACE,
  E2E_USER_SENDER,
  openWorkspaceWithStubs,
  installWorkspaceStubs,
  fixtureJson,
  fixtureRequestBodies,
  fixtureRequests,
  fixtureRule,
  releaseFixture,
} from "./workspace-fixtures";

const SLOW_HISTORY_RULE = "slow-channel-general-history";

test.use({ viewport: { width: 390, height: 844 } });

async function openMoreChildWorkspace(page: Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/activity");

  // The Next.js dev toolbar occupies the bottom-left corner in test runs.
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
}

async function openGeneralChannelList(page: Page) {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels");
}

function generalChannelRow(page: Page) {
  return page.locator('[data-mobile-channel-row-id="channel-general"]');
}

async function dispatchAndroidBackForTest(page: Page) {
  return page.evaluate(() => (
    window as typeof window & { __dispatchAndroidBackForTest?: () => boolean }
  ).__dispatchAndroidBackForTest?.());
}

async function installAndroidBackBridge(page: Page) {
  await page.addInitScript(() => {
    const listeners = new Set<() => boolean>();
    const disabledUpdateStatus = () => ({
      state: "disabled" as const,
      enabled: false,
      currentVersion: "0.16.160",
      updatedAt: new Date().toISOString(),
    });
    (window as typeof window & { xmatrixDesktop?: unknown }).xmatrixDesktop = {
      client: "android",
      platform: "android",
      getContext: async () => ({
        client: "android",
        platform: "android",
        version: "0.16.160",
        isPackaged: true,
        startUrl: "https://xmatrix.sh/app",
      }),
      setBadge: async () => undefined,
      setTitle: async () => undefined,
      notify: async () => true,
      openExternal: async () => undefined,
      checkCliInstalled: async () => ({ installed: false }),
      openCliInstall: async () => undefined,
      checkForUpdates: async () => disabledUpdateStatus(),
      getUpdateStatus: async () => disabledUpdateStatus(),
      onBackRequested: (listener: () => boolean) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    (window as typeof window & { __dispatchAndroidBackForTest?: () => boolean })
      .__dispatchAndroidBackForTest = () => {
        for (const listener of Array.from(listeners).reverse()) {
          if (listener()) return true;
        }
        return false;
      };
  });
}

async function openGeneralChannel(page: Page) {
  await openGeneralChannelList(page);
  await generalChannelRow(page).tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels\/general--channel-general$/);
}

async function openChannelDetailsFrom(page: Page, triggerName: "More" | "Open channel Summary") {
  const channelUrl = page.url();
  await page.getByRole("button", { name: triggerName }).tap();
  const details = page.getByRole("dialog", { name: "Channel details" });
  await expect(details).toBeVisible();
  return { details, channelUrl };
}

async function expectOverlayClosedOnChannel(page: Page, details: ReturnType<Page["getByRole"]>, channelUrl: string) {
  await expect(details).toHaveCount(0);
  await expect(page).toHaveURL(channelUrl);
}

async function expectHistoryBackToMessages(
  page: Page,
  details: ReturnType<Page["getByRole"]>,
  channelUrl: string,
) {
  await page.evaluate(() => window.history.back());
  await expectOverlayClosedOnChannel(page, details, channelUrl);
  await expect(page.getByRole("button", { name: "Back to channels" })).toBeVisible();
}

async function expectChannelListVisible(page: Page) {
  await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels$/);
}

test("tapping Channels once opens the mobile channel list", async ({ page }) => {
  await openMoreChildWorkspace(page);

  const primaryNav = page.getByRole("navigation", { name: "Primary" });
  // Pages, Channels, Status and More; Agents lives behind More with Machines and Schedules.
  await expect(primaryNav.getByRole("button")).toHaveText(["Pages", "Channels", "Status", "More"]);
  await expect(primaryNav.getByRole("button", { name: "Follow-ups", exact: true })).toHaveCount(0);
  // Direct messages live on the Channels page.
  await expect(primaryNav.getByRole("button", { name: "Direct", exact: true })).toHaveCount(0);
  await expect(primaryNav.getByRole("button", { name: "Machine", exact: true })).toHaveCount(0);

  const channels = page.getByRole("button", { name: "Channels" });
  // Activity lives behind the More tab, so the dock highlights More here.
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );

  await channels.tap();

  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels$/);
  await expect(channels).toHaveAttribute("aria-current", "page");
  const channelList = page.locator(".app-mobile-channel-list-pane");
  await expect(channelList).toBeVisible();
  await expect(channelList.getByText("general", { exact: true }).first()).toBeVisible();
});

test("the Channels list on a phone is conversations only, no direct-message section", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/channels");
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });

  const channelList = page.locator(".app-mobile-channel-list-pane");
  await expect(channelList).toBeVisible();
  await expect(channelList.getByText("Direct messages", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Primary" }).getByRole("button", { name: "Direct" })).toHaveCount(0);
});

test("mobile Channels lists every conversation flat", async ({ page }) => {
  const channels = [
    { ...E2E_CHANNEL, id: "root", name: "root", updatedAt: "2026-07-01T08:00:00.000Z" },
    { ...E2E_CHANNEL, id: "child", name: "child", updatedAt: "2026-07-01T09:00:00.000Z" },
  ];
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });
  await page.goto("/app/personal-sspaceperso/channels");
  await expect(page.getByRole("group", { name: "Channel views" })).toHaveCount(0);
  await expect(page.locator(".app-mobile-chat-row .app-mobile-chat-title")).toHaveText(["child", "root"]);
});

test("returning to the mobile channel list does not create a history loop", async ({ page }) => {
  await openMoreChildWorkspace(page);

  await page.getByRole("button", { name: "Channels" }).tap();
  const channelList = page.locator(".app-mobile-channel-list-pane");
  const channelRow = channelList.getByText("general", { exact: true }).first();
  await channelRow.tap();

  const backToChannels = page.getByRole("button", { name: "Back to channels" });
  await expect(backToChannels).toBeVisible();
  await backToChannels.tap();
  await expect(channelList).toBeVisible();

  await channelRow.tap();
  await expect(backToChannels).toBeVisible();
  await page.goBack();
  await expect(channelList).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/activity$/);
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
});

test("back from a conversation shows the channel list that was already painted", async ({ page }) => {
  await openGeneralChannelList(page);
  await expect(generalChannelRow(page)).toBeVisible();
  // Rebuilding the list on Back painted it empty for a frame while its rows measured.
  await generalChannelRow(page).evaluate((row) => {
    (window as typeof window & { __listRow?: Element }).__listRow = row;
  });

  await generalChannelRow(page).tap();
  const backToChannels = page.getByRole("button", { name: "Back to channels" });
  await expect(backToChannels).toBeVisible();
  await expect(page.locator(".app-mobile-channel-list-pane")).toBeHidden();
  await backToChannels.tap();

  await expectChannelListVisible(page);
  await expect(generalChannelRow(page)).toBeVisible();
  expect(await generalChannelRow(page).evaluate((row) =>
    (window as typeof window & { __listRow?: Element }).__listRow === row)).toBe(true);
});

test("channel details keeps web back navigation above the material sheet", async ({ page }) => {
  await openGeneralChannel(page);
  const { details, channelUrl } = await openChannelDetailsFrom(page, "More");
  const backToChannel = details.getByRole("button", { name: "Back to channel" });
  await expect(backToChannel).toBeVisible();
  const layerOrder = await details.evaluate((dialog) => {
    const header = dialog.querySelector<HTMLElement>(".app-mobile-channel-details-header");
    const sheet = dialog.querySelector<HTMLElement>(".app-mobile-channel-details-sheet");
    if (!header || !sheet) throw new Error("channel details layers are missing");
    return {
      header: Number.parseInt(getComputedStyle(header).zIndex, 10),
      sheet: Number.parseInt(getComputedStyle(sheet).zIndex, 10),
    };
  });
  expect(layerOrder.header).toBeGreaterThan(layerOrder.sheet);

  await backToChannel.tap();
  await expectOverlayClosedOnChannel(page, details, channelUrl);
  await expect(page.getByRole("button", { name: "Back to channels" })).toBeVisible();
});

test("channel details navigation matches the content cards on a phone", async ({ page }, testInfo) => {
  await openGeneralChannel(page);
  const { details } = await openChannelDetailsFrom(page, "More");
  const header = details.locator(".app-mobile-channel-details-header");
  const plank = details.locator(".app-mobile-channel-details-sheet .app-detail-plank").first();
  await expect(header).toHaveAttribute("data-material", "wood-panel");
  await expect(plank).toBeVisible();
  for (const card of [header, plank]) {
    await expect(card).toHaveCSS("border-top-left-radius", "16px");
    await expect(card).toHaveCSS("border-bottom-right-radius", "16px");
  }
  const headerBox = await header.boundingBox();
  const plankBox = await plank.boundingBox();
  expect(headerBox).not.toBeNull();
  expect(plankBox).not.toBeNull();
  expect(headerBox!.x).toBe(16);
  expect(headerBox!.x).toBe(plankBox!.x);
  expect(headerBox!.width).toBe(plankBox!.width);
  expect(plankBox!.y - headerBox!.y - headerBox!.height).toBe(16);
  await expect(header.getByRole("button", { name: "Back to channel" })).toHaveCSS("width", "44px");
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" });
  const shot = testInfo.outputPath("mobile-channel-details-planks.png");
  await page.screenshot({ path: shot, fullPage: false });
  await testInfo.attach("mobile-channel-details-planks", { path: shot, contentType: "image/png" });
  // The overlay already applies the native safe area. The card's margin must
  // add only the paper gutter, rather than reserving the status bar twice.
  await details.evaluate((dialog) => (dialog as HTMLElement).style.setProperty("--app-safe-area-top", "59px"));
  await expect.poll(async () => (await header.boundingBox())?.y).toBe(75);
});

test("Android Back closes channel details before leaving the channel", async ({ page }) => {
  await installAndroidBackBridge(page);
  await openGeneralChannel(page);
  const { details, channelUrl } = await openChannelDetailsFrom(page, "More");
  await expect(details.getByRole("button", { name: "Back to channel" })).toBeVisible();

  expect(await dispatchAndroidBackForTest(page)).toBe(true);
  await expectOverlayClosedOnChannel(page, details, channelUrl);

  expect(await dispatchAndroidBackForTest(page)).toBe(true);
  await expectChannelListVisible(page);
});

test("Android Back dismisses a transient mobile sheet before workspace navigation", async ({ page }) => {
  await installAndroidBackBridge(page);
  const secondSpace = {
    ...E2E_SPACE,
    id: "space-second",
    name: "Second workspace",
  };
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE, secondSpace],
    channels: [E2E_CHANNEL],
  });
  await page.goto("/app/personal-sspaceperso/channels");

  const switcher = page.getByRole("button", { name: "Switch workspace" });
  await switcher.tap();
  const sheet = page.getByRole("dialog").filter({ hasText: "Switch workspace" });
  await expect(sheet).toBeVisible();
  const listUrl = page.url();

  expect(await dispatchAndroidBackForTest(page)).toBe(true);
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(listUrl);

  expect(await dispatchAndroidBackForTest(page)).toBe(false);
  await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
});

test("Android Back keeps the top overlay ahead of a rerendered page handler", async ({ page }) => {
  await installAndroidBackBridge(page);
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/settings");

  await page.getByRole("button", { name: "Search workspace" }).tap();
  const search = page.getByRole("dialog", { name: "Search workspace" });
  await expect(search).toBeVisible();

  // A route update underneath an open global overlay re-renders the workspace
  // navigation handler. Native listener registration order must not let that
  // parent jump ahead of the still-visible overlay.
  await page.evaluate(() => {
    window.history.pushState(null, "", "/app/personal-sspaceperso/more");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/more$/);
  await expect(search).toBeVisible();

  expect(await dispatchAndroidBackForTest(page)).toBe(true);
  await expect(search).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/more$/);
});

test("browser back from channel details returns to messages, not the list", async ({ page }) => {
  await openGeneralChannel(page);
  const { details, channelUrl } = await openChannelDetailsFrom(page, "More");

  await expectHistoryBackToMessages(page, details, channelUrl);

  await page.evaluate(() => window.history.back());
  await expectChannelListVisible(page);

  await generalChannelRow(page).tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels\/general--channel-general$/);
  await expect(page.getByRole("dialog", { name: "Channel details" })).toHaveCount(0);
});

test("browser back from Summary returns to messages, not the list", async ({ page }) => {
  await openWorkspaceWithStubs(page, {
    spaces: [E2E_SPACE],
    channels: [{ ...E2E_CHANNEL, summary: "Sprint notes and remaining review items." }],
  });
  await page.goto("/app/personal-sspaceperso/channels");
  await generalChannelRow(page).tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels\/general--channel-general$/);
  const { details, channelUrl } = await openChannelDetailsFrom(page, "Open channel Summary");
  await expectHistoryBackToMessages(page, details, channelUrl);
});

test("closing channel details pops the overlay history entry", async ({ page }) => {
  await openGeneralChannel(page);
  const { details, channelUrl } = await openChannelDetailsFrom(page, "More");

  await details.getByRole("button", { name: "Back to channel", exact: true }).tap();
  await expectOverlayClosedOnChannel(page, details, channelUrl);

  await page.evaluate(() => window.history.back());
  await expectChannelListVisible(page);
});

test("swiping from a channel row scrolls the list without opening the channel", async ({ page }) => {
  const channels = Array.from({ length: 24 }, (_, index) => ({
    ...E2E_CHANNEL,
    id: `channel-${index}`,
    name: `channel-${index}`,
    updatedAt: new Date(Date.parse(E2E_CHANNEL.updatedAt) + index * 1000).toISOString(),
  }));
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });
  await page.goto("/app/personal-sspaceperso/channels");

  const scrollViewport = page.locator(".app-mobile-channel-list-pane .app-material-scroll-viewport");
  const firstRow = page.locator(".app-mobile-chat-row").first();
  await expect(firstRow).toBeVisible();
  const channelListUrl = page.url();
  const box = await firstRow.boundingBox();
  if (!box) throw new Error("mobile channel row has no bounding box");

  const client = await page.context().newCDPSession(page);
  const x = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  // Pipeline the gesture instead of awaiting each dispatch. CDP preserves send
  // order, but awaiting five round-trips makes the touch last as long as the
  // machine is slow: past MOBILE_CHANNEL_ACTION_LONG_PRESS_MS (420ms) the row
  // opens its action sheet before the first move — which cancels long press —
  // is ever delivered. Under parallel load that is exactly what happened.
  const gesture = [
    client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: startY }],
    }),
    ...[30, 70, 110, 150].map((delta) =>
      client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: startY - delta }],
      })
    ),
    client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }),
  ];
  await Promise.all(gesture);

  await expect.poll(() => scrollViewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(page).toHaveURL(channelListUrl);
  await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
  await expect(page.locator(".app-mobile-channel-actions-layer")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
});

/* The tab dock floats over the list, so rows pass under it while you scroll —
   that is the point of a translucent bar. It only bites at the very end, where
   the last row stops inside the dock's footprint and there is no scroll left to
   move it clear. The fix is trailing scroll room on the sheet, not a reserved
   band on the pane: a list that already fits the screen must be untouched. */
test("the end of the channel list can be scrolled clear of the tab dock", async ({ page }) => {
  const channels = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      ...E2E_CHANNEL,
      id: `channel-${index}`,
      name: `channel-${index}`,
    }));

  const measure = () =>
    page.evaluate(() => {
      const pane = document.querySelector(".app-mobile-channel-list-pane")!;
      const viewport = pane.querySelector(".app-material-scroll-viewport") as HTMLElement;
      const dockTop = document.querySelector(".app-mobile-tab-dock")!.getBoundingClientRect().top;
      const overflowAtRest = viewport.scrollHeight - viewport.clientHeight;
      viewport.scrollTop = viewport.scrollHeight;
      const rows = [...pane.querySelectorAll(".app-mobile-chat-row")];
      const titles = [...pane.querySelectorAll(".app-mobile-chat-title")];
      const last = rows[rows.length - 1].getBoundingClientRect();
      const hit = document.elementFromPoint(last.left + last.width / 2, last.top + last.height / 2);
      return {
        overflowAtRest,
        dockTop,
        lastRowBottom: last.bottom,
        lastTitle: titles.at(-1)?.textContent?.trim() ?? "",
        tapLandsOnRow: Boolean(hit?.closest(".app-mobile-chat-row")),
      };
    });

  const many = channels(30);
  // Same activity, so the fixture's catalog order is the channel id. The phone
  // list virtualizes: only the rows near the viewport are mounted, so the DOM
  // count is not 30. Scroll until the last conversation is mounted, then
  // measure that row against the dock.
  const lastName = many.map((channel) => channel.name).sort((left, right) => left.localeCompare(right)).at(-1);
  if (!lastName) throw new Error("channel list fixture produced no name");
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: many });
  await page.goto("/app/personal-sspaceperso/channels");
  const viewport = page.locator(".app-mobile-channel-list-pane .app-material-scroll-viewport");
  await expect(viewport.locator(".app-mobile-chat-row").first()).toBeVisible();
  await expect.poll(async () => {
    await viewport.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    return (await viewport.locator(".app-mobile-chat-title").last().textContent())?.trim() ?? "";
  }).toBe(lastName);

  const long = await measure();
  expect(long.lastTitle).toBe(lastName);
  expect(long.lastRowBottom).toBeLessThanOrEqual(long.dockTop);
  expect(long.tapLandsOnRow).toBe(true);

  // A list that fits the screen must gain no scroll at all: the room belongs
  // to the sheet, and min-h-full absorbs it until there is something to scroll.
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: channels(3) });
  await page.goto("/app/personal-sspaceperso/channels");
  await expect(page.locator(".app-mobile-chat-row")).toHaveCount(3);
  expect((await measure()).overflowAtRest).toBe(0);
});

test("long pressing a mobile channel opens its actions side by side under the row without selecting text", async ({ page }, testInfo) => {
  const channels = [
    {
      ...E2E_CHANNEL,
      id: "root-actions",
      name: "root-actions",
      updatedAt: "2026-07-01T04:00:00.000Z",
    },
    {
      ...E2E_CHANNEL,
      id: "nested-actions",
      name: "nested-actions",
      updatedAt: "2026-07-01T03:00:00.000Z",
    },
  ];
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels });
  await page.goto("/app/personal-sspaceperso/channels");
  const row = page.locator('[data-mobile-channel-row-id="root-actions"]');
  await expect(row).toBeVisible();
  expect(await row.evaluate((element) => getComputedStyle(element).userSelect)).toBe("none");
  expect(await row.locator(".app-mobile-chat-title").evaluate((element) => ({
    userSelect: getComputedStyle(element).userSelect,
    webkitUserSelect: getComputedStyle(element).webkitUserSelect,
  }))).toEqual({
    userSelect: "none",
    webkitUserSelect: "none",
  });
  expect(await row.locator(".app-mobile-chat-title").evaluate((element) => {
    const selectStart = new Event("selectstart", { bubbles: true, cancelable: true });
    element.dispatchEvent(selectStart);
    return selectStart.defaultPrevented;
  })).toBe(true);

  const longPress = async () => {
    const box = await row.boundingBox();
    if (!box) throw new Error("mobile channel row has no bounding box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(page.getByRole("toolbar", { name: "Channel actions for root-actions" })).toBeVisible();
    // Held, the row takes the paper a desktop row takes on hover.
    await expect(row).toHaveClass(/app-mobile-chat-row-active/);
    await row.locator(".app-mobile-chat-title").evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(await page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
    await page.mouse.up();
  };

  await longPress();
  const actions = page.getByRole("toolbar", { name: "Channel actions for root-actions" });
  await expect(row).toHaveClass(/app-mobile-chat-row-active/);
  await expect(actions.getByRole("button", { name: /Create sub-channel/ })).toHaveCount(0);
  const pin = actions.getByRole("button", { name: "Pin channel", exact: true });
  const copy = actions.getByRole("button", { name: "Copy channel link", exact: true });
  await expect(pin).toBeVisible();
  await expect(copy).toBeVisible();
  expect(await page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  // The options sit side by side, directly under the pressed row, in the list:
  // no sheet, no backdrop, and the next row moves down to make room.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const rowBox = await row.boundingBox();
  const actionsBox = await actions.boundingBox();
  const pinBox = await pin.boundingBox();
  const copyBox = await copy.boundingBox();
  const nextRowBox = await page.locator('[data-mobile-channel-row-id="nested-actions"]').boundingBox();
  if (!rowBox || !actionsBox || !pinBox || !copyBox || !nextRowBox) throw new Error("channel actions are not laid out");
  expect(actionsBox.y).toBeGreaterThanOrEqual(rowBox.y + rowBox.height - 1);
  expect(actionsBox.y).toBeLessThan(rowBox.y + rowBox.height + 16);
  expect(Math.abs(pinBox.y - copyBox.y)).toBeLessThan(1);
  expect(copyBox.x).toBeGreaterThan(pinBox.x + pinBox.width - 1);
  expect(nextRowBox.y).toBeGreaterThanOrEqual(actionsBox.y + actionsBox.height);
  await page.locator("nextjs-portal").evaluateAll((elements) => elements.forEach((element) => element.remove()));
  const actionsScreenshot = testInfo.outputPath("mobile-channel-long-press-actions.png");
  await page.screenshot({ path: actionsScreenshot, fullPage: false });
  testInfo.attachments.push({
    name: "mobile-channel-long-press-actions",
    path: actionsScreenshot,
    contentType: "image/png",
  });
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels$/);

  await longPress();
  await pin.click();
  await expect(actions).toHaveCount(0);
  await longPress();
  await expect(actions.getByRole("button", { name: "Unpin channel", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toHaveCount(0);
});

test("opening a mobile channel uses a compact app bar, directional transition, and stable loading skeleton", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    const original = document.startViewTransition?.bind(document);
    (window as typeof window & { __mobileTransitionDirections?: string[] }).__mobileTransitionDirections = [];
    if (!original) return;
    document.startViewTransition = ((callback: () => void) => {
      (window as typeof window & { __mobileTransitionDirections?: string[] }).__mobileTransitionDirections?.push(
        document.documentElement.dataset.xmatrixMobileNavigation || "missing"
      );
      return original(callback);
    }) as typeof document.startViewTransition;
  });

  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  /* Held open on purpose: the skeleton only exists while history is still in
     flight. `releaseFixture` below lets it land. */
  await fixtureRule(page, {
    id: SLOW_HISTORY_RULE,
    pattern: "**/api/xmatrix/channels/channel-general/history**",
    responder: {
      kind: "deferred",
      json: {
        messages: [{
          messageId: "general-message-1",
          channelId: E2E_CHANNEL.id,
          sequence: 1,
          from: E2E_USER_SENDER,
          body: "History arrived without shifting the channel shell.",
          sentAt: E2E_NOW,
        }],
        hasMore: false,
      },
    },
  });
  await page.goto("/app/personal-sspaceperso/channels");

  await page.locator('[data-mobile-channel-row-id="channel-general"]').tap();
  await expect
    .poll(async () => (await fixtureRequests(page, SLOW_HISTORY_RULE)).length)
    .toBeGreaterThan(0);
  await expect(page.locator(".app-message-timeline-skeleton")).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading messages" })).toBeVisible();
  const detailBar = page.locator(".app-mobile-channel-detail-bar");
  await expect(detailBar).toBeVisible();
  await expect(detailBar.getByText("general", { exact: true })).toBeVisible();
  // The title alone names the conversation; the Space stays on the list.
  await expect(detailBar.getByText("Personal", { exact: true })).toHaveCount(0);
  await expect(detailBar.locator('[aria-label="Channel breadcrumb"]')).toHaveCount(0);
  const detailBarMetrics = await detailBar.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      left: rect.left,
      radius: style.borderRadius,
      borderBottomWidth: style.borderBottomWidth,
    };
  });
  expect(detailBarMetrics.width).toBe(390);
  expect(detailBarMetrics.height).toBe(60);
  expect(detailBarMetrics.left).toBe(0);
  expect(detailBarMetrics.radius).toBe("0px");
  // The bar is a board, not a card: no hairline, the wood's own edge.
  expect(detailBarMetrics.borderBottomWidth).toBe("0px");
  for (const actionName of ["Back to channels", "Share", "More"]) {
    const box = await detailBar.getByRole("button", { name: actionName }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(40);
    expect(box?.height).toBeGreaterThanOrEqual(40);
  }
  await expect(detailBar.getByRole("button", { name: /Archive #/ })).toHaveCount(0);
  await expect(detailBar.getByRole("button", { name: "Search workspace" })).toHaveCount(0);
  expect(await page.evaluate(() => typeof document.startViewTransition)).toBe("function");
  expect(await page.evaluate(() => (
    (window as typeof window & { __mobileTransitionDirections?: string[] }).__mobileTransitionDirections
  ))).toContain("forward");
  await page.waitForTimeout(350);
  const loadingScreenshot = testInfo.outputPath("mobile-channel-detail-loading.png");
  await page.screenshot({ path: loadingScreenshot, fullPage: false });
  testInfo.attachments.push({
    name: "mobile-channel-detail-loading",
    path: loadingScreenshot,
    contentType: "image/png",
  });

  await releaseFixture(page, SLOW_HISTORY_RULE);
  await expect(page.locator(".app-message-timeline").getByText("History arrived without shifting the channel shell.")).toBeVisible();
  await expect(page.locator(".app-message-timeline-skeleton")).toHaveCount(0);

  await page.getByRole("button", { name: "Back to channels" }).tap();
  await expect(page.locator(".app-mobile-channel-list-pane")).toBeVisible();
  expect(await page.evaluate(() => (
    (window as typeof window & { __mobileTransitionDirections?: string[] }).__mobileTransitionDirections
  ))).toContain("back");
});

test("More tab hosts overflow views and returns from Settings without a history loop", async ({ page }) => {
  await openMoreChildWorkspace(page);

  const moreTab = page.getByRole("button", { name: "More", exact: true });
  await moreTab.tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/more$/);
  await expect(moreTab).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: /^Settings/ }).tap();

  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/settings$/);
  await expect(moreTab).toHaveAttribute("aria-current", "page");

  await page.getByRole("button", { name: "Back to More" }).tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/more$/);
  await expect(moreTab).toHaveAttribute("aria-current", "page");

  await page.goBack();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/activity$/);
});

test("Agents lists registrations by runtime and opens one over the list on a phone", async ({ page }) => {
  const mine = {
    key: { spaceId: E2E_SPACE.id, ownerUserId: "e2e-user", machineId: "machine-mobile", harness: "codex" },
    displayName: "mobile-actions-agent",
    ownerName: "E2E Tester",
    machineName: "Mobile test machine",
    version: 1,
    state: "enabled",
    models: [],
    routingReady: true,
    canManageOwnerGrant: true,
    canConfigureSpace: true,
    canRemoveFromSpace: true,
    live: {
      machine: { online: true, platform: "linux" },
      running: [{ instanceId: "instance-general", channelId: E2E_CHANNEL.id, channelInstanceId: "2", since: E2E_NOW }],
      quota: { remainingPercent: 14, observedAt: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(), windows: [
          { label: "1w", usedPercent: 86, resetAt: new Date(Date.now() + 3 * 86_400_000).toISOString() },
          { label: "5h", usedPercent: 40, resetAt: new Date(Date.now() + 2.5 * 3_600_000).toISOString() },
        ] },
    },
  };
  const research = {
    ...mine,
    key: { ...mine.key, ownerUserId: "research-owner", machineId: "machine-research" },
    displayName: "research-agent",
    ownerName: "Research Owner",
    machineName: "Research Mac",
    canManageOwnerGrant: false,
    live: { machine: { online: false, lastSeenAt: "2026-01-01T00:00:00Z", platform: "macos" }, running: [] },
  };
  const catalog = (registrations: Array<Omit<typeof mine, "live"> & { live?: unknown }>) => ({
    registrations,
    capabilities: [...new Set(registrations.map((item) => item.key.harness))].sort().map((harness) => ({
      harness,
      models: [],
      locations: registrations.filter((item) => item.key.harness === harness),
    })),
  });
  await installWorkspaceStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await fixtureJson(page, "my-agents-catalog", /\/api\/xmatrix\/spaces\/space-personal\/agent-registrations(?:\?quota=refresh)?$/,
    catalog([mine, research]));
  /* The Agents screen's retired `/roles` address, still opened by published
     native builds and bookmarks, lands on its canonical `/agents` address. */
  await page.goto("/app/personal-sspaceperso/roles");
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/agents$/);

  const row = (name: string) => page.locator('[data-testid="agent-row"]').filter({ hasText: name });
  const detail = page.locator(".app-tool-detail");
  const back = () => detail.getByRole("button", { name: "Agents" }).tap();
  /* A row says what its location is doing; the owner is named only when it is someone else. */
  await expect(row("mobile-actions-agent")).toBeVisible();
  /* The runtime is the group the locations belong to, so its icon and name
     match the location row instead of reading as a caption above it. */
  const agentHeading = page.getByRole("region", { name: "codex" }).locator(".app-tool-list-group-title");
  const agentFace = agentHeading.locator(".identity-avatar-face");
  const machineTitle = row("mobile-actions-agent").locator(".font-semibold").first();
  await expect(agentFace.locator("img")).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("agents-list-phone.png") });
  const [agentSize, machineSize, faceWidth] = await Promise.all([
    agentHeading.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    machineTitle.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    agentFace.evaluate((element) => parseFloat(getComputedStyle(element).width)),
  ]);
  expect(agentSize).toBeGreaterThanOrEqual(machineSize);
  expect(faceWidth).toBeGreaterThanOrEqual(32);
  /* A location is indented under its runtime: its mark starts where the
     runtime's name does, so the group reads as a parent and its children. */
  const agentName = agentHeading.locator("span.truncate").first();
  const machineIcon = row("mobile-actions-agent").locator(".app-tool-state-icon");
  const [nameBox, iconBox] = await Promise.all([agentName, machineIcon].map((locator) => locator.boundingBox()));
  expect(Math.abs(iconBox!.x - nameBox!.x)).toBeLessThanOrEqual(1);
  await expect(row("mobile-actions-agent")).toContainText("Mobile test machine · Running in #general");
  await expect(row("mobile-actions-agent")).not.toContainText("E2E Tester");
  await expect(row("research-agent")).toContainText(/Research Mac · Offline · seen \d+d ago/);
  await expect(row("research-agent")).toContainText("Research Owner");
  await expect(row("research-agent")).toHaveAttribute("data-state", "offline");
  await expect(page.locator(".app-topbar")).toContainText(E2E_SPACE.name);
  await expect(page.locator(".app-mobile-create-fab")).toHaveAccessibleName("Manage machines");

  /* Roles are retired: the list holds only the Space's agents. */
  await expect(page.getByRole("region", { name: "Roles" })).toHaveCount(0);
  await expect(row("Discover")).toHaveCount(0);
  await expect(row("Role Studio")).toHaveCount(0);

  /* A Space admin configures and disables another member's agent in the Space; only its owner disables it everywhere. */
  await row("research-agent").tap();
  await expect(detail.getByRole("button", { name: /^Configure/ })).toBeVisible();
  await expect(detail.getByRole("switch", { name: "Enabled: research-agent" })).toHaveAttribute("aria-checked", "true");
  await back();

  const grant = { state: "active", revision: 4, executionRevision: 4,
    limits: { workspaces: [], models: [], capabilities: [] } };
  await fixtureJson(page, "my-agents-query", /\/api\/xmatrix\/spaces\/space-personal\/agent-registrations\/query$/, {
    key: mine.key, displayName: mine.displayName, version: 1, canManageOwnerGrant: true, canConfigureSpace: true,
    canRemoveFromSpace: true, configuration: { workspaceReferences: [] },
    access: { grant, policy: { ...grant, state: "enabled" } },
  }, { method: "POST" });
  await fixtureRule(page, {
    id: "my-agents-command",
    pattern: /\/api\/xmatrix\/spaces\/space-personal\/agent-registrations\/commands$/,
    method: "POST",
    responder: { kind: "sequence", responses: [
      { status: 409, json: { code: "authorization_revision_conflict", error: "The agent changed since it was loaded" } },
      { json: { revision: 5, reused: false } },
    ] },
  });

  await row("mobile-actions-agent").tap();
  /* Its provider windows, soonest reset first, each with its countdown. */
  const usage = detail.getByRole("region", { name: "Usage" });
  await expect(usage.getByRole("meter")).toHaveCount(2);
  await expect(usage.getByRole("meter").first()).toHaveAccessibleName("5-hour window");
  await expect(usage.getByRole("meter").first()).toHaveAttribute("aria-valuenow", "40");
  await expect(usage).toContainText(/5-hour window\s*resets in 2h \d+m\s*40% used/);
  await expect(usage).toContainText(/Weekly\s*resets in [23]d \d+h\s*86% used/);
  await expect(usage).toContainText("checked just now");
  const running = detail.getByRole("region", { name: "Running now · 1" });
  await expect(running).toContainText("mobile-actions-agent:2");
  await running.getByRole("button", { name: "#general" }).tap();
  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/channels\/general--channel-general$/);
  await page.goBack();
  /* One switch turns it off in this Space at once, with no confirmation. */
  const enabled = detail.getByRole("switch", { name: "Enabled: mobile-actions-agent" });
  await expect(enabled).toHaveAttribute("aria-checked", "true");
  await enabled.tap();
  await expect(page.getByText("The agent changed since it was loaded")).toBeVisible();

  await fixtureJson(page, "my-agents-catalog-after-disable",
    /\/api\/xmatrix\/spaces\/space-personal\/agent-registrations(?:\?quota=refresh)?$/,
    catalog([{ ...mine, state: "disabled", routingReady: false }, research]));
  await enabled.tap();
  await expect(enabled).toHaveAttribute("aria-checked", "false");
  await expect(detail).toContainText("Disabled");
  await expect.poll(async () => (await fixtureRequestBodies(page, "my-agents-command")).at(-1)).toMatchObject({
    key: mine.key, action: "space-state", state: "disabled", expectedRevision: 4,
  });

});

test("Team starts with management actions instead of count-only summary cards", async ({ page }) => {
  const otherSpace = {
    ...E2E_SPACE,
    id: "space-team",
    name: "Lambda Labs",
  };
  await openWorkspaceWithStubs(page, { spaces: [otherSpace], channels: [] });
  await page.goto("/app/space-team/team");

  /* `.app-page-title` is display:none under md, so this page's only mobile
     title is the topbar label; the in-pane heading names the Space itself. */
  await expect(page.locator(".app-topbar")).toContainText("Team");
  // A phone lists Team's sections first; the Space's own opens over the list.
  await page.locator('[data-testid="tool-section-row"]').filter({ hasText: "Lambda Labs" }).tap();
  await expect(page.getByRole("heading", { name: "Lambda Labs", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create team" })).toHaveCount(0);
  await expect(page.locator(".app-metric-card")).toHaveCount(0);
  await expect(page.getByText("Managed by you", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Current workspace", { exact: true })).toHaveCount(0);
});

test("retired Analytics routes return to the More task hub", async ({ page }) => {
  await openWorkspaceWithStubs(page, { spaces: [E2E_SPACE], channels: [E2E_CHANNEL] });
  await page.goto("/app/personal-sspaceperso/analytics");

  await expect(page).toHaveURL(/\/app\/personal-sspaceperso\/more$/);
  await expect(page.getByRole("button", { name: "More", exact: true })).toHaveAttribute(
    "aria-current",
    "page"
  );
});
