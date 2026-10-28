import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampVersionText, versionedPaths } from "./version.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function fixtureRepository({ scripts = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "xmatrix-release-commit-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("config", "commit.gpgsign", "false");
  for (const file of [...versionedPaths, ...scripts]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), readFileSync(path.join(repoRoot, file), "utf8"));
  }
  writeFileSync(path.join(root, "source.txt"), "source\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "source");
  const commit = (message, edit) => {
    edit();
    git("commit", "--quiet", "--all", "--message", message);
    return git("rev-parse", "HEAD");
  };
  const stamp = (next) => () => {
    for (const file of versionedPaths) {
      const target = path.join(root, file);
      writeFileSync(target, stampVersionText(file, readFileSync(target, "utf8"), next));
    }
  };
  // A release cut from `base`: its version stamp, plus newer main content when `carry` is set.
  const cut = (base, next, { carry = false } = {}) => {
    git("checkout", "--quiet", "--detach", base);
    return commit(`Release ${next}`, () => {
      stamp(next)();
      if (carry) writeFileSync(path.join(root, "source.txt"), "later\n");
    });
  };
  return { root, git, commit, stamp, cut, source: git("rev-parse", "HEAD") };
}

