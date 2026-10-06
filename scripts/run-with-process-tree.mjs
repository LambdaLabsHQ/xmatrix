#!/usr/bin/env node
import process from "node:process";

import { ProgressStageError, runProgressStages } from "./ci-progress.mjs";

const separator = process.argv.indexOf("--");
const argv = process.argv.slice(separator >= 0 ? separator + 1 : 2);
if (argv.length === 0) {
  console.error("Usage: node scripts/run-with-process-tree.mjs -- <command> [args...]");
  process.exit(2);
}

try {
  await runProgressStages(
    [
      {
        label: argv.join(" "),
        command: argv[0],
        args: argv.slice(1),
        cwd: process.cwd(),
        env: process.env,
      },
    ],
    { prefix: "process-tree" },
  );
} catch (error) {
  if (error instanceof ProgressStageError) process.exit(1);
  throw error;
}
