import { expect, test } from "./fixtures";
import { type Page, type TestInfo } from "@playwright/test";
import {
  fixtureChannelCatalog,
  fixtureJson,
  fixtureRequestBodies,
  fixtureRequests,
  fixtureRule,
  installApiFixtures,
} from "./in-page-api-fixtures";

const LEGACY_BIND_RULE = "legacy-attachment-bind";
const SEND_MESSAGE_RULE = "channel-launch-send";
const MOCK_CHANNELS = [
  {
    id: "xmatrix",
    spaceId: "fixture-space",
    name: "x-matrix",
    mode: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:02:00.000Z",
  },
  {
    id: "launch",
    spaceId: "fixture-space",
    name: "移动端的体验,设计,ux 需要彻底重构",
    mode: "open",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:02:00.000Z",
  },
];

async function fixtureMockChannelCatalog(page: Page) {
  await fixtureChannelCatalog(page, "channel-catalog", MOCK_CHANNELS);
}
test.beforeEach(async ({ page }) => {
  await page.route("**/api/relay-v2/**", (route) =>
    route.fulfill({ status: 503, json: { error: "mock realtime disabled" } })
  );
  await page.routeWebSocket("**/ws/humans*", (socket) => {
    // These fixture-driven visual tests do not exercise Hub realtime behavior.
    // Keep the mock-auth app isolated by rejecting runtime sessions locally and
    // accepting and discarding human-relay client frames.
    socket.onMessage(() => undefined);
  });
});

function alphaFromOklch(value: string): number | null {
  const match = value.match(/\/\s*([0-9.]+)\s*\)/);
  return match ? Number(match[1]) : null;
}

function expectAlphaAtLeast(value: string, minimum: number) {
  const alpha = alphaFromOklch(value);
  expect(alpha, `alpha in ${value}`).not.toBeNull();
  expect(alpha!).toBeGreaterThanOrEqual(minimum);
}

function blurRadius(value: string): number | null {
  const match = value.match(/blur\(\s*([0-9.]+)px\s*\)/);
  return match ? Number(match[1]) : null;
}

