import { expect, test, type Page } from "./fixtures";
import type { Locator } from "@playwright/test";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

/* The image viewer is driven with real input: CDP touches become the same
   pointer events a phone sends, and Playwright's mouse sends real wheel and
   drag events, so these cases exercise the gesture code the way people do. */

/** A 600x400 picture, big enough that zoom and pan have somewhere to go. */
async function pictureDataUrl(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 400;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("no 2d canvas");
    const gradient = context.createLinearGradient(0, 0, 600, 400);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#f59e0b");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 600, 400);
    return canvas.toDataURL("image/png");
  });
}

async function openGallery(page: Page, names: string[]) {
  const dataUrl = await pictureDataUrl(page);
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "viewer-message", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "Pictures", sentAt: E2E_NOW, from: E2E_USER_SENDER,
    attachments: names.map((name) => ({ id: name, kind: "image", name, mimeType: "image/png", size: 4096, dataUrl })),
  }]);
}

/** The open image's transform as scale and translation. */
function viewOf(image: Locator) {
  return image.evaluate((element) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(element).transform);
    return { scale: Math.round(matrix.a * 100) / 100, x: Math.round(matrix.e), y: Math.round(matrix.f) };
  });
}

function trackOffset(page: Page) {
  return page.locator(".app-image-viewer-track").evaluate((element) => Math.round(new DOMMatrixReadOnly(getComputedStyle(element).transform).e));
}

/** Tap one picture open and wait until it has settled from its thumbnail into the fitted view. */
async function openFitted(page: Page, name: string) {
  await openGallery(page, [name]);
  await page.getByRole("button", { name: `Open ${name}` }).tap();
  const image = page.getByRole("dialog").getByRole("img", { name });
  await expect(image).toBeVisible();
  await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });
  return image;
}

async function touchInput(page: Page) {
  const client = await page.context().newCDPSession(page);
  return (type: "touchStart" | "touchMove" | "touchEnd", points: Array<{ x: number; y: number }> = []) =>
    client.send("Input.dispatchTouchEvent", { type, touchPoints: points.map((point, id) => ({ ...point, id })) });
}

test("a pinch zooms the open image, a drag then pans it, and a double tap fits it again", async ({ page }) => {
  const image = await openFitted(page, "wide.png");

  const touch = await touchInput(page);
  await touch("touchStart", [{ x: 166, y: 426 }, { x: 226, y: 426 }]);
  await touch("touchMove", [{ x: 126, y: 426 }, { x: 266, y: 426 }]);
  await touch("touchMove", [{ x: 76, y: 426 }, { x: 316, y: 426 }]);
  await touch("touchEnd");
  await expect.poll(async () => (await viewOf(image)).scale).toBeGreaterThan(3);

  const zoomed = await viewOf(image);
  await touch("touchStart", [{ x: 150, y: 426 }]);
  await touch("touchMove", [{ x: 200, y: 426 }]);
  await touch("touchMove", [{ x: 250, y: 426 }]);
  await touch("touchEnd");
  await expect.poll(async () => (await viewOf(image)).x).toBeGreaterThan(zoomed.x + 50);
  expect((await viewOf(image)).scale).toBe(zoomed.scale);

  await page.touchscreen.tap(196, 426);
  await page.touchscreen.tap(196, 426);
  await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("a swipe carries the next image in under the finger and lands on it", async ({ page }) => {
  await openGallery(page, ["first.png", "second.png", "third.png"]);
  await page.getByRole("button", { name: "Open first.png" }).tap();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("img", { name: "first.png" })).toBeVisible();
  await expect(dialog.getByText("1 / 3")).toBeVisible();

  const touch = await touchInput(page);
  await touch("touchStart", [{ x: 300, y: 426 }]);
  await touch("touchMove", [{ x: 250, y: 428 }]);
  await touch("touchMove", [{ x: 200, y: 430 }]);
  // Mid-drag the gallery follows the finger 1:1, and the next picture is already in view beside it.
  await expect.poll(() => trackOffset(page)).toBe(-100);
  const next = await dialog.locator(".app-image-viewer-slide").last().boundingBox();
  expect(next?.x).toBeLessThan(393);

  await touch("touchMove", [{ x: 60, y: 430 }]);
  await touch("touchEnd");
  await expect(dialog.getByRole("img", { name: "second.png" })).toBeVisible();
  await expect(dialog.getByText("2 / 3")).toBeVisible();
  await expect.poll(() => trackOffset(page)).toBe(0);
});

test("dragging the picture down fades the viewer and puts it away", async ({ page }) => {
  const image = await openFitted(page, "drop.png");

  const touch = await touchInput(page);
  await touch("touchStart", [{ x: 196, y: 400 }]);
  await touch("touchMove", [{ x: 198, y: 460 }]);
  await touch("touchMove", [{ x: 200, y: 700 }]);
  await expect.poll(async () => (await viewOf(image)).y).toBe(300);
  const dim = await page.locator(".app-attachment-lightbox-backdrop").evaluate((element) => Number(getComputedStyle(element).opacity));
  expect(dim).toBeLessThan(0.5);
  await touch("touchEnd");
  await expect(page.locator(".app-attachment-lightbox")).toHaveCount(0);
});

test("a tap beside the picture closes the viewer and does not reach the page behind it", async ({ page }) => {
  await openGallery(page, ["beside.png"]);
  // The message's text lies under the dim area around the picture: a tap on it would open the message's actions.
  const text = await page.getByText("Pictures", { exact: true }).boundingBox();
  if (!text) throw new Error("message text has no box");
  await page.getByRole("button", { name: "Open beside.png" }).tap();
  const image = page.getByRole("dialog").getByRole("img", { name: "beside.png" });
  await expect(image).toBeVisible();
  await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });
  await page.touchscreen.tap(text.x + text.width / 2, text.y + text.height / 2);
  await expect(page.locator(".app-attachment-lightbox")).toHaveCount(0);
  await expect(page.locator("[data-actions-open]")).toHaveCount(0);
});

