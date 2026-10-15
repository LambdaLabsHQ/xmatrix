import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { json, MOCK_TOKEN, randomUUID, startPgHubWorker } from "./agent-launch-postgres.fixture.mjs";
import { splitFrontmatter } from "../src/page-okf.ts";

const textOf = (file) => splitFrontmatter(readFileSync(file, "utf8")).body;

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
    assert.equal(textOf(path.join(clone, "company.md")), "# Company\n\nWhere it stands.\n");
    assert.equal(textOf(path.join(clone, "company", "relay.md")), "# Relay\n\nWhere it stands.\n");
    assert.match(readFileSync(path.join(clone, "company.md"), "utf8"),
      new RegExp(`^---\ntype: xMatrix Page\ntitle: "Company"\n[^]*resource: ".*/pages\\?page=${company.pageId}"\n[^]*generated: \\{ by: "human:${userId}", at: \\S+ \\}\n`, "u"),
      "every page is an OKF concept");
    assert.match(readFileSync(path.join(clone, "index.md"), "utf8"), /^---\nokf_version: "0\.2"\n---\n# Git /u);
    assert.equal(git("-C", clone, "log", "--format=%s").trim().split("\n").length, 2);

    // A new revision arrives as the next commit.
    const read = await json(await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { headers: auth }));
    const edited = await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { method: "PUT", headers: auth,
      body: JSON.stringify({ baseRevision: read.page.headRevision, body: "# Company\n\nShipping pages.\n" }) });
    assert.equal(edited.status, 200, await edited.clone().text());
    git("-C", clone, "pull", "-q", "--ff-only");
    assert.equal(textOf(path.join(clone, "company.md")), "# Company\n\nShipping pages.\n");

    // A push is an ordinary edit: changed pages get a revision by the pusher, a new file is a new page.
    const commit = (message) => git("-C", clone, "-c", "user.name=Page Git", "-c", "user.email=g@x",
      "commit", "-q", "-am", message);
    const companyFile = path.join(clone, "company.md");
    const companyText = readFileSync(companyFile, "utf8");
    writeFileSync(companyFile, companyText.replace("# Company\n\nShipping pages.",
      "# Company\n\nPages ship this week, see [the roadmap](company/roadmap.md)."));
    writeFileSync(path.join(clone, "company", "roadmap.md"), "# Roadmap\n\nPublic pages, then git.\n");
    git("-C", clone, "add", "company/roadmap.md");
    commit("Update the company page and add the roadmap");
    git("-C", clone, "push", "-q", "origin", "main");
    const tree = await json(await worker.fetch(pages, { headers: auth }));
    const roadmap = tree.pages.find((page) => page.title === "Roadmap");
    assert.equal(roadmap.parentPageId, company.pageId, "a file in a page's directory is a page below it");
    const pushed = await json(await worker.fetch(`${pages}/${encodeURIComponent(company.pageId)}`, { headers: auth }));
    assert.equal(pushed.page.body, `# Company\n\nPages ship this week, see [the roadmap](page:${roadmap.pageId}).\n`,
      "a link to a page the same push creates reads as a page reference");
    assert.equal(pushed.page.revisionInfo.authors[0].id, userId, "the pusher is the author");
    // The Hub's own commits replace the pushed one: its new page now carries
    // frontmatter, so the clone takes the Hub's side of that file.
    git("-C", clone, "pull", "-q", "--rebase", "-X", "ours");
    assert.equal(git("-C", clone, "status", "--porcelain").trim(), "");
    assert.equal(git("-C", clone, "rev-parse", "HEAD").trim(), git("-C", clone, "rev-parse", "origin/main").trim());
    assert.equal(textOf(path.join(clone, "company", "roadmap.md")), "# Roadmap\n\nPublic pages, then git.\n");

    // The frontmatter is xMatrix's: a rename is done in xMatrix, not by a push.
    writeFileSync(companyFile, readFileSync(companyFile, "utf8").replace('title: "Company"', 'title: "Acme"'));
    commit("Rename the company page");
    assert.throws(() => git("-C", clone, "push", "-q", "origin", "main"), /xMatrix writes the frontmatter/u);
    git("-C", clone, "reset", "-q", "--hard", "origin/main");

    // An OKF bundle pushed in reads as its concepts: index.md is never a page, a
    // directory no page owns becomes one, and links between the files become references.
    mkdirSync(path.join(clone, "sales", "tables"), { recursive: true });
    writeFileSync(path.join(clone, "sales", "index.md"), "# Sales\n\n* [Tables](tables/)\n");
    writeFileSync(path.join(clone, "sales", "tables", "index.md"), "# Tables\n\n* [Orders](orders.md)\n");
    writeFileSync(path.join(clone, "sales", "tables", "orders.md"),
      "---\ntype: BigQuery Table\ntitle: Customer Orders\n---\n# Schema\n\nJoined with [customers](customers.md).\n");
    writeFileSync(path.join(clone, "sales", "tables", "customers.md"),
      "---\ntype: BigQuery Table\ntitle: 'Customers'\n---\nOne row per customer; see [orders](/sales/tables/orders.md).\n");
    git("-C", clone, "add", "sales");
    commit("Bring in the sales bundle");
    git("-C", clone, "push", "-q", "origin", "main");
    const imported = (await json(await worker.fetch(pages, { headers: auth }))).pages;
    const byTitle = (title) => imported.find((page) => page.title === title);
    // A page is named by the top-level heading its document opens with, over its frontmatter title.
    assert.equal(byTitle("sales").parentPageId, null);
    assert.equal(byTitle("tables").parentPageId, byTitle("sales").pageId);
    assert.equal(byTitle("Schema").parentPageId, byTitle("tables").pageId);
    assert.equal(imported.filter((page) => page.title === "index").length, 0, "index.md is never a page");
    const orders = await json(await worker.fetch(`${pages}/${encodeURIComponent(byTitle("Schema").pageId)}`, { headers: auth }));
    assert.equal(orders.page.body, `# Schema\n\nJoined with [customers](page:${byTitle("Customers").pageId}).\n`);
    const customers = await json(await worker.fetch(`${pages}/${encodeURIComponent(byTitle("Customers").pageId)}`, { headers: auth }));
    // A file that opens with no heading is named by its frontmatter title, written into its document.
    assert.equal(customers.page.body,
      `# Customers\n\nOne row per customer; see [orders](page:${byTitle("Schema").pageId}).\n`);
    git("-C", clone, "fetch", "-q");
    git("-C", clone, "reset", "-q", "--hard", "origin/main");
    assert.equal(textOf(path.join(clone, "sales", "tables", "schema.md")),
      "# Schema\n\nJoined with [customers](/sales/tables/customers.md).\n");

    // Removing a page is done in xMatrix, and a push that is behind is refused until it pulls.
    git("-C", clone, "rm", "-q", "company/roadmap.md");
    writeFileSync(path.join(clone, "company", "index.md"), "# Company\n");
    git("-C", clone, "add", "company/index.md");
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