async function expectLegibleComposer(page: Page, testInfo: TestInfo, screenshotName: string) {
  await installApiFixtures(page);
  await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
  await fixtureMockChannelCatalog(page);

  await page.goto("/app/fixture-space/channels/launch");

  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.locator(".app-ambient")).toBeVisible();
  await expect(page.locator(".app-message-timeline").getByText("Mobile list pass is ready for screenshot review.")).toBeVisible();

  const composerBox = page.locator(".app-composer-box:not(.app-agent-work-card)").first();
  const composerTextarea = page.locator(".composer-textarea").first();
  const composerSend = composerBox.locator(".app-composer-send");

  await expect(composerBox).toBeVisible();
  await expect(composerTextarea).toBeVisible();
  /* One capsule: the send control lives inside the glass field. */
  await expect(composerSend).toBeVisible();

  /* The lens attaches after the first resize observation. */
  await expect
    .poll(() => composerBox.evaluate((element) => getComputedStyle(element).backdropFilter))
    .toMatch(/url\("#xm-lens-/);

  const resting = await composerBox.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      surface: style.getPropertyValue("--app-liquid-surface-bg").trim(),
      backdrop: style.getPropertyValue("--app-liquid-backdrop-filter").trim(),
      renderedBackdrop: style.backdropFilter || style.webkitBackdropFilter,
    };
  });
  /* iOS 26's regular glass is a light grey veil, not a frost: in Apple's
     Messages screenshots the iMessage field reads 252/255 on white, and
     content under the Phone app's search button stays vivid. */
  expectAlphaAtLeast(resting.surface, 0.3);

  /* The rendered chain, at whatever width this projection runs: a small blur,
     then the lens bends the softened backdrop (so what it folds into the rim
     stays crisp), then saturation. Playwright runs Chromium, the engine that
     accepts an SVG url() in backdrop-filter. */
  const restingBlur = blurRadius(resting.renderedBackdrop);
  expect(restingBlur, `blur in ${resting.renderedBackdrop}`).not.toBeNull();
  expect(restingBlur!).toBeGreaterThanOrEqual(1);
  expect(restingBlur!).toBeLessThanOrEqual(4);
  expect(resting.renderedBackdrop).toMatch(/^blur\([^)]+\) url\("#xm-lens-[^"]+"\) saturate\(/);

  const screenshotPath = testInfo.outputPath(`${screenshotName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  testInfo.attachments.push({
    name: screenshotName,
    path: screenshotPath,
    contentType: "image/png",
  });
}

test.describe("mock-auth app fixture", () => {
  test("keeps mobile composer glass legible", async ({ page }, testInfo) => {
    await expectLegibleComposer(page, testInfo, "mobile-composer-glass");
  });

  test("submits verified attachment bindings with append before the first delivery", async ({ page }) => {
    await installApiFixtures(page);
    await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
    await fixtureMockChannelCatalog(page);
    await fixtureRule(page, {
      id: "r2-upload-intents",
      pattern: "**/relay-v2/private-r2/upload-intents",
      method: "POST",
      responder: { kind: "relayV2UploadIntent" },
    });
    await fixtureJson(page, "r2-blob-refs", "**/relay-v2/private-r2/blob-refs", { ok: true }, { method: "POST" });
    await fixtureJson(page, "r2-uploads", "**/relay-v2/private-r2/uploads/**", { ok: true }, { method: "PUT" });
    /* The legacy per-message bind endpoint: a rule of its own so the absence of
       these calls is asserted from the request log rather than a Node counter. */
    await fixtureJson(page, LEGACY_BIND_RULE, "**/channels/launch/messages/*/attachments", {}, { method: "POST" });
    /* The send itself: a rule of its own so the composed payload is recorded
       and can be asserted after the click. */
    await fixtureJson(page, SEND_MESSAGE_RULE, "**/api/xmatrix/channels/launch/messages", {}, { method: "POST" });

    await page.goto("/app/fixture-space/channels/launch");
    await expect(page.locator(".app-message-timeline").getByText("Mobile list pass is ready for screenshot review.")).toBeVisible();

    await page.getByRole("textbox", { name: "Message composer" }).fill("iOS video bug");
    await page.locator('input[type="file"]').setInputFiles({
      name: "mobile-bug.mp4",
      mimeType: "video/mp4",
      buffer: Buffer.from("mobile video fixture"),
    });
    await expect(page.getByText("Ready · 20 B")).toBeVisible();
    await page.getByRole("button", { name: "Send" }).click();

    /* The fixture answers inside the page, so the send never reaches the
       network: read the payload from the fixture's request log rather than
       from page.waitForRequest. */
    await expect
      .poll(async () => (await fixtureRequestBodies(page, SEND_MESSAGE_RULE)).length)
      .toBeGreaterThan(0);
    const [sentPayload] = (await fixtureRequestBodies(page, SEND_MESSAGE_RULE)) as Array<{
      body?: string;
      attachments?: Array<{
        attachmentId?: string;
        mimeType?: string;
        contentHash?: string;
        objectKey?: string;
      }>;
    }>;
    expect(sentPayload.body).toBe("iOS video bug");
    expect(sentPayload.attachments).toEqual([
      expect.objectContaining({
        attachmentId: expect.any(String),
        mimeType: "video/mp4",
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        objectKey: expect.stringMatching(/^objects\/[0-9a-f]{64}$/u),
      }),
    ]);
    await expect(page.getByRole("textbox", { name: "Message composer" })).toHaveValue("");
    expect(await fixtureRequests(page, "r2-uploads")).toEqual([
      expect.stringMatching(
        /\/relay-v2\/private-r2\/uploads\/[^/]+\/scope\/space%3Afixture-space$/u,
      ),
    ]);
    expect(await fixtureRequests(page, LEGACY_BIND_RULE)).toEqual([]);
  });

  test.describe("iOS app", () => {
    test.use({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3 });

    test("composer is a taller capsule concentric with the device corners", async ({ page }, testInfo) => {
      await installApiFixtures(page);
      await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
      await fixtureMockChannelCatalog(page);
      await page.goto("/app/fixture-space/channels/launch");
      await expect(page.locator(".app-message-timeline").getByText("Mobile list pass is ready for screenshot review.")).toBeVisible();
      await page.locator(".xmatrix-app-shell").evaluate((shell) => {
        shell.classList.add("xmatrix-app-native-dock");
      });

      const composerBox = page.locator(".app-composer-box:not(.app-agent-work-card)").first();
      // null = a build that does not report the radius yet; 0 = square corners.
      for (const [displayRadius, margin] of [[null, 27], [62, 34], [55, 27], [0, 12]] as const) {
        await page.evaluate((radius) => {
          if (radius === null) document.documentElement.style.removeProperty("--app-native-display-radius");
          else document.documentElement.style.setProperty("--app-native-display-radius", `${radius}px`);
        }, displayRadius);
        // The capsule animates into place; judge it once its geometry settles.
        await expect.poll(async () => {
          const box = await composerBox.boundingBox();
          return box
            ? Math.max(
                Math.abs(932 - (box.y + box.height) - margin),
                Math.abs(box.height - 56),
                Math.abs(box.x - margin),
                Math.abs(430 - (box.x + box.width) - margin),
              )
            : Infinity;
        }).toBeLessThan(0.5);
        await expect(composerBox).toHaveCSS("border-top-left-radius", "28px");
        if (displayRadius === 62) {
          const path = testInfo.outputPath("ios-composer-concentric.png");
          await page.screenshot({ path, fullPage: false });
          await testInfo.attach("ios-composer-concentric", { path, contentType: "image/png" });
        }
      }
    });
  });

  test.describe("wide viewport", () => {
    test.use({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });

    test("keeps desktop composer glass legible", async ({ page }, testInfo) => {
      await expectLegibleComposer(page, testInfo, "desktop-composer-glass");
    });
  });
});

test.describe("mobile channel list visual states", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("starts the list right under the workspace bar, with no title plaque", async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await installApiFixtures(page);
    await fixtureJson(page, "api-catch-all", "**/api/xmatrix/**", {});
    await fixtureMockChannelCatalog(page);
    await fixtureRule(page, {
      id: "channel-view-preference",
      pattern: "**/api/xmatrix/spaces/*/channel-view-preference**",
      responder: {
        kind: "channelViewPreference",
        // This spec patches without echoing a version back.
        enforceVersion: false,
        preference: {
          spaceId: "fixture-space",
          childViews: {},
          pinnedChannelIds: [],
          version: 1,
        },
      },
    });
    await page.goto("/app/fixture-space/channels");

    const list = page.locator(".app-mobile-channel-list-pane");
    await expect(list).toBeVisible();
    /* The dock names the tab, so the bar names the Space and the + sits
       beside the dock; no "Channels" plank sits between the bar and the rows. */
    await expect(list.getByText("Channels", { exact: true })).toHaveCount(0);
    const bar = page.locator(".app-topbar");
    await expect(page.locator(".app-mobile-create-fab")).toHaveAccessibleName("New conversation");

    const material = list.locator(".app-material-scroll-content");
    const materialTexture = await material.evaluate((element) => ({
      beforeContent: getComputedStyle(element, "::before").content,
      beforeImage: getComputedStyle(element, "::before").backgroundImage,
      afterContent: getComputedStyle(element, "::after").content,
      afterImage: getComputedStyle(element, "::after").backgroundImage,
    }));
    expect(materialTexture).toEqual({
      beforeContent: "none",
      beforeImage: "none",
      afterContent: "none",
      afterImage: "none",
    });

    /* The fixed bar and rows span the screen. The list meets the bar with
       its first section's name, flush below it, never a bare row; the first
       row follows the name, and the rows scroll under the bar. */
    const heading = list.locator(".app-list-section-heading").first();
    const row = list.locator(".app-mobile-chat-row").first();
    const [barBox, headingBox, rowBox] = await Promise.all([bar.boundingBox(), heading.boundingBox(), row.boundingBox()]);
    expect(barBox && headingBox && rowBox).toBeTruthy();
    expect(headingBox!.y).toBeCloseTo(barBox!.y + barBox!.height, 0);
    expect(rowBox!.y).toBeCloseTo(headingBox!.y + headingBox!.height, 0);
    expect(rowBox!.x).toBe(0);
    expect(barBox!.x).toBe(0);
    expect(rowBox!.width).toBe(page.viewportSize()!.width);
    expect(barBox!.width).toBe(page.viewportSize()!.width);

    await expect(page.locator('[data-mobile-channel-row-id="launch"]')).toBeVisible();
    const listScreenshot = testInfo.outputPath("mobile-channels-list.png");
    await page.screenshot({ path: listScreenshot, fullPage: false });
    testInfo.attachments.push({ name: "mobile-channels-list", path: listScreenshot, contentType: "image/png" });
    expect(consoleErrors).toEqual([]);
  });
});
