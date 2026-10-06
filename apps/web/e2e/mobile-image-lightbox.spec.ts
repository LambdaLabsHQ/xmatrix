import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";
import { fixtureJson, fixtureRule } from "./in-page-api-fixtures";

const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

test("an image that has not decoded is a skeleton with no picture icon", async ({ page }) => {
  const src = "/e2e-slow-image.png";
  let releaseImage = () => {};
  const imageReady = new Promise<void>((resolve) => {
    releaseImage = resolve;
  });
  await page.route(`**${src}`, async (route) => {
    await imageReady;
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(imageData, "base64"),
    });
  });
  await openGeneralChannelWithHistory(page, {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
  }, [{
    messageId: "slow-image",
    channelId: E2E_CHANNEL.id,
    sequence: 1,
    body: "Pending picture",
    sentAt: E2E_NOW,
    from: E2E_USER_SENDER,
    attachments: [{
      id: "attachment-slow-image",
      kind: "image",
      name: "pending.png",
      mimeType: "image/png",
      size: 68,
      url: src,
    }],
  }]);

  const frame = page.locator(".message-image-attachment");
  const skeleton = frame.locator(".app-media-skeleton");
  await expect(skeleton).toBeVisible();
  await expect(frame.locator("svg")).toHaveCount(0);
  await expect(frame.getByText("Attachment unavailable")).toHaveCount(0);
  const image = frame.locator("img");
  await expect.poll(() => image.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");

  releaseImage();
  await expect.poll(() => image.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await expect(skeleton).toHaveCount(0);
  expect(await image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
});

test("message galleries open the selected image and wrap in both directions", async ({ page }) => {
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "gallery-message", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "Gallery", sentAt: E2E_NOW, from: E2E_USER_SENDER,
    attachments: ["first.png", "second.png"].map((name) => ({
      id: name, kind: "image", name, mimeType: "image/png", size: 68,
      dataUrl: `data:image/png;base64,${imageData}`,
    })),
  }]);
  await page.getByRole("button", { name: "Open second.png" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "second.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Next image" }).click();
  await expect(dialog.getByRole("img", { name: "first.png" })).toBeVisible();
  const viewport = dialog.locator(".app-attachment-lightbox-zoom");
  await viewport.evaluate((target) => {
    const touch = (clientX: number) => new Touch({ identifier: 1, target, clientX, clientY: 300 });
    target.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(250)] }));
    target.dispatchEvent(new TouchEvent("touchmove", { bubbles: true, touches: [touch(100)] }));
    target.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [], changedTouches: [touch(100)] }));
  });
  await expect(dialog.getByRole("img", { name: "second.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Next image" }).click();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("img", { name: "second.png" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("unsent images open and navigate without removing attachments", async ({ page }) => {
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, []);
  await fixtureRule(page, { id: "gallery-upload", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST", responder: { kind: "relayV2UploadIntent" } });
  await fixtureJson(page, "gallery-refs", "**/relay-v2/private-r2/blob-refs", { ok: true }, { method: "POST" });
  await fixtureJson(page, "gallery-bytes", "**/relay-v2/private-r2/uploads/**", { ok: true }, { method: "PUT" });
  await page.locator('input[type="file"]').setInputFiles(["draft-one.png", "draft-two.png"].map((name) => ({
    name, mimeType: "image/png", buffer: Buffer.from(imageData, "base64"),
  })));
  await page.getByRole("button", { name: "Open draft-two.png" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "draft-two.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Next image" }).click();
  await expect(dialog.getByRole("img", { name: "draft-one.png" })).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(dialog.getByRole("img", { name: "draft-two.png" })).toBeVisible();
  await dialog.getByRole("button", { name: "Close attachment" }).click();
  await expect(page.locator(".composer-image-attachment")).toHaveCount(2);
  await page.getByRole("button", { name: "Remove draft-two.png" }).click();
  await expect(page.locator(".app-attachment-lightbox")).toHaveCount(0);
  await page.getByRole("button", { name: "Open draft-one.png" }).click();
  await expect(dialog.getByRole("button", { name: "Next image" })).toHaveCount(0);
});

test("mobile image preview closes when the open image is tapped", async ({ page }) => {
  const attachmentName = "tap-to-close.png";
  const channel = {
    ...E2E_CHANNEL,
    messageCount: 1,
    lastMessageSequence: 1,
    updatedAt: E2E_NOW,
  };
  const history = [{
    messageId: "message-image-lightbox",
    channelId: E2E_CHANNEL.id,
    sequence: 1,
    body: "Image preview fixture",
    sentAt: E2E_NOW,
    from: E2E_USER_SENDER,
    attachments: [{
      id: "attachment-tap-to-close",
      kind: "image",
      name: attachmentName,
      mimeType: "image/png",
      size: 68,
      dataUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      width: 1,
      height: 1,
    }],
  }];

  await openGeneralChannelWithHistory(page, channel, history);
  await page.getByRole("button", { name: `Open ${attachmentName}` }).tap();

  const lightbox = page.locator(".app-attachment-lightbox");
  const previewImage = lightbox.getByRole("img", { name: attachmentName });
  await expect(previewImage).toBeVisible();

  await previewImage.tap();
  await expect(lightbox).toHaveCount(0);
});
