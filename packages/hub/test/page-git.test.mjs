import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPageHistory, commitFiles, commitParents, pagePaths, pageSlug, readPack, writePack } from "../src/page-git.ts";

const pages = [
  { pageId: "p-company", parentPageId: null, title: "Company", position: "V" },
  { pageId: "p-relay", parentPageId: "p-company", title: "Relay service", position: "V" },
  { pageId: "p-relay-2", parentPageId: "p-company", title: "Relay Service", position: "X" },
  { pageId: "p-notes", parentPageId: null, title: "笔记 / Notes", position: "X" },
];
const revision = (pageId, revision, body, createdAt, author = { kind: "user", id: "u1", label: "Yiming" }) =>
  ({ pageId, revision, body, authors: [author], conversationIds: ["c1"], createdAt });
const revisions = [
  revision("p-company", 1, "# Company\n", "2026-09-27T01:00:00.000Z"),
  revision("p-relay", 1, "# Relay\n\nDraft.\n", "2026-09-27T02:00:00.000Z"),
  revision("p-relay", 2, "# Relay\n\nShipped.\n", "2026-09-27T03:00:00.000Z",
    { kind: "agent", id: "space:c1:1", label: "claude" }),
  revision("p-notes", 1, "# Notes\n", "2026-09-27T04:00:00.000Z"),
  revision("p-hidden", 1, "# Secret\n", "2026-09-27T05:00:00.000Z"),
];

test("page paths follow the tree: a page with pages below it is a directory", () => {
  const paths = pagePaths(pages);
  assert.equal(paths.get("p-company").file, "company/README.md");
  assert.equal(paths.get("p-relay").file, "company/relay-service.md");
  assert.equal(paths.get("p-relay-2").file, "company/relay-service-p-relay-.md", "a clashing title is told apart");
  assert.equal(paths.get("p-notes").file, "笔记-notes.md");
  assert.equal(pageSlug("  ??? "), "page");
});

test("history is deterministic and git reads it: one commit per revision, only readable pages", async () => {
  const first = await buildPageHistory(pages, revisions);
  const second = await buildPageHistory(pages, [...revisions].reverse());
  assert.equal(first.head, second.head, "the same pages and revisions give the same commits");
  const dir = mkdtempSync(path.join(tmpdir(), "page-git-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    execFileSync("git", ["init", "-q", "--bare", dir]);
    execFileSync("git", ["-C", dir, "index-pack", "--stdin"], { input: await writePack(first.objects) });
    git("update-ref", "refs/heads/main", first.head);
    assert.equal(git("fsck", "--strict", "--no-dangling").trim(), "");
    assert.deepEqual(git("log", "--format=%s|%an", "main").trim().split("\n"),
      ["笔记 / Notes r1|Yiming", "Relay service r2|claude", "Relay service r1|Yiming", "Company r1|Yiming"]);
    assert.equal(git("show", "main:company/relay-service.md"), "# Relay\n\nShipped.\n");
    assert.equal(git("show", "main~2:company/relay-service.md"), "# Relay\n\nDraft.\n");
    assert.doesNotMatch(git("log", "-p", "main"), /Secret/u, "a page the reader cannot read never appears");
    assert.match(git("log", "-1", "--format=%B", "main~1"), /xMatrix-Page: p-relay\nxMatrix-Revision: 2\nxMatrix-Conversation: c1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pack git writes, deltas included, reads back to the same commits and files", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "page-git-pack-"));
  try {
    const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "A", GIT_AUTHOR_EMAIL: "a@x", GIT_COMMITTER_NAME: "A",
        GIT_COMMITTER_EMAIL: "a@x" } });
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const long = "line of a long page\n".repeat(400);
    mkdirSync(path.join(dir, "company"));
    writeFileSync(path.join(dir, "company", "README.md"), long);
    git("add", "."); git("commit", "-q", "-m", "one");
    writeFileSync(path.join(dir, "company", "README.md"), `${long}changed\n`);
    git("add", "."); git("commit", "-q", "-m", "two");
    const head = git("rev-parse", "HEAD").trim();
    const pack = execFileSync("git", ["-C", dir, "pack-objects", "--stdout", "--revs", "--delta-base-offset"],
      { input: `${head}\n` });
    const objects = await readPack(new Uint8Array(pack), new Map());
    assert.equal(objects.get(head).type, "commit");
    const files = commitFiles(head, (sha) => objects.get(sha));
    assert.equal(new TextDecoder().decode(files.get("company/README.md")), `${long}changed\n`);
    assert.equal(commitParents(head, (sha) => objects.get(sha)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
