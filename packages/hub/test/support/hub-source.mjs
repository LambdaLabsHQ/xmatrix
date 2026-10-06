// Contract tests read the Hub's own sources to pin structural boundaries.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** The text of a file, by its path relative to packages/hub. */
export function readHubSource(path) {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

export function sourceRouteRegion(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `route ${marker} must exist`);
  const end = source.indexOf("\n  app.", start + 1);
  assert.notEqual(end, -1, `route ${marker} must have a bounded source region`);
  return source.slice(start, end);
}

export function* hubTypeScriptFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* hubTypeScriptFiles(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Deployment contracts run against every Hub Wrangler environment. */
export function* hubWranglerSources() {
  for (const file of ["wrangler.toml", "wrangler.test.toml", "wrangler.test-deploy.toml"]) {
    yield { file, source: readHubSource(file) };
  }
}
