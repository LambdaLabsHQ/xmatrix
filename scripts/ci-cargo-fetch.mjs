import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout } from "node:timers/promises";

// Cargo metadata can surface curl 56 without applying Cargo's own retries.
// Retry only dependency transfer, never a compiler, build script or test.
const transientTransfer = /\[(?:5|6|7|16|18|28|52|55|56|92)\] |(?:HTTP|status code)[^\n]*(?:408|429|500|502|503|504)\b/i;

export async function fetchRustDependencies({
  run = spawnSync,
  delay = setTimeout,
  output = (text) => process.stderr.write(text),
} = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = run(process.platform === "win32" ? "cargo.exe" : "cargo", [
      "fetch", "--locked", "--target", "x86_64-pc-windows-msvc",
    ], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../packages/cli-rs"),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const diagnostic = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    output(diagnostic);
    if (!result.error && !result.signal && result.status === 0) return;
    if (result.error || result.signal || attempt === 3 || !transientTransfer.test(diagnostic)) {
      throw new Error(`Cargo dependency fetch failed (attempt ${attempt}, exit ${result.status ?? "unknown"})`, { cause: result.error });
    }
    output(`Transient Cargo dependency transfer failure; retry ${attempt}/2 in 5 seconds.\n`);
    await delay(5_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await fetchRustDependencies();
}
