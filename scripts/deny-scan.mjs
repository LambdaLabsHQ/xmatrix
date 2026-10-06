#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The scan that refuses a tree carrying a deployment's identifiers or any
 * credential. The public snapshot export runs it on the exported tree; the
 * public repository runs it on every pull request, with the identifiers from
 * its XMATRIX_DENY_IDENTIFIERS secret.
 */
export const SECRET_PATTERNS = Object.freeze([
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----(?:\s|\\n)*[A-Za-z0-9+/]{40,}/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/u],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/u],
  ["OpenAI key", /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["Slack token", /\bxox[abprs]-\d{6,}-[A-Za-z0-9-]{10,}\b/u],
  ["Stripe live key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
]);

// Findings name the file and a redacted value, so a refusal's log never
// repeats the identifier it caught.
function redact(value) {
  return `${value.slice(0, 3)}…(${value.length})`;
}

/** Findings in one file's text. */
export function scanText(file, text, identifiers) {
  const findings = [];
  const lower = text.toLowerCase();
  for (const value of identifiers) {
    if (lower.includes(value.toLowerCase())) findings.push({ file, kind: "deployment identifier", value: redact(value) });
  }
  for (const [kind, pattern] of SECRET_PATTERNS) {
    const match = text.match(pattern);
    if (match) findings.push({ file, kind, value: redact(match[0]) });
  }
  return findings;
}

/** Every finding in the given files (paths relative to `root`); binary files are skipped. */
export function scanFiles(root, files, identifiers) {
  const findings = [];
  for (const file of files) {
    const buffer = readFileSync(join(root, file));
    if (buffer.includes(0)) continue;
    findings.push(...scanText(file, buffer.toString("utf8"), identifiers));
  }
  return findings;
}

/** Every finding under a directory. */
export function scanDirectory(directory, identifiers) {
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else files.push(relative(directory, path));
    }
  };
  visit(directory);
  return scanFiles(directory, files, identifiers);
}

/** Identifiers as a JSON array or one per line; short values would match everywhere and are refused. */
export function parseIdentifiers(value) {
  const text = (value ?? "").trim();
  if (!text) return [];
  const list = text.startsWith("[") ? JSON.parse(text) : text.split("\n");
  const identifiers = list.map((entry) => String(entry).trim()).filter(Boolean);
  const short = identifiers.filter((entry) => entry.length < 6);
  if (short.length) throw new Error(`${short.length} deny identifier(s) are shorter than 6 characters`);
  return identifiers;
}

function main() {
  const root = resolve(process.argv[2] ?? ".");
  const identifiers = parseIdentifiers(process.env.XMATRIX_DENY_IDENTIFIERS);
  if (!identifiers.length && process.env.XMATRIX_DENY_REQUIRE_IDENTIFIERS === "true") {
    throw new Error("XMATRIX_DENY_IDENTIFIERS is empty; the scan cannot check deployment identifiers");
  }
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const findings = scanFiles(root, files, identifiers);
  for (const finding of findings) process.stderr.write(`${finding.file}: ${finding.kind} ${finding.value}\n`);
  process.stdout.write(`${files.length} files, ${identifiers.length} identifiers, ${findings.length} finding(s)\n`);
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
