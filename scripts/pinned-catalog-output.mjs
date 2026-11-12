import { readFile, writeFile } from "node:fs/promises";

/** Write generated catalog files, or with --check fail when any differs from what the pinned source generates. */
export async function writeOrCheckGenerated(directory, files, command) {
  const check = process.argv.includes("--check");
  for (const [file, contents] of Object.entries(files)) {
    const destination = new URL(file, directory);
    if (!check) await writeFile(destination, contents);
    else if (await readFile(destination, "utf8").catch(() => "") !== contents) throw new Error(`${file} is stale; run ${command}`);
  }
  return check ? "verified" : "generated";
}
