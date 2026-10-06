import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalVersion = JSON.parse(fs.readFileSync(path.join(rootDir, "version.json"), "utf8")).version;
export const androidDir = path.resolve(rootDir, process.env.ANDROID_PROJECT_DIR || "apps/android");

if (process.env.ANDROID_VERSION_NAME && process.env.ANDROID_VERSION_NAME !== canonicalVersion) {
  throw new Error(
    `ANDROID_VERSION_NAME (${process.env.ANDROID_VERSION_NAME}) must match version.json version (${canonicalVersion}).`,
  );
}

export const androidVersion = canonicalVersion;

export function walk(dir, predicate, found = []) {
  if (!fs.existsSync(dir)) return found;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const next = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(next, predicate, found);
    } else if (predicate(next, entry)) {
      found.push(next);
    }
  }

  return found;
}

export function newest(paths) {
  return paths
    .map((filePath) => ({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.filePath;
}

export function splitTasks(value) {
  return value.split(/\s+/).filter(Boolean);
}
