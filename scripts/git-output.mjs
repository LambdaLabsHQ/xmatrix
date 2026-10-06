import { execFileSync } from "node:child_process";

/** Read trimmed Git text with the caller's process and error-output policy. */
export function gitOutput(root, args, options = {}) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", ...options }).trim();
}
