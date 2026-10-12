import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPageHistory, commitFiles, commitParents, pagePaths, pageSlug, readPack, writePack } from "../src/page-git.ts";
import { splitFrontmatter, unlinkPages } from "../src/page-okf.ts";

const pages = [
  { pageId: "p-company", parentPageId: null, title: "Company", position: "V" },
  { pageId: "p-relay", parentPageId: "p-company", title: "Relay service", position: "V" },
  { pageId: "p-relay-2", parentPageId: "p-company", title: "Relay Service", position: "X" },
  { pageId: "p-notes", parentPageId: null, title: "笔记 / Notes", position: "X" },
];
const revision = (pageId, revision, body, createdAt, author = { kind: "user", id: "u1", label: "Yiming" }) =>
  ({ pageId, revision, body, authors: [author], conversationIds: ["c1"], createdAt });
const revisions = [
  revision("p-company", 1, "# Company\n\nWe build page:p-relay and page:p-hidden.\n", "2026-09-27T01:00:00.000Z"),
  revision("p-relay", 1, "# Relay\n\nDraft.\n", "2026-09-27T02:00:00.000Z"),
  revision("p-relay", 2, "# Relay\n\nShipped.\n", "2026-09-27T03:00:00.000Z",
    { kind: "agent", id: "space:c1:1", label: "claude" }),
  revision("p-notes", 1, "# Notes\n", "2026-09-27T04:00:00.000Z"),
  revision("p-hidden", 1, "# Secret\n", "2026-09-27T05:00:00.000Z"),
];

test("page paths follow the tree: a page with pages below it is a directory", () => {
  const paths = pagePaths(pages);
  assert.equal(paths.get("p-company").file, "company.md");
  assert.equal(paths.get("p-company").dir, "company/");
  assert.equal(paths.get("p-relay").file, "company/relay-service.md");
  assert.equal(paths.get("p-relay-2").file, "company/relay-service-p-relay-.md", "a clashing title is told apart");
  assert.equal(paths.get("p-notes").file, "笔记-notes.md");
  assert.equal(pageSlug("  ??? "), "page");
  const reserved = pagePaths([{ pageId: "p-index", parentPageId: null, title: "Index", position: "V" }]);
  assert.equal(reserved.get("p-index").file, "index-p-index.md", "OKF's reserved names are never pages");
});

const bundle = { heading: "Acme", resource: (pageId) => `https://xmatrix.example/app/s1/pages?page=${pageId}` };

test("history is deterministic and git reads it: one commit per revision, only readable pages", async () => {
  const first = await buildPageHistory(pages, revisions, bundle);
  const second = await buildPageHistory(pages, [...revisions].reverse(), bundle);
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
    assert.equal(splitFrontmatter(git("show", "main:company/relay-service.md")).body, "# Relay\n\nShipped.\n");
    assert.equal(splitFrontmatter(git("show", "main~2:company/relay-service.md")).body, "# Relay\n\nDraft.\n");
    assert.doesNotMatch(git("log", "-p", "main"), /Secret/u, "a page the reader cannot read never appears");
    assert.match(git("log", "-1", "--format=%B", "main~1"), /xMatrix-Page: p-relay\nxMatrix-Revision: 2\nxMatrix-Conversation: c1/u);
    assert.deepEqual(git("-c", "core.quotepath=off", "ls-tree", "-r", "--name-only", "main").trim().split("\n"),
      ["company.md", "company/index.md", "company/relay-service.md", "index.md", "笔记-notes.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the history is an Open Knowledge Format bundle: concepts with frontmatter, linked, indexed", async () => {
  const { head, objects } = await buildPageHistory(pages, revisions, bundle);
  const files = new Map([...commitFiles(head, (sha) => objects.get(sha))]
    .map(([path, bytes]) => [path, new TextDecoder().decode(bytes)]));
  assert.equal(files.get("company/relay-service.md"), [
    "---",
    "type: xMatrix Page",
    'title: "Relay service"',
    'description: "Shipped."',
    'resource: "https://xmatrix.example/app/s1/pages?page=p-relay"',
    'generated: { by: "claude/xmatrix", at: 2026-09-27T03:00:00.000Z }',
    'xmatrix_page: "p-relay"',
    "xmatrix_revision: 2",
    "---",
    "# Relay", "", "Shipped.", "",
  ].join("\n"));
  assert.match(files.get("company.md"), /generated: \{ by: "human:u1", at: 2026-09-27T01:00:00.000Z \}/u);
  const company = splitFrontmatter(files.get("company.md")).body;
  assert.equal(company, "# Company\n\nWe build [page:p-relay](/company/relay-service.md) and page:p-hidden.\n",
    "a page reference is a bundle link; a page the reader cannot read stays as written");
  const pageByFile = new Map([...pagePaths(pages)].map(([pageId, place]) => [place.file, pageId]));
  assert.equal(unlinkPages(company, "company.md", pageByFile), "# Company\n\nWe build page:p-relay and page:p-hidden.\n");
  assert.equal(files.get("index.md"), [
    "---", 'okf_version: "0.2"', "---", "# Acme", "",
    "* [Company](company.md) - We build page:p-relay and page:p-hidden.",
    "* [Company](company/) - The pages below Company.",
    "* [笔记 / Notes](笔记-notes.md)", "",
  ].join("\n"));
  assert.equal(files.get("company/index.md"),
    "# Company\n\n* [Relay service](relay-service.md) - Shipped.\n");
  for (const [path, text] of files) {
    if (path.endsWith("index.md")) continue;
    assert.match(splitFrontmatter(text).frontmatter ?? "", /^type: \S/mu, `${path} is a conformant concept`);
  }
});

test("pushed links resolve relative and bundle-absolute paths back to page references", () => {
  const pageByFile = new Map([["tables/orders.md", "p-orders"], ["tables/customers.md", "p-customers"]]);
  assert.equal(unlinkPages("Join [customers](customers.md#keys) and [orders](/tables/orders.md), " +
    "see [docs](https://example.com/a.md) and [gone](../nope.md).", "tables/orders.md", pageByFile),
  "Join [customers](page:p-customers#keys) and [orders](page:p-orders), " +
    "see [docs](https://example.com/a.md) and [gone](../nope.md).");
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
    writeFileSync(path.join(dir, "company", "relay.md"), long);
    git("add", "."); git("commit", "-q", "-m", "one");
    writeFileSync(path.join(dir, "company", "relay.md"), `${long}changed\n`);
    git("add", "."); git("commit", "-q", "-m", "two");
    const head = git("rev-parse", "HEAD").trim();
    const pack = execFileSync("git", ["-C", dir, "pack-objects", "--stdout", "--revs", "--delta-base-offset"],
      { input: `${head}\n` });
    const objects = await readPack(new Uint8Array(pack), new Map());
    assert.equal(objects.get(head).type, "commit");
    const files = commitFiles(head, (sha) => objects.get(sha));
    assert.equal(new TextDecoder().decode(files.get("company/relay.md")), `${long}changed\n`);
    assert.equal(commitParents(head, (sha) => objects.get(sha)).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
