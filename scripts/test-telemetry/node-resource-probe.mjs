import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { mergeResourcePeak, sampleTestProcessResources } from "./resources.mjs";

const outputDirectory = process.env.XMATRIX_TEST_TELEMETRY_RESOURCE_DIR;
const testContext = process.env.NODE_TEST_CONTEXT;

function portableTestFile() {
  const rootDirectory = path.resolve(process.env.XMATRIX_TEST_TELEMETRY_ROOT || process.cwd());
  const argument = process.argv.slice(1).find((value) => /\.(?:test|e2e)\.mjs$/u.test(value));
  if (!argument) return null;
  const absolute = path.resolve(rootDirectory, argument);
  const relative = path.relative(rootDirectory, absolute);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(absolute);
}

if (outputDirectory && testContext) {
  const file = portableTestFile();
  if (file) {
    const rawInterval = Number(process.env.XMATRIX_TEST_TELEMETRY_SAMPLE_MS);
    const intervalMs = Number.isSafeInteger(rawInterval) && rawInterval >= 250 && rawInterval <= 5_000
      ? rawInterval
      : 1_000;
    let peak = null;
    let samples = 0;
    const sample = () => {
      peak = mergeResourcePeak(peak, sampleTestProcessResources());
      samples += 1;
    };
    sample();
    const timer = setInterval(sample, intervalMs);
    timer.unref();

    process.once("exit", () => {
      clearInterval(timer);
      sample();
      const usage = process.resourceUsage();
      const record = {
        schemaVersion: 1,
        file,
        scope: peak.scope,
        peakRssBytes: peak.rssBytes,
        peakFdCount: peak.fdCount,
        peakProcessCount: peak.processCount,
        samples,
        sampleIntervalMs: intervalMs,
        userCpuMicros: usage.userCPUTime,
        systemCpuMicros: usage.systemCPUTime,
      };
      try {
        mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
        writeFileSync(path.join(outputDirectory, `${process.pid}.json`), `${JSON.stringify(record)}\n`, {
          mode: 0o600,
        });
      } catch {
        // Telemetry is diagnostic and must never change test assertions or exit status.
      }
    });
  }
}
