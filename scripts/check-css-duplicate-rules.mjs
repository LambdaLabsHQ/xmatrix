#!/usr/bin/env node
/**
 * Fail if one stylesheet declares the same rule twice — the same at-rule
 * context, the same selector list, and the same declarations.
 *
 * A later identical rule always wins the cascade, so the earlier copy can only
 * make the sheet harder to read; nothing about the page changes when it goes.
 * This is how the light and wood theme blocks in globals.css ended up repeating
 * the same glass rules byte for byte.
 *
 * Comparing the enclosing at-rule too keeps this honest: the same selector at
 * a different breakpoint, theme, or keyframes block is a different rule, and a
 * re-declaration with different declarations is a real override, not noise.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function stripComments(text) {
  let out = "";
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inComment) {
      if (ch === "*" && text[i + 1] === "/") {
        inComment = false;
        i++;
      } else if (ch === "\n") {
        out += ch;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      inComment = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Split a stylesheet into rules. Returns `{ selector, body, line, context }`
 * for every qualified rule, with `context` the joined enclosing at-rule
 * preludes. Comments are removed before comparison, and a rule is only ever
 * paired with one in the same context.
 */
export function cssRules(text) {
  const source = stripComments(text);
  const rules = [];
  const stack = [];
  let buffer = "";
  let line = 1;
  let startLine = 1;
  let quote = null;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === "\n") line++;
    if (quote) {
      buffer += ch;
      if (ch === "\\") {
        buffer += source[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buffer += ch;
      continue;
    }
    if (ch === "{") {
      const selector = buffer.replace(/\s+/gu, " ").trim();
      stack.push({
        selector,
        isAt: selector.startsWith("@"),
        startLine,
        bodyStart: i + 1,
        context: stack.filter((frame) => frame.isAt).map((frame) => frame.selector).join(" && "),
      });
      buffer = "";
      startLine = line + 1;
      continue;
    }
    if (ch === "}") {
      const frame = stack.pop();
      if (frame && !frame.isAt) {
        rules.push({
          selector: frame.selector,
          body: source.slice(frame.bodyStart, i).replace(/\s+/gu, " ").trim(),
          line: frame.startLine,
          endLine: line,
          context: frame.context,
        });
      }
      buffer = "";
      startLine = line + 1;
      continue;
    }
    if (ch === ";") {
      buffer = "";
      startLine = line + 1;
      continue;
    }
    if (buffer.trim() === "") startLine = line;
    buffer += ch;
  }
  return rules;
}

/**
 * Return every rule that an identical later rule already covers. Only the
 * earlier copy is reported — deleting it leaves the later copy to win exactly
 * as before.
 */
export function duplicateCssRules(text) {
  const rules = cssRules(text);
  const seen = new Map();
  for (const rule of rules) {
    const key = `${rule.context}\u0000${rule.selector}\u0000${rule.body}`;
    const list = seen.get(key);
    if (list) list.push(rule);
    else seen.set(key, [rule]);
  }
  const duplicates = [];
  for (const list of seen.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length - 1; i++) duplicates.push(list[i]);
  }
  return duplicates.sort((a, b) => a.line - b.line);
}

export function duplicateCssFiles(files) {
  const found = [];
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const rule of duplicateCssRules(fs.readFileSync(file, "utf8"))) {
      found.push({ file, line: rule.line, selector: rule.selector, context: rule.context });
    }
  }
  return found;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const files = execFileSync("git", ["ls-files", "-z", "--", "apps", "packages"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => file.endsWith(".css") && fs.existsSync(file));
  const found = duplicateCssFiles(files);
  if (found.length) {
    for (const entry of found) {
      const where = entry.context ? ` inside ${entry.context}` : "";
      console.error(`${entry.file}:${entry.line} repeats an identical rule${where}: ${entry.selector}`);
    }
    console.error(`${found.length} duplicate rule(s): keep the last copy, delete the rest.`);
    process.exit(1);
  }
  console.log("OK: no duplicate rules in", files.length, "stylesheets");
}