test.describe("with a mouse", () => {
  test.use(E2E_DESKTOP_CONTEXT);

  test("the wheel zooms, a click zooms in and a drag pans, the readout and keys reset it", async ({ page }) => {
    await openGallery(page, ["desk.png"]);
    await page.getByRole("button", { name: "Open desk.png" }).click();
    const dialog = page.getByRole("dialog");
    const image = dialog.getByRole("img", { name: "desk.png" });
    await expect(image).toBeVisible();
    await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });
    await expect(dialog.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    const box = await image.boundingBox();
    if (!box) throw new Error("open image has no box");
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2);
    for (let notch = 0; notch < 5; notch += 1) await page.mouse.wheel(0, -100);
    await expect.poll(async () => (await viewOf(image)).scale).toBeGreaterThan(3);
    // Zoomed toward its right side, the picture has moved left once it is wider than the screen
    // (narrower than the screen it stays centred).
    await expect.poll(async () => (await viewOf(image)).x).toBeLessThan(-50);
    await expect(dialog.getByRole("button", { name: "Zoom out" })).toBeEnabled();

    await page.keyboard.press("0");
    await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });

    await image.click({ position: { x: box.width / 2, y: box.height / 2 } });
    await expect.poll(async () => (await viewOf(image)).scale).toBe(2);
    // At 2x the picture still fits across the screen; one more step makes it wide enough to pan.
    await page.keyboard.press("+");
    await expect.poll(async () => (await viewOf(image)).scale).toBe(3.2);
    const zoomed = await viewOf(image);
    await page.mouse.move(640, 450);
    await page.mouse.down();
    await page.mouse.move(560, 450, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await viewOf(image)).x).toBeLessThan(zoomed.x - 40);

    await dialog.getByRole("button", { name: /fit to screen/ }).click();
    await expect.poll(() => viewOf(image)).toEqual({ scale: 1, x: 0, y: 0 });
    await dialog.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(async () => (await viewOf(image)).scale).toBeGreaterThan(1.5);

    await page.keyboard.press("Escape");
    await expect(page.locator(".app-attachment-lightbox")).toHaveCount(0);
  });
});
