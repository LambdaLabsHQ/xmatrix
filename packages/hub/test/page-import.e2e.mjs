import { withGitHubUserScenario, registeredGitHubPageAgent } from "./support/github-user-worker.mjs";
import {
  admitRegisteredSpawn,
  json,
  randomUUID
} from "./agent-launch-postgres.fixture.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { connectGitHubInstallation } from "./registration-launch.fixture.mjs";

const installationId = "import-installation";
const base64 = (text) => Buffer.from(text).toString("base64");

// Import onboarding end to end: an owner starts from one of the Space's
// repositories, an Agent of theirs is launched in the import conversation with
// the repository's README, documents and open work, and its draft is the
// Space's move to pages for the owner to review.
test("an owner starts the Space's pages from a GitHub repository and an Agent drafts them", async () => {
  const userId = `page-import-${randomUUID()}`;
  const api = { installationId, repository: "acme/widgets",
    permissions: { metadata: "read", contents: "read", issues: "read" }, routes: {
      "/repos/acme/widgets": { description: "Widgets for everyone", default_branch: "main" },
      "/repos/acme/widgets/readme": { path: "README.md", content: base64("# Widgets\n\nBuild with `make`.\n") },
      "/repos/acme/widgets/git/trees/main?recursive=1": { tree: [
        { type: "blob", path: "README.md" }, { type: "blob", path: "docs/roadmap.md" },
        { type: "blob", path: "node_modules/x/README.md" }, { type: "blob", path: "src/index.ts" }] },
      "/repos/acme/widgets/contents/docs/roadmap.md?ref=main": { content: base64("# Roadmap\n\nPrefix search next.\n") },
      "/repos/acme/widgets/issues?state=open&per_page=100": [
        { number: 3, title: "Search is exact-only", html_url: "https://github.com/acme/widgets/issues/3",
          labels: [{ name: "search" }], body: "Users want prefix search." },
        { number: 4, title: "Add prefix search", html_url: "https://github.com/acme/widgets/pull/4",
          pull_request: {}, labels: [], body: "" }],
    } };
  await withGitHubUserScenario({ id: userId, email: "page-import@example.com", name: "Page Import" }, api, undefined,
    async ({ worker, auth }) => {
  let daemon;
  try {
    const registered = await registeredGitHubPageAgent(worker, userId, auth, { slug: "import", displayName: "importer" });
    ({ daemon } = registered);
    const { home, spaceId } = registered;
    await connectGitHubInstallation(worker, { spaceId, userId, installationId });

    const route = `/api/spaces/${encodeURIComponent(spaceId)}/page-migration`;
    const repositories = await json(await worker.fetch(`${route}/import/repositories`, { headers: auth }));
    assert.deepEqual(repositories.repos.map((repo) => repo.value), ["acme/widgets"]);

    const spawn = daemon.inbox.waitFor((message) => message.type === "machine_spawn_agent"
      && message.channelId !== home.id, "import spawn");
    const started = await worker.fetch(`${route}/import`, { method: "POST", headers: auth,
      body: JSON.stringify({ repository: "acme/widgets" }) });
    assert.equal(started.status, 200, await started.clone().text());
    const { conversationId } = await started.json();
    const command = await spawn;
    assert.equal(command.channelId, conversationId, "the Agent works in the import conversation");
    assert.match(command.prompt, /Draft this Space's first page tree from the GitHub repository acme\/widgets/u);
    assert.match(command.prompt, /Build with `make`/u, "it reads the README");
    assert.match(command.prompt, /### docs\/roadmap\.md\n\n# Roadmap/u, "and the repository's documents");
    assert.doesNotMatch(command.prompt, /node_modules/u);
    assert.match(command.prompt, /Issue #3 Search is exact-only \[search\]/u);
    assert.match(command.prompt, /PR #4 Add prefix search/u);

    // The Agent submits its draft like any move to pages; the owner reviews it.
    const runToken = await admitRegisteredSpawn(worker, daemon, command);
    const asRun = { Authorization: `Bearer ${runToken}`, "content-type": "application/json" };
    const submitted = await worker.fetch(`${route}/draft`, { method: "PUT", headers: asRun, body: JSON.stringify({
      version: 0, draft: { pages: [{ key: "widgets", parentKey: null, title: "Widgets",
        body: "# Widgets\n\nPrefix search next (#3, #4).\n", sources: [] }] } }) });
    assert.equal(submitted.status, 200, await submitted.clone().text());
    const draft = await json(await worker.fetch(route, { headers: auth }));
    assert.equal(draft.state, "proposed");
    assert.deepEqual(draft.draft.pages.map((page) => page.title), ["Widgets"]);

    const again = await worker.fetch(`${route}/import`, { method: "POST", headers: auth,
      body: JSON.stringify({ repository: "acme/widgets" }) });
    assert.equal((await again.json()).conversationId, conversationId, "asking again reuses the import conversation");
  } finally { daemon?.ws?.close(); }
  });
});
