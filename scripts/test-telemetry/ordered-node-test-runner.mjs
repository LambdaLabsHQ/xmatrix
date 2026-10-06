#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { finished } from "node:stream/promises";
import { run } from "node:test";
import { spec } from "node:test/reporters";

import { positiveIntegerFlag } from "./cli-flags.mjs";
import { sanitizeNodeTestEvent } from "./node-test-reporter.mjs";



function pathFlag(name) {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  const value = raw?.slice(prefix.length);
  if (!value || !path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return value;
}

const separator = process.argv.indexOf("--");
if (separator < 0 || separator === process.argv.length - 1) {
  throw new Error("ordered Node test runner requires at least one file after --");
}

const concurrency = positiveIntegerFlag("--test-concurrency", { required: true });
const timeout = positiveIntegerFlag("--test-timeout", { required: true });
const eventsFile = pathFlag("--events-file");
const files = process.argv.slice(separator + 1);
// Load test dependencies in the isolated workers. The reporter process does
// not import test sources, so initializing their loaders here is duplicate work.
const execArgv = process.argv.slice(2, separator)
  .filter((argument) => argument.startsWith("--test-import="))
  .map((argument) => `--import=${argument.slice("--test-import=".length)}`);
const rootDirectory = process.env.XMATRIX_TEST_TELEMETRY_ROOT || process.cwd();
const events = createWriteStream(eventsFile, { flags: "w", mode: 0o600 });
const reporter = spec();
const tests = run({ files, concurrency, timeout, execArgv });
let failed = false;

tests.on("data", (event) => {
  const sanitized = sanitizeNodeTestEvent(event, rootDirectory);
  if (sanitized) events.write(`${JSON.stringify(sanitized)}\n`);
  if (
    event.type === "test:complete"
    && event.data?.nesting === 0
    && event.data?.details?.passed === false
  ) failed = true;
});
tests.pipe(reporter).pipe(process.stdout, { end: false });

await finished(tests);
await finished(reporter);
events.end();
await finished(events);
if (failed) process.exitCode = 1;
