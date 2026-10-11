import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCliMain } from "./cli-entrypoint.mjs";

// One feed serves both architectures: electron-updater on Apple Silicon picks
// the files whose name carries `arm64`, and an Intel Mac picks the others. The
// legacy top-level path stays on the arm64 ZIP that older clients read.
export function writeMacUpdaterManifest({ directory, version, releaseDate = new Date().toISOString() }) {
  const entries = ["arm64.zip", "arm64.dmg", "x64.zip", "x64.dmg"].map((suffix) => {
    const fileName = `xMatrix-${version}-${suffix}`;
    const filePath = path.join(directory, fileName);
    return {
      fileName,
      sha512: crypto.createHash("sha512").update(fs.readFileSync(filePath)).digest("base64"),
      size: fs.statSync(filePath).size,
    };
  });
  const primary = entries[0];
  const lines = [
    `version: ${version}`,
    "files:",
    ...entries.flatMap((entry) => [
      `  - url: ${entry.fileName}`,
      `    sha512: ${entry.sha512}`,
      `    size: ${entry.size}`,
    ]),
    `path: ${primary.fileName}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${releaseDate}'`,
    "",
  ];
  fs.writeFileSync(path.join(directory, "latest-mac.yml"), lines.join("\n"));
}

await runCliMain(import.meta.url, async () => writeMacUpdaterManifest({
  directory: process.argv[2], version: process.env.DESKTOP_VERSION,
}));
