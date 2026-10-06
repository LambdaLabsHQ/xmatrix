#!/usr/bin/env node
/**
 * Data-driven agent command catalog helper.
 *
 * Does NOT invent per-command business logic. It validates catalog JSON shape
 * and prints the stable vendor source URLs used to refresh lists.
 *
 * Usage:
 *   node scripts/refresh-agent-command-catalogs.mjs --check
 *   node scripts/refresh-agent-command-catalogs.mjs --print-sources
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const catalogDir = path.join(root, "packages/protocol/src/agent-command-catalogs");

const EXPECTED = [
  {
    file: "codex.json",
    runtime: "codex",
    sourceUrl: "https://learn.chatgpt.com/codex/reference/slash-commands",
  },
  {
    file: "claude.json",
    runtime: "claude",
    sourceUrl: "https://code.claude.com/docs/en/commands",
  },
  {
    file: "grok.json",
    runtime: "grok",
    sourceUrl: "https://docs.x.ai/build/modes-and-commands",
  },
  {
    file: "kimi.json",
    runtime: "kimi",
    sourceUrl: "https://moonshotai.github.io/kimi-code/en/reference/slash-commands.html",
  },
  {
    file: "zcode.json",
    runtime: "zcode",
    sourceUrl: "https://zcode.z.ai/en/docs/commands",
  },
];

function loadCatalog(file) {
  const full = path.join(catalogDir, file);
  const raw = fs.readFileSync(full, "utf8");
  return JSON.parse(raw);
}

function checkCatalog(meta) {
  const catalog = loadCatalog(meta.file);
  const errors = [];
  if (catalog.runtime !== meta.runtime) {
    errors.push(`runtime expected ${meta.runtime}, got ${catalog.runtime}`);
  }
  if (catalog.sourceUrl !== meta.sourceUrl) {
    errors.push(`sourceUrl drift: ${catalog.sourceUrl}`);
  }
  if (!Array.isArray(catalog.commands) || catalog.commands.length === 0) {
    errors.push("commands must be a non-empty array");
  }
  const seen = new Set();
  for (const command of catalog.commands || []) {
    if (typeof command.token !== "string" || !command.token.startsWith("/")) {
      errors.push(`invalid token: ${JSON.stringify(command.token)}`);
      continue;
    }
    const key = command.token.toLowerCase();
    if (seen.has(key)) errors.push(`duplicate token ${command.token}`);
    seen.add(key);
    if (!command.label || typeof command.label !== "string") {
      errors.push(`${command.token} missing label`);
    }
    if (command.mode && command.mode !== "typed" && command.mode !== "passthrough") {
      errors.push(`${command.token} invalid mode ${command.mode}`);
    }
    if (
      command.argumentSource &&
      command.argumentSource !== "agent-models" &&
      command.argumentSource !== "agent-efforts"
    ) {
      errors.push(`${command.token} invalid argumentSource ${command.argumentSource}`);
    }
  }
  return errors;
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has("--print-sources") || args.size === 0) {
    console.log("Agent command catalog sources:\n");
    for (const meta of EXPECTED) {
      console.log(`- ${meta.runtime}: ${meta.sourceUrl}`);
      console.log(`  file: packages/protocol/src/agent-command-catalogs/${meta.file}`);
    }
    console.log(
      "\nRefresh by editing the JSON from the docs table, then run --check.\n" +
        "Optional: schedule this skill / agent job after vendor changelog bumps."
    );
  }

  if (args.has("--check") || args.size === 0) {
    let failed = false;
    for (const meta of EXPECTED) {
      const errors = checkCatalog(meta);
      if (errors.length) {
        failed = true;
        console.error(`FAIL ${meta.file}:`);
        for (const err of errors) console.error(`  - ${err}`);
      } else {
        console.log(`OK   ${meta.file}`);
      }
    }
    if (failed) process.exit(1);
  }
}

main();
