import { expect, test } from "./fixtures";
import { E2E_CHANNEL, E2E_NOW, E2E_USER_SENDER, openGeneralChannelWithHistory } from "./workspace-fixtures";

test("generic MIME WebM plays inline and in the lightbox; audio files have native controls", async ({ page }) => {
  // Generate a real VP8 WebM in Chromium rather than asserting only the tag.
  const encoded = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "green";
    context.fillRect(0, 0, 32, 32);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" });
    const chunks: Blob[] = [];
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start();
    let frame = 0;
    const animation = setInterval(() => {
      context.fillStyle = frame++ % 2 ? "green" : "blue";
      context.fillRect(0, 0, 32, 32);
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 500));
    clearInterval(animation);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  });
  const video = Buffer.from(encoded, "base64");
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
