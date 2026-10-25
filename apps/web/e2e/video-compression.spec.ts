import { createHash } from "node:crypto";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { expect, test, type Page } from "./fixtures";
import { fixtureJson, fixtureRequestBodies, fixtureRule, releaseFixture } from "./in-page-api-fixtures";
import { videoFixture } from "./recorded-video";
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
    const urls: string[] = [];
    const revoked: string[] = [];
    Object.assign(window, { mediaFiles: files, mediaUrls: { urls, revoked } });
    const original = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = original(blob);
      if (blob instanceof File) { files.push(blob); urls.push(url); }
      return url;
    };
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
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
    await openComposer(page);
    const source = videoFixture({ width: portrait ? 1080 : 1920, height: portrait ? 1920 : 1080, audio: !portrait, padded: true });
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
  await openComposer(page);
  const video = videoFixture({ width: 1920, height: 1080, audio: true, padded: true });
  const image = await paddedImage(page);
  await observeFiles(page);
  for (const [name, mimeType, buffer] of [
    ["original.png", "image/png", image],
    ["original.webm", "video/webm", video],
  ] as const) {
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType, buffer });
    const choice = page.getByRole("checkbox", { name: `Upload original ${name}`, exact: true });
    await expect(choice).toBeEnabled();
    await choice.check();
    await expect(choice).toBeEnabled();
    await expect(choice).toBeChecked();
    const uploaded = await lastFile(page);
    expect(uploaded).toMatchObject({ name, type: mimeType, size: buffer.length });
    expect(Buffer.from(uploaded.bytes, "base64").equals(buffer)).toBe(true);
    const intents = await fixtureRequestBodies(page, "media-intent");
    expect(intents.at(-1)).toMatchObject({ contentHash: createHash("sha256").update(buffer).digest("hex"), encodedSize: buffer.length });
    await page.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    await expect.poll(() => page.evaluate(() => {
      const { urls, revoked } = (window as unknown as { mediaUrls: { urls: string[]; revoked: string[] } }).mediaUrls;
      return urls.every((url) => revoked.includes(url));
    })).toBe(true);
  }
});

async function paddedImage(page: Page) {
  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    return canvas.toDataURL("image/png").split(",")[1];
  });
  return Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(1_100_000)]);
}

test("image preview choices are independent, reversible and preserve outgoing order", async ({ page }) => {
  await openComposer(page);
  const buffer = await paddedImage(page);
  await page.locator('input[type="file"]').setInputFiles(["first.png", "second.png"].map((name) => ({ name, mimeType: "image/png", buffer })));
  const first = page.getByRole("checkbox", { name: "Upload original first.png", exact: true });
  const second = page.getByRole("checkbox", { name: "Upload original second.png", exact: true });
  await expect(first).toBeEnabled();
  await expect(second).toBeEnabled();
  await expect(page.getByRole("checkbox", { name: "Upload original images and videos" })).toHaveCount(0);
  // The option lives on the individual picture, not in the input bar.
  await expect(page.locator(".composer-image-attachment").filter({ has: first })).toHaveCount(1);
  await first.check();
  await expect(first).toBeEnabled();
  await expect(second).not.toBeChecked();
  await first.uncheck();
  await expect(first).toBeEnabled();
  await second.check();
  await expect(second).toBeEnabled();
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => fixtureRequestBodies(page, "media-send")).toEqual([
    expect.objectContaining({ attachments: [
      expect.objectContaining({ name: "first.jpg", encodedBytes: expect.any(Number) }),
      expect.objectContaining({ name: "second.png", encodedBytes: buffer.length, contentHash: createHash("sha256").update(buffer).digest("hex") }),
    ] }),
  ]);
  const [body] = await fixtureRequestBodies(page, "media-send") as { attachments: { encodedBytes: number; sourceMedia?: unknown }[] }[];
  expect(body.attachments[0].encodedBytes).toBeLessThan(1_000_000);
  expect(body.attachments.every((attachment) => attachment.sourceMedia === undefined)).toBe(true);
});

