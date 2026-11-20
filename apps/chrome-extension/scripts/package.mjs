#!/usr/bin/env node
// Copies the extension into dist/chrome-extension with the release's version
// stamped into its manifest, ready to zip for the Chrome Web Store.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "../..");
const shipped = ["manifest.json", "icons", "src"];

/**
 * Chrome allows only up to four dot-separated integers in `version`, so a beta
 * `4.7.3-beta.2` ships as version `4.7.3` with the full name in `version_name`.
 */
export function chromeVersion(release) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/u.exec(release);
  if (!match) throw new Error(`Not a release version: ${release}`);
  return { version: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, versionName: release };
}

export function packageExtension({ out = path.join(repo, "dist", "chrome-extension"), release } = {}) {
  const resolved = release ?? JSON.parse(fs.readFileSync(path.join(repo, "version.json"), "utf8")).version;
  const { version, versionName } = chromeVersion(resolved);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const entry of shipped) {
    fs.cpSync(path.join(root, entry), path.join(out, entry), { recursive: true });
  }
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.version = version;
  manifest.version_name = versionName;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { out, version, versionName };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const outArg = process.argv.indexOf("--out");
  const { out, versionName } = packageExtension(outArg > 0 ? { out: path.resolve(process.argv[outArg + 1]) } : {});
  console.log(`Packaged the xMatrix Chrome extension ${versionName} in ${out}`);
}
