import { expect, test } from "./fixtures";
import { videoFixture } from "./recorded-video";
import { E2E_CHANNEL, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

test("generic MIME WebM plays inline and in the lightbox; audio files have native controls", async ({ page }) => {
  const video = videoFixture();
  const wav = Buffer.alloc(44 + 8000);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write("data", 36); wav.writeUInt32LE(8000, 40); wav.fill(128, 44);
  await page.route("**/e2e-media/clip.webm", (route) => route.fulfill({ contentType: "application/octet-stream", body: video }));
  await page.route("**/e2e-media/voice.wav", (route) => route.fulfill({ contentType: "application/octet-stream", body: wav }));
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "multimedia-message", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "Media files", sentAt: E2E_NOW, from: E2E_USER_SENDER,
    attachments: [
      { id: "clip", kind: "file", name: "handoff-anim.webm", mimeType: "application/octet-stream", size: video.length, url: "/e2e-media/clip.webm" },
      { id: "voice", kind: "file", name: "voice.wav", mimeType: "application/octet-stream", size: wav.length, url: "/e2e-media/voice.wav" },
    ],
  }]);
  const inline = page.locator("video");
  await expect(inline).toBeVisible();
  await expect.poll(() => inline.evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(32);
  await inline.evaluate((element: HTMLVideoElement) => element.play());
  await expect.poll(() => inline.evaluate((element: HTMLVideoElement) => element.currentTime)).toBeGreaterThan(0);
  const audio = page.locator("audio");
  await expect(audio).toBeVisible();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.readyState)).toBeGreaterThan(0);
  await expect(audio).toHaveAttribute("controls", "");
  await page.getByRole("button", { name: "Open handoff-anim.webm" }).click();
  await expect(page.getByRole("dialog").locator("video")).toBeVisible();
  await expect.poll(() => page.getByRole("dialog").locator("video").evaluate((element: HTMLVideoElement) => element.videoWidth)).toBe(32);
});

test("video attachments respect their original portrait and landscape aspect ratios", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const portrait = videoFixture({ width: 1080, height: 1920 });
  const landscape = videoFixture({ width: 1920, height: 1080 });
  await page.route("**/e2e-media/portrait-meta.webm", (route) => route.fulfill({ contentType: "video/webm", body: portrait }));
  await page.route("**/e2e-media/portrait-raw.webm", (route) => route.fulfill({ contentType: "video/webm", body: portrait }));
  await page.route("**/e2e-media/landscape.webm", (route) => route.fulfill({ contentType: "video/webm", body: landscape }));
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "video-aspect-message", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "Aspect ratio check", sentAt: E2E_NOW, from: E2E_USER_SENDER,
    attachments: [
      { id: "portrait-meta", kind: "video", name: "portrait-meta.webm", mimeType: "video/webm", size: portrait.length, url: "/e2e-media/portrait-meta.webm", width: 1080, height: 1920 },
      { id: "portrait-raw", kind: "video", name: "portrait-raw.webm", mimeType: "video/webm", size: portrait.length, url: "/e2e-media/portrait-raw.webm" },
      { id: "landscape", kind: "video", name: "landscape.webm", mimeType: "video/webm", size: landscape.length, url: "/e2e-media/landscape.webm" },
    ],
  }]);

  const containers = page.locator(".message-video-attachment");
  await expect(containers).toHaveCount(3);
  for (let index = 0; index < 3; index++) {
    await expect.poll(() => containers.nth(index).locator("video").evaluate((element: HTMLVideoElement) => element.videoWidth)).toBeGreaterThan(0);
  }

  const measureRatio = async (index: number) => {
    const box = await containers.nth(index).boundingBox();
    expect(box).not.toBeNull();
    return box!.width / box!.height;
  };

  await expect.poll(() => measureRatio(0)).toBeCloseTo(1080 / 1920, 1);
  await expect.poll(() => measureRatio(1)).toBeCloseTo(1080 / 1920, 1);
  await expect.poll(() => measureRatio(2)).toBeCloseTo(1920 / 1080, 1);

  const portraitBox = await containers.nth(0).boundingBox();
  const landscapeBox = await containers.nth(2).boundingBox();
  expect(portraitBox!.height).toBeGreaterThan(portraitBox!.width);
  expect(landscapeBox!.width).toBeGreaterThan(landscapeBox!.height);
  expect(portraitBox!.width).toBeLessThan(landscapeBox!.width);
});

test("Internet media loads only after Preview and playback failures retain the original link", async ({ page }) => {
  let reads = 0;
  await page.route("https://media.example/clip.webm*", (route) => {
    reads++;
    return route.fulfill({ contentType: "video/webm", body: "invalid media" });
  });
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "media-link", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "https://media.example/clip.webm?download=1", sentAt: E2E_NOW, from: E2E_USER_SENDER,
  }]);
  const preview = page.getByRole("button", { name: "Preview media" });
  await expect(preview).toBeVisible();
  expect(reads).toBe(0);
  await preview.click();
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(page.getByText("This media could not be played.", { exact: false })).toBeVisible();
  await expect(page.getByRole("link", { name: "https://media.example/clip.webm?download=1" })).toBeVisible();
  await page.getByRole("button", { name: "Close media" }).click();
  await expect(page.getByText("This media could not be played.", { exact: false })).toHaveCount(0);
});

test("a file attachment is a slip of tinted paper, not a glass card", async ({ page }) => {
  await openGeneralChannelWithHistory(page, { ...E2E_CHANNEL, messageCount: 1, lastMessageSequence: 1 }, [{
    messageId: "file-message", channelId: E2E_CHANNEL.id, sequence: 1,
    body: "Repro files", sentAt: E2E_NOW, from: E2E_USER_SENDER,
    attachments: [
      { id: "repro", kind: "file", name: "review817-repro.mjs", mimeType: "application/octet-stream", size: 5530, url: "/e2e-media/repro.mjs" },
    ],
  }]);
  const card = page.getByRole("button", { name: "Download review817-repro.mjs" });
  await expect(card).toBeVisible();
  const material = await card.evaluate((element) => {
    const style = getComputedStyle(element);
    const icon = getComputedStyle(element.firstElementChild!);
    return {
      boxShadow: style.boxShadow,
      backdropFilter: style.backdropFilter,
      borderWidth: style.borderTopWidth,
      background: style.backgroundColor,
      before: getComputedStyle(element, "::before").content,
      iconBackground: icon.backgroundColor,
      iconShadow: icon.boxShadow,
    };
  });
  expect(material).toMatchObject({ boxShadow: "none", backdropFilter: "none", borderWidth: "0px", before: "none", iconBackground: "rgba(0, 0, 0, 0)", iconShadow: "none" });
  expect(material.background).not.toBe("rgba(0, 0, 0, 0)");
});
