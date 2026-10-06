import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { json, MOCK_TOKEN, randomUUID, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";

// `git clone` of the page store, with an xMatrix token as the password.
test("a member clones, pulls and pushes their Space's pages over git", async () => {
  const userId = `page-git-${randomUUID()}`;
  const worker = await startPgHubWorker({ vars: {
    XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN, XMATRIX_MOCK_AUTH_USER_ID: userId,
    XMATRIX_MOCK_AUTH_EMAIL: "page-git@example.com", XMATRIX_MOCK_AUTH_NAME: "Page Git",
  } });
  const dir = mkdtempSync(path.join(tmpdir(), "page-git-clone-"));
  try {
    const auth = { Authorization: `Bearer ${MOCK_TOKEN}`, "content-type": "application/json" };
    const space = (await json(await worker.fetch("/api/spaces", { method: "POST", headers: auth,
      body: JSON.stringify({ name: `Git ${randomUUID()}` }) }))).space;
    const pages = `/api/spaces/${encodeURIComponent(space.id)}/pages`;
    const create = async (title, extra = {}) => (await json(await worker.fetch(pages, { method: "POST", headers: auth,
      body: JSON.stringify({ title, body: `# ${title}\n\nWhere it stands.\n`, ...extra }) }))).page;
    const company = await create("Company");
    await create("Relay", { parentPageId: company.pageId });

    const host = worker.address.includes(":") ? `[${worker.address}]` : worker.address;
    const remote = `http://git:${MOCK_TOKEN}@${host}:${worker.port}/git/${encodeURIComponent(space.id)}.git`;
    const git = (...args) => execFileSync("git", args, { encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const clone = path.join(dir, "pages");
    git("clone", "-q", remote, clone);
    assert.equal(readFileSync(path.join(clone, "company", "README.md"), "utf8"), "# Company\n\nWhere it stands.\n");
    assert.equal(readFileSync(path.join(clone, "company", "relay.md"), "utf8"), "# Relay\n\nWhere it stands.\n");
    assert.equal(git("-C", clone, "log", "--format=%s").trim().split("\n").length, 2);

    // A new revision arrives as the next commit.
    const read = await json(await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { headers: auth }));
    const edited = await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { method: "PUT", headers: auth,
      body: JSON.stringify({ baseRevision: read.page.headRevision, body: "# Company\n\nShipping pages.\n" }) });
    assert.equal(edited.status, 200, await edited.clone().text());
    git("-C", clone, "pull", "-q", "--ff-only");
    assert.equal(readFileSync(path.join(clone, "company", "README.md"), "utf8"), "# Company\n\nShipping pages.\n");

    // A push is an ordinary edit: changed pages get a revision by the pusher, a new file is a new page.
    const commit = (message) => git("-C", clone, "-c", "user.name=Page Git", "-c", "user.email=g@x",
      "commit", "-q", "-am", message);
    writeFileSync(path.join(clone, "company", "README.md"), "# Company\n\nPages ship this week.\n");
    writeFileSync(path.join(clone, "company", "roadmap.md"), "# Roadmap\n\nPublic pages, then git.\n");
    git("-C", clone, "add", "company/roadmap.md");
    commit("Update the company page and add the roadmap");
    git("-C", clone, "push", "-q", "origin", "main");
    const tree = await json(await worker.fetch(pages, { headers: auth }));
    const roadmap = tree.pages.find((page) => page.title === "Roadmap");
    assert.equal(roadmap.parentPageId, company.pageId, "a file in a page's directory is a page below it");
    const pushed = await json(await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { headers: auth }));
    assert.equal(pushed.page.body, "# Company\n\nPages ship this week.\n");
    assert.equal(pushed.page.revisionInfo.authors[0].id, userId, "the pusher is the author");
    // The Hub's own commits replace the pushed one; a rebase finds nothing left to apply.
    git("-C", clone, "pull", "-q", "--rebase");
    assert.equal(git("-C", clone, "status", "--porcelain").trim(), "");
    assert.equal(readFileSync(path.join(clone, "company", "roadmap.md"), "utf8"), "# Roadmap\n\nPublic pages, then git.\n");

    // Removing a page is done in xMatrix, and a push that is behind is refused until it pulls.
    git("-C", clone, "rm", "-q", "company/roadmap.md");
    commit("Remove the roadmap");
    assert.throws(() => git("-C", clone, "push", "-q", "origin", "main"), /remove or move pages in xMatrix/u);
    git("-C", clone, "reset", "-q", "--hard", "origin/main");

    // Without a token there is nothing to read.
    assert.throws(() => git("ls-remote", remote.replace(`git:${MOCK_TOKEN}@`, "")), /Authentication failed|could not read/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await worker.stop();
  }
});
