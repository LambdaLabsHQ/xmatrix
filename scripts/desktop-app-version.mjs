#!/usr/bin/env node
// The version a packaged desktop app runs as: the `version` of the package.json
// inside its app.asar, which Electron's app.getVersion() and the updater read,
// and from which the app picks its update channel. Every desktop build machine
// checks the app it packaged carries exactly the release version, so the bytes
// people install follow the channel the release was published to.
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function read(descriptor, length, position) {
  const buffer = Buffer.alloc(length);
  if (readSync(descriptor, buffer, 0, length, position) !== length) throw new Error("app.asar is truncated");
  return buffer;
}

/**
 * One file's bytes from an asar archive: an 8-byte pickle holding the header
 * size, the header pickle (its JSON string length, then the JSON), then file
 * data at the offsets the header names.
 */
export function asarFile(archive, name) {
  const descriptor = openSync(archive, "r");
  try {
    const headerSize = read(descriptor, 8, 0).readUInt32LE(4);
    const header = read(descriptor, headerSize, 8);
    const entry = JSON.parse(header.toString("utf8", 8, 8 + header.readUInt32LE(4))).files?.[name];
    if (!entry || entry.unpacked || !Number.isSafeInteger(entry.size) || !/^\d+$/u.test(entry.offset ?? "")) {
      throw new Error(`app.asar has no packed ${name}`);
    }
    return read(descriptor, entry.size, 8 + headerSize + Number(entry.offset)).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

/** Throws unless the packaged app at `archive` runs as exactly `expected`. */
export function verifyPackagedAppVersion(archive, expected) {
  const version = JSON.parse(asarFile(archive, "package.json")).version;
  if (version !== expected) throw new Error(`${archive} runs as ${version}, not the release version ${expected}`);
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [archive, expected] = process.argv.slice(2);
  try {
    if (!archive || !expected) throw new Error("Usage: node scripts/desktop-app-version.mjs <app.asar> <release-version>");
    console.log(`${archive} runs as ${verifyPackagedAppVersion(archive, expected)}.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
