import type { Page } from "@playwright/test";

/** Real decodable media; optional Matroska Void padding makes the size deterministic. */
export async function recordedVideo(page: Page, width = 32, height = 32, audio = false, padded = false) {
  const encoded = await page.evaluate(async ({ width, height, audio, padded }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false })!;
    context.fillStyle = "green";
    context.fillRect(0, 0, width, height);
    const stream = canvas.captureStream(20);
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
    const animation = setInterval(() => {
      context.fillStyle = frame++ % 2 ? "green" : "blue";
      context.fillRect(0, 0, width, height);
      (stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame();
    }, 50);
    await new Promise((resolve) => setTimeout(resolve, 700));
    clearInterval(animation);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    await sound.close();
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
