#!/usr/bin/env node
/**
 * Assert what a D1 schema migration actually produced.
 *
 * The Hub's invite gate fails closed, so a Worker deployed ahead of its tables
 * refuses every sign-up. That makes the dangerous outcome not "the migration
 * errored" but "the check reported success without looking", which is why
 * these assertions live in a tested file rather than inline in a workflow.
 *
 * Parsing is the fiddly part. `wrangler --json` prints its payload to stdout,
 * but so do its own notices — on a proxied runner the first line is
 * "Proxy environment variables detected...", which is what broke the first
 * version of this check. Slicing from the first `[` is not a fix either: a
 * notice is free to contain a bracket, and `JSON.parse` on the rest of the
 * file would also reject anything wrangler prints *after* the payload.
 *
 * So each candidate offset is read to its own balanced end and parsed alone,
 * and a result is accepted only when it has the shape wrangler actually
 * returns. Noise may sit on either side. No candidate matching that shape is
 * a failure, never a silent pass.
 */

import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Rows wrangler returns for one statement, plus whatever else it reports. */
function isPayloadShape(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => entry && typeof entry === "object" && !Array.isArray(entry)) &&
    value.some((entry) => Array.isArray(entry.results))
  );
}

/**
 * Recover wrangler's JSON payload from output that may carry leading notices.
 *
 * @param {string} raw whole captured stdout
 * @returns {Array<{results?: unknown[]}>} the parsed payload
 */
export function parseWranglerJsonPayload(raw) {
  return parseWranglerJsonValue(raw, isPayloadShape);
}

/** Recover the identity object returned by `wrangler d1 info --json`. */
export function parseWranglerD1Info(raw) {
  return parseWranglerJsonValue(raw, (value) => (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.uuid === "string" &&
    typeof value.name === "string"
  ));
}

/** Parse the first balanced JSON value whose shape the caller recognizes. */
export function parseWranglerJsonValue(raw, accepts) {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("wrangler produced no output to read back");
  }

  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "[" && raw[start] !== "{") continue;
    const end = balancedEnd(raw, start);
    if (end < 0) continue;

    let parsed;
    try {
      parsed = JSON.parse(raw.slice(start, end));
    } catch {
      continue;
    }
    // A fragment that happens to parse (a bare `{}` inside a notice, say) is
    // not the payload. Require the shape before believing it.
    if (accepts(parsed)) return parsed;
  }

  throw new Error("no wrangler JSON payload found in output");
}

/**
 * Index just past the bracket that closes the one at `start`, or -1.
 *
 * Reading to a balanced end rather than to the end of the string is what lets
 * wrangler print anything it likes after the payload — a timing line, another
 * notice — without the readback deciding it found nothing.
 */
function balancedEnd(raw, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < raw.length; index += 1) {
    const character = raw[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === "[" || character === "{") depth += 1;
    else if (character === "]" || character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Every row across every statement in the payload. */
export function payloadRows(payload) {
  return payload.flatMap((entry) => (Array.isArray(entry.results) ? entry.results : []));
}

/** Names returned by a `SELECT name ...` readback, sorted and de-duplicated. */
export function payloadNames(payload) {
  const names = payloadRows(payload)
    .map((row) => (row && typeof row === "object" ? row.name : undefined))
    .filter((name) => typeof name === "string" && name.length > 0);
  return [...new Set(names)].sort();
}

/** The migration files checked into the repository, in ledger order. */
export function migrationFilesOnDisk(directory) {
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    // "Found nothing" must never read as "everything is applied".
    throw new Error(`no .sql migrations found in ${directory}`);
  }
  return files;
}

function assertTables(file, expected) {
  const found = payloadNames(parseWranglerJsonPayload(readFileSync(file, "utf8")));
  const want = [...expected].sort();
  console.log(`Tables found: ${found.join(",") || "(none)"}`);
  if (found.join(",") !== want.join(",")) {
    throw new Error(`expected exactly ${want.join(",")}; found ${found.join(",") || "(none)"}`);
  }
}

function assertLedgerCovers(file, directory) {
  const applied = new Set(payloadNames(parseWranglerJsonPayload(readFileSync(file, "utf8"))));
  const onDisk = migrationFilesOnDisk(directory);
  console.log(`Ledger entries: ${[...applied].sort().join(", ") || "(none)"}`);
  const missing = onDisk.filter((migration) => !applied.has(migration));
  if (missing.length > 0) {
    throw new Error(`not recorded as applied: ${missing.join(", ")}`);
  }
}

function assertDatabaseIdentity(file, expectedName, expectedUuid) {
  const found = parseWranglerD1Info(readFileSync(file, "utf8"));
  console.log(`D1 identity: ${found.name} (${found.uuid})`);
  if (found.name !== expectedName || found.uuid !== expectedUuid) {
    throw new Error(
      `expected D1 ${expectedName} (${expectedUuid}); found ${found.name} (${found.uuid})`,
    );
  }
}

const [mode, file, argument, secondArgument] = process.argv.slice(2);
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    if (mode === "tables") {
      assertTables(file, (argument || "").split(",").filter(Boolean));
    } else if (mode === "ledger") {
      assertLedgerCovers(file, argument);
    } else if (mode === "database") {
      assertDatabaseIdentity(file, argument, secondArgument);
    } else {
      throw new Error(`unknown mode ${mode}; expected "database", "tables", or "ledger"`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
