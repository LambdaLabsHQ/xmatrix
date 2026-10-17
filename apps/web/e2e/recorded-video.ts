import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Real VP8/Opus media, independent of compositor timing on the test host. */
export function videoFixture({ width = 32, height = 32, audio = false, empty = false, padded = false }: {
  width?: number; height?: number; audio?: boolean; empty?: boolean; padded?: boolean;
} = {}) {
  const name = empty ? "empty-video-track" : `${width}x${height}${audio ? "-audio" : ""}`;
  const source = readFileSync(join(__dirname, "fixtures", `${name}.webm`));
  // A valid Matroska Void element makes the compression threshold deterministic.
  return padded ? Buffer.concat([source, Buffer.from([0xec, 0x30, 0xc8, 0xe0]), Buffer.alloc(1_100_000)]) : source;
}
