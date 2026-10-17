import { fitImageDimensions } from "./image-attachment-compression";
import type { Conversion } from "mediabunny";

/** Best effort: unsupported codecs and failed conversions keep the original. */
export async function prepareVideoAttachmentFile(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (progress: number) => void } = {},
): Promise<File> {
  if (file.size <= 1_000_000 || typeof VideoEncoder === "undefined" || options.signal?.aborted) return file;

  // Load the demuxer/encoder only when a video actually needs compression.
  const media = await import("mediabunny").catch(() => null);
  if (!media || options.signal?.aborted) return file;
  const input = new media.Input({ source: new media.BlobSource(file), formats: media.ALL_FORMATS });
  let conversion: Conversion | undefined;
  let stopped = false;
  const stop = () => {
    stopped = true;
    void conversion?.cancel().catch(() => undefined);
    input.dispose();
  };
  options.signal?.addEventListener("abort", stop, { once: true });
  const deadline = setTimeout(stop, 120_000);
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode())) return file;
    const dimensions = fitImageDimensions({
      width: await video.getDisplayWidth(), height: await video.getDisplayHeight(),
    }, 1280);
    // Chroma-subsampled encoders require even dimensions, including portrait clips.
    const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
    const width = even(dimensions.width);
    const height = even(dimensions.height);
    const quality = new media.Quality({ bitrate: 2_500_000 });
    const audioCodecs = await Promise.all((await input.getAudioTracks()).map((track) => track.getCodec()));
    const mp4AudioSupported = audioCodecs.every((codec) => codec === "aac") || await media.canEncodeAudio("aac");
    const codec = await media.getFirstEncodableVideoCodec(
      mp4AudioSupported ? ["avc", "vp9", "vp8"] : ["vp9", "vp8"], { width, height, quality },
    );
    if (!codec || stopped) return file;
    const mp4 = codec === "avc";
    const target = new media.BufferTarget();
    // No reason to keep allocating when the result can no longer save bytes.
    target.on("write", ({ end }) => {
      if (end >= file.size) throw new Error("Compressed video is larger than its source.");
    });
    const output = new media.Output({
      format: mp4 ? new media.Mp4OutputFormat({ fastStart: "fragmented" }) : new media.WebMOutputFormat(),
      target,
    });
    conversion = await media.Conversion.init({
      input, output,
      video: async (track) => {
        const size = fitImageDimensions({
          width: await track.getDisplayWidth(), height: await track.getDisplayHeight(),
        }, 1280);
        return { codec, width: even(size.width), height: even(size.height), fit: "contain", quality };
      },
      // Already-compatible audio is copied; other audio is converted, never silently dropped.
      audio: { codec: mp4 ? "aac" : "opus" },
      showWarnings: false,
    });
    if (stopped || !conversion.isValid || conversion.discardedTracks.length > 0) return file;
    let lastProgress = -1;
    conversion.onProgress = (progress) => {
      const percent = Math.floor(progress * 100);
      if (percent !== lastProgress) {
        lastProgress = percent;
        options.onProgress?.(percent);
      }
    };
    options.onProgress?.(0);
    await conversion.execute();
    const buffer = target.buffer;
    if (stopped || !buffer?.byteLength || buffer.byteLength >= file.size) return file;
    const base = (file.name || "video").replace(/\.[^.]+$/, "") || "video";
    return new File([buffer], `${base}.${mp4 ? "mp4" : "webm"}`, {
      type: mp4 ? "video/mp4" : "video/webm", lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", stop);
    await conversion?.cancel().catch(() => undefined);
    input.dispose();
  }
}
