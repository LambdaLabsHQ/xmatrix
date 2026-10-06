import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCliMain } from "./cli-entrypoint.mjs";

export function writeMacUpdaterManifest({ directory, version, releaseDate = new Date().toISOString() }) {
  const stem = `xMatrix-${version}-arm64`;
  const entries = ["zip", "dmg"].map((extension) => {
    const fileName = `${stem}.${extension}`;
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
