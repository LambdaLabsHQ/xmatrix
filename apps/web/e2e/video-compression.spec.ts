import { createHash } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { expect, test, type Page } from "./fixtures";
import { fixtureJson, fixtureRequestBodies, fixtureRule } from "./in-page-api-fixtures";
import { recordedVideo } from "./recorded-video";
import { E2E_CHANNEL, E2E_DESKTOP_CONTEXT, openGeneralChannelWithHistory } from "./workspace-fixtures";

test.use(E2E_DESKTOP_CONTEXT);

async function openComposer(page: Page) {
  await openGeneralChannelWithHistory(page, E2E_CHANNEL, []);
  await fixtureRule(page, { id: "media-intent", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST", responder: { kind: "relayV2UploadIntent" } });
  await fixtureJson(page, "media-ref", "**/relay-v2/private-r2/blob-refs", { ok: true }, { method: "POST" });
  await fixtureJson(page, "media-bytes", "**/relay-v2/private-r2/uploads/**", { ok: true }, { method: "PUT" });
  await fixtureJson(page, "media-send", `**/channels/${E2E_CHANNEL.id}/messages`, {}, { method: "POST" });
}

// Observe actual File objects passed to browser APIs, without replacing the compressor.
async function observeFiles(page: Page) {
  await page.evaluate(() => {
    const files: File[] = [];
    Object.assign(window, { mediaFiles: files });
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      if (blob instanceof File) files.push(blob);
      return original(blob);
    };
  });
}

async function lastFile(page: Page) {
  return page.evaluate(async () => {
    const file = (window as unknown as { mediaFiles: File[] }).mediaFiles.at(-1)!;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return { name: file.name, type: file.type, size: file.size, bytes: btoa(binary) };
  });
}

for (const portrait of [false, true]) {
  test(`video upload compresses ${portrait ? "portrait without audio" : "landscape with audio"} and sends the resulting dimensions`, async ({ page }) => {
    const width = portrait ? 720 : 1280;
    const height = portrait ? 1280 : 720;
    const source = await recordedVideo(page, portrait ? 1080 : 1920, portrait ? 1920 : 1080, !portrait, true);
    await openComposer(page);
    await observeFiles(page);
    await page.locator('input[type="file"]').setInputFiles({ name: "capture.webm", mimeType: "application/octet-stream", buffer: source });
    await expect(page.getByText(/Ready ·/)).toBeVisible();
    const result = await lastFile(page);
    expect(result.size).toBeLessThan(source.length);
    expect(["video/mp4", "video/webm"]).toContain(result.type);
    const original = new Input({ source: new BufferSource(source), formats: ALL_FORMATS });
    let sourceDuration: number;
    try { sourceDuration = await original.computeDuration(); }
    finally { original.dispose(); }
    const input = new Input({ source: new BufferSource(Buffer.from(result.bytes, "base64")), formats: ALL_FORMATS });
    try {
      const video = (await input.getPrimaryVideoTrack())!;
      expect(await video.getDisplayWidth()).toBe(width);
      expect(await video.getDisplayHeight()).toBe(height);
      expect(await input.computeDuration()).toBeCloseTo(sourceDuration, 1);
      const audio = await input.getPrimaryAudioTrack();
      if (portrait) expect(audio).toBeNull();
      else {
        expect(audio).toBeTruthy();
        expect(await audio!.computeDuration()).toBeGreaterThan(0.4);
      }
    } finally { input.dispose(); }
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => fixtureRequestBodies(page, "media-send")).toEqual([
      expect.objectContaining({ attachments: [expect.objectContaining({
        mimeType: result.type, encodedBytes: result.size, presentationResidual: expect.objectContaining({ width, height }),
      })] }),
    ]);
  });
}

test("Original preserves image and video bytes above the automatic compression threshold", async ({ page }) => {
  const video = await recordedVideo(page, 1920, 1080, true, true);
  await openComposer(page);
  await page.getByRole("checkbox", { name: "Upload original images and videos" }).check();
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  for (const [name, mimeType, buffer] of [
    ["original.png", "image/png", Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(1_100_000)])],
    ["original.webm", "video/webm", video],
  ] as const) {
    await observeFiles(page);
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
    await expect(page.getByRole("button", { name: `Remove ${name}`, exact: true })).toBeVisible();
    const uploaded = await lastFile(page);
    expect(uploaded).toMatchObject({ name, type: mimeType, size: buffer.length });
    expect(Buffer.from(uploaded.bytes, "base64").equals(buffer)).toBe(true);
    const intents = await fixtureRequestBodies(page, "media-intent");
    expect(intents.at(-1)).toMatchObject({ contentHash: createHash("sha256").update(buffer).digest("hex"), encodedSize: buffer.length });
    await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
  }
});

test("unsupported video encoders keep the original", async ({ page }) => {
  const source = await recordedVideo(page, 1920, 1080, false, true);
  await openComposer(page);
  await observeFiles(page);
  await page.evaluate(() => Object.defineProperty(window, "VideoEncoder", { configurable: true, value: undefined }));
  await page.locator('input[type="file"]').setInputFiles({ name: "fallback.webm", mimeType: "video/webm", buffer: source });
  await expect(page.getByText(/Ready ·/)).toBeVisible();
  expect(Buffer.from((await lastFile(page)).bytes, "base64").equals(source)).toBe(true);
});

test("removing a video during codec negotiation prevents it uploading when negotiation finishes", async ({ page }) => {
  const source = await recordedVideo(page, 1920, 1080, false, true);
  await openComposer(page);
  await page.evaluate(() => {
    const original = VideoEncoder.isConfigSupported.bind(VideoEncoder);
    const gate = new Promise<void>((resolve) => Object.assign(window, { resumeCodecCheck: resolve }));
    VideoEncoder.isConfigSupported = async (config) => {
      Object.assign(window, { codecCheckStarted: true });
      await gate;
      return original(config);
    };
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "cancel.webm", mimeType: "video/webm", buffer: source });
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as { codecCheckStarted?: boolean }).codecCheckStarted))).toBe(true);
  await page.getByRole("button", { name: "Cancel cancel.webm", exact: true }).click();
  await page.evaluate(() => (window as unknown as { resumeCodecCheck: () => void }).resumeCodecCheck());
  // A following attachment completes through the same intake; the cancelled video must stay gone.
  await page.locator('input[type="file"]').setInputFiles({ name: "next.txt", mimeType: "text/plain", buffer: Buffer.from("next") });
  await expect(page.getByText(/Ready -/)).toBeVisible();
  await expect.poll(() => fixtureRequestBodies(page, "media-intent")).toEqual([
    expect.objectContaining({ encodedSize: 4 }),
  ]);
  await expect(page.getByText("cancel.webm", { exact: true })).toHaveCount(0);
});
