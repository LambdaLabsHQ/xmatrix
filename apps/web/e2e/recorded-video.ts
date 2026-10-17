import type { Page } from "@playwright/test";

/** Real decodable media; optional Matroska Void padding makes the size deterministic. */
export async function recordedVideo(page: Page, width = 32, height = 32, audio = false, padded = false) {
  // Chromium's initial about:blank may never paint captured canvas frames.
  if (page.url() === "about:blank") await page.goto("data:text/html,<html><body></body></html>");
  const encoded = await page.evaluate(async ({ width, height, audio, padded }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false })!;
    context.fillStyle = "green";
    context.fillRect(0, 0, width, height);
    // Keep the canvas painted while the recorder captures picture packets.
    canvas.style.cssText = "position:fixed;inset:0;z-index:2147483647;width:32px;height:32px";
    document.body.appendChild(canvas);
    const stream = canvas.captureStream(0);
    const sound = new AudioContext();
    const oscillator = sound.createOscillator();
    const destination = sound.createMediaStreamDestination();
    if (audio) {
      oscillator.connect(destination);
      oscillator.start();
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      await sound.resume();
    }
    const recorder = new MediaRecorder(stream, { mimeType: audio ? "video/webm;codecs=vp8,opus" : "video/webm;codecs=vp8" });
    const chunks: BlobPart[] = [];
    const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.start();
    let frame = 0;
    const start = performance.now();
    // Schedule actual paints rather than timers: captureStream emits no frame
    // when a timer draws and stops between compositor paints under CI load.
    await new Promise<void>((resolve) => {
      const draw = (now: number) => {
        context.fillStyle = frame++ % 2 ? "green" : "blue";
        context.fillRect(0, 0, width, height);
        (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
        if (now - start < 700 || frame < 4) requestAnimationFrame(draw);
        else requestAnimationFrame(() => resolve());
      };
      requestAnimationFrame(draw);
    });
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    await sound.close();
    canvas.remove();
    if (padded) chunks.push(new Uint8Array([0xec, 0x30, 0xc8, 0xe0]), new Uint8Array(1_100_000));
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }, { width, height, audio, padded });
  return Buffer.from(encoded, "base64");
}