for (const outcome of ["cancel", "failure"] as const) {
  test(`a quality change retains the prior attachment on ${outcome}`, async ({ page }) => {
    await openComposer(page);
    const buffer = await paddedImage(page);
    await page.locator('input[type="file"]').setInputFiles({ name: "keep.png", mimeType: "image/png", buffer });
    const choice = page.getByRole("checkbox", { name: "Upload original keep.png", exact: true });
    await expect(choice).toBeEnabled();
    const originalIntent = (await fixtureRequestBodies(page, "media-intent"))[0];
    await fixtureRule(page, { id: "quality-hold", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST",
      responder: { kind: "deferred", status: outcome === "failure" ? 403 : 200, json: outcome === "failure" ? { error: "Quality upload refused" } : { ok: true } } });
    await choice.check();
    await expect.poll(() => fixtureRequestBodies(page, "quality-hold")).toHaveLength(1);
    if (outcome === "cancel") await page.getByRole("button", { name: "Cancel keep.png", exact: true }).click();
    await releaseFixture(page, "quality-hold");
    await expect(choice).toBeEnabled();
    await expect(choice).not.toBeChecked();
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => fixtureRequestBodies(page, "media-send")).toEqual([
      expect.objectContaining({ attachments: [expect.objectContaining({ contentHash: (originalIntent as { contentHash: string }).contentHash })] }),
    ]);
  });
}

test("a message sent while its image uploads shows at once and is appended once the image lands", async ({ page }) => {
  await openComposer(page);
  await fixtureRule(page, { id: "intent-hold", pattern: "**/relay-v2/private-r2/upload-intents", method: "POST",
    responder: { kind: "relayV2UploadIntent", held: true } });
  const buffer = await paddedImage(page);
  await page.locator('input[type="file"]').setInputFiles({ name: "late.png", mimeType: "image/png", buffer });
  await expect.poll(() => fixtureRequestBodies(page, "intent-hold")).toHaveLength(1);
  await expect(page.getByRole("button", { name: /^Cancel late/ })).toHaveCount(1);

  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.getByRole("progressbar", { name: /^Uploading late/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Cancel late/ })).toHaveCount(0);
  expect(await fixtureRequestBodies(page, "media-send")).toEqual([]);

  await releaseFixture(page, "intent-hold");
  await expect.poll(() => fixtureRequestBodies(page, "media-send")).toEqual([
    expect.objectContaining({ attachments: [expect.objectContaining({ encodedBytes: expect.any(Number) })] }),
  ]);
});

test("a file the browser cannot compress can still be selected as original on its preview", async ({ page }) => {
  await openComposer(page);
  const buffer = Buffer.alloc(1_100_000, 7);
  await page.locator('input[type="file"]').setInputFiles({ name: "external.png", mimeType: "image/png", buffer });
  const choice = page.getByRole("checkbox", { name: "Upload original external.png", exact: true });
  await expect(choice).toBeEnabled();
  await choice.check();
  await expect(choice).toBeEnabled();
  await expect(choice).toBeChecked();
  await expect.poll(() => fixtureRequestBodies(page, "media-intent")).toEqual([
    expect.objectContaining({ contentHash: createHash("sha256").update(buffer).digest("hex"), encodedSize: buffer.length }),
  ]);
});

for (const reason of ["empty picture track", "unsupported encoders"] as const) {
  test(`video with ${reason} retains the original bytes`, async ({ page }) => {
    await openComposer(page);
    const source = videoFixture({ width: 1920, height: 1080, empty: reason === "empty picture track", padded: true });
    await observeFiles(page);
    if (reason === "unsupported encoders") {
      await page.evaluate(() => Object.defineProperty(window, "VideoEncoder", { configurable: true, value: undefined }));
    }
    await page.locator('input[type="file"]').setInputFiles({ name: "fallback.webm", mimeType: "video/webm", buffer: source });
    await expect(page.getByText(/Ready ·/)).toBeVisible();
    expect(Buffer.from((await lastFile(page)).bytes, "base64").equals(source)).toBe(true);
  });
}

test("removing a video during codec negotiation prevents it uploading when negotiation finishes", async ({ page }) => {
  await openComposer(page);
  const source = videoFixture({ width: 1920, height: 1080, padded: true });
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

test("cancelling after upload releases files waiting for video metadata", async ({ page }) => {
  await openComposer(page);
  await page.evaluate(() => {
    const created: string[] = [];
    const revoked: string[] = [];
    Object.assign(window, { resourceUrls: { created, revoked } });
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => { const url = create(blob); if (blob instanceof File) created.push(url); return url; };
    URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
    // Hold metadata loading until the real five-second metadata deadline.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src")!;
    Object.defineProperty(HTMLMediaElement.prototype, "src", { ...descriptor, set: () => undefined });
  });
  await page.locator('input[type="file"]').setInputFiles({ name: "metadata.webm", mimeType: "video/webm", buffer: Buffer.from("metadata fixture") });
  await expect.poll(() => page.evaluate(() => (window as unknown as { resourceUrls: { created: string[] } }).resourceUrls.created.length)).toBe(2);
  await page.getByRole("button", { name: "Cancel metadata.webm", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const { created, revoked } = (window as unknown as { resourceUrls: { created: string[]; revoked: string[] } }).resourceUrls;
    return created.every((url) => revoked.includes(url));
  })).toBe(true);
});
