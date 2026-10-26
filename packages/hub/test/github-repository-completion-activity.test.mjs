import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * @ mention repo completion must surface recently pushed repositories first.
 * The installation catalog is not already ordered that way, so the Hub owns
 * the sort from GitHub `pushed_at` (then `updated_at`).
 */
import {
  resolveAppConnectorCompletionOptions,
  spaceLaunchTargetRepositories,
} from "../src/app-connectors.ts";
import { githubAppEnv, githubConnection, githubLinkerAnswer, jsonResponse } from "./support/github-app.mjs";

const GITHUB_APP_ENV = await githubAppEnv();

function repo(fields) {
  return {
    id: fields.id,
    name: fields.name,
    full_name: `${fields.owner}/${fields.name}`,
    private: fields.private === true,
    archived: fields.archived === true,
    description: fields.description,
    pushed_at: fields.pushed_at,
    updated_at: fields.updated_at,
    owner: { login: fields.owner, id: fields.ownerId, type: fields.ownerType },
  };
}

function catalogLinkerAnswer(linker, permissionFor) {
  return url => {
    if (url.endsWith(`/user/${linker.githubUserId}`)) return jsonResponse({ id: linker.githubUserId, login: linker.login });
    if (url.endsWith(`/collaborators/${linker.login}/permission`)) return jsonResponse({ permission: permissionFor(url),
      user: { id: linker.githubUserId, login: linker.login } });
  };
}

function stubInstallationCatalog(repositories, answer = githubLinkerAnswer) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    const custom = await answer(url);
    if (custom) return custom;
    if (url.includes("/access_tokens")) {
      return jsonResponse({ token: "ghs_catalog", permissions: { metadata: "read" } });
    }
    if (url.includes("/installation/repositories")) {
      const listed = typeof repositories === "function" ? repositories() : repositories;
      return jsonResponse({ repositories: listed, total_count: listed.length });
    }
    return jsonResponse({ message: "unexpected" }, 404);
  };
  return { restore() { globalThis.fetch = original; } };
}

const CATALOG = [
  repo({
    id: 1,
    owner: "ZebraOrg",
    name: "alpha",
    pushed_at: "2026-01-01T00:00:00Z",
  }),
  repo({
    id: 2,
    owner: "LambdaLabsHQ",
    name: "zebra",
    pushed_at: "2026-08-16T12:00:00Z",
  }),
  repo({
    id: 3,
    owner: "LambdaLabsHQ",
    name: "model-gateway",
    pushed_at: "2026-08-01T00:00:00Z",
    private: true,
    description: "Routes inference requests across model providers",
  }),
  repo({
    id: 4,
    owner: "LambdaLabsHQ",
    name: "old-notes",
    updated_at: "2026-07-15T00:00:00Z",
  }),
  repo({
    id: 5,
    owner: "LambdaLabsHQ",
    name: "archived-lib",
    pushed_at: "2026-08-17T00:00:00Z",
    archived: true,
  }),
];

test("a Space's launch repos are newest-push first, and carry their visibility", async () => {
  const github = stubInstallationCatalog(CATALOG);
  try {
    const repos = await spaceLaunchTargetRepositories(GITHUB_APP_ENV, githubConnection());
    assert.deepEqual(
      repos.map((repository) => repository.value),
      [
        "LambdaLabsHQ/zebra",
        "LambdaLabsHQ/model-gateway",
        "LambdaLabsHQ/old-notes",
        "ZebraOrg/alpha",
      ],
    );
    // An archived repository is not a launch target at all.
    assert.equal(repos.some((repository) => repository.value.endsWith("/archived-lib")), false);
    assert.deepEqual(
      repos.filter((repository) => repository.private).map((repository) => repository.value),
      ["LambdaLabsHQ/model-gateway"],
    );
    assert.equal(repos.find(repository => repository.value === "LambdaLabsHQ/model-gateway").description,
      "Routes inference requests across model providers");
  } finally {
    github.restore();
  }
});

test("owner-scoped repo names keep the same last-push order", async () => {
  const github = stubInstallationCatalog(CATALOG);
  try {
    const options = await resolveAppConnectorCompletionOptions(
      GITHUB_APP_ENV,
      githubConnection(),
      "github-repositories",
      "LambdaLabsHQ",
    );
    assert.deepEqual(
      options.map((option) => option.value),
      ["zebra", "model-gateway", "old-notes"],
    );
  } finally {
    github.restore();
  }
});

test("organization completion stays alphabetical", async () => {
  const github = stubInstallationCatalog(CATALOG);
  try {
    const options = await resolveAppConnectorCompletionOptions(
      GITHUB_APP_ENV,
      githubConnection(),
      "github-organizations",
    );
    assert.deepEqual(
      options.map((option) => option.value),
      ["LambdaLabsHQ", "ZebraOrg"],
    );
  } finally {
    github.restore();
  }
});

// A catalog names private repositories, so it offers each one only while the
// administrator Connect recorded as linking its installation administers it
// now, asked repository by repository: one added to the installation later,
// which they only read, is not named.
test("launch targets and completion offer only repositories the installation's linker administers now", async () => {
  const linker = { githubUserId: 93939, login: "catalog-linker" };
  const github = stubInstallationCatalog([
    repo({ id: 11, owner: "audit-org", name: "permitted", private: true, pushed_at: "2026-08-01T00:00:00Z" }),
    repo({ id: 12, owner: "audit-org", name: "added-later", private: true, pushed_at: "2026-08-02T00:00:00Z",
      description: "not theirs to hand over" }),
  ], catalogLinkerAnswer(linker, url => url.includes("/repos/audit-org/permitted/") ? "admin" : "read"));
  try {
    const connection = githubConnection({ githubLinks: [{ installationId: "777", githubUserId: linker.githubUserId }] });
    assert.deepEqual((await spaceLaunchTargetRepositories(GITHUB_APP_ENV, connection)).map((target) => target.value),
      ["audit-org/permitted"]);
    assert.deepEqual((await resolveAppConnectorCompletionOptions(GITHUB_APP_ENV, connection, "github-repositories",
      "audit-org")).map((option) => option.value), ["permitted"]);
  } finally { github.restore(); }
});

test("personal ownership proves catalog administration by stable id, never by login alone", async () => {
  const linker = { githubUserId: 93939, login: "renamed-owner" };
  const checked = [];
  const github = stubInstallationCatalog([
    repo({ id: 1, owner: "old-login", ownerId: linker.githubUserId, ownerType: "User", name: "owned" }),
    repo({ id: 2, owner: linker.login, ownerId: 222, ownerType: "User", name: "transferred" }),
    repo({ id: 3, owner: linker.login, ownerId: linker.githubUserId, ownerType: "Organization", name: "org" }),
    repo({ id: 4, owner: linker.login, name: "missing-owner-proof" }),
    repo({ id: 5, owner: "old-login", ownerId: linker.githubUserId, ownerType: "User", name: "archived", archived: true }),
  ], catalogLinkerAnswer(linker, url => {
    checked.push(url.split("/")[5]);
    return "read";
  }));
  try {
    const connection = githubConnection({ githubLinks: [{ installationId: "777", githubUserId: linker.githubUserId }] });
    assert.deepEqual((await spaceLaunchTargetRepositories(GITHUB_APP_ENV, connection)).map(target => target.value),
      ["old-login/owned"]);
    assert.deepEqual(checked.sort(), ["missing-owner-proof", "org", "transferred"]);
    assert.deepEqual(await spaceLaunchTargetRepositories(GITHUB_APP_ENV, { ...connection, githubLinks: [] })
      .catch(error => error.message), "github_repository_not_delegated", "ownership never substitutes for a Space's link proof");
  } finally { github.restore(); }
});

test("a slow catalog permission read does not idle the other bounded workers", async () => {
  let releaseSlow;
  const slow = new Promise(resolve => { releaseSlow = resolve; });
  let active = 0, peak = 0;
  const checked = [];
  const repositories = Array.from({ length: 24 }, (_, id) => repo({ id, owner: "org", name: `repo-${id}` }));
  const github = stubInstallationCatalog(repositories, async url => {
    if (url.includes("/collaborators/")) {
      const name = url.split("/")[5];
      checked.push(name);
      active++; peak = Math.max(peak, active);
      if (name === "repo-0") await slow;
      active--;
    }
    return githubLinkerAnswer(url);
  });
  const read = spaceLaunchTargetRepositories(GITHUB_APP_ENV, githubConnection());
  try {
    // Let all non-blocked fetch/body/signing continuations finish without a wall-clock threshold.
    for (let turn = 0; turn < 100 && !checked.includes("repo-23"); turn++) {
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(checked.includes("repo-23"), "later repos must be checked while the first request is still pending");
    assert.ok(peak <= 8, "the catalog keeps its provider concurrency bound");
  } finally {
    releaseSlow();
    const targets = await read;
    github.restore();
    assert.equal(targets.length, repositories.length);
    assert.equal(new Set(checked).size, repositories.length);
  }
});

test("a GitHub event's connection version bypasses a previously authorized edge catalog", async t => {
  const saved = new Map();
  const previousCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");
  t.after(() => {
    if (previousCaches) Object.defineProperty(globalThis, "caches", previousCaches);
    else delete globalThis.caches;
  });
  globalThis.caches = { open: async () => ({
    match: async key => saved.get(key.url)?.clone(),
    put: async (key, response) => { saved.set(key.url, response.clone()); },
  }) };
  let administers = true, catalogs = 0;
  const github = stubInstallationCatalog(() => {
    catalogs++;
    return [repo({ id: 1, owner: "org", name: "private", private: true })];
  }, async url => {
    const answer = githubLinkerAnswer(url);
    if (url.includes("/collaborators/") && !administers) {
      const permission = await answer.json();
      return jsonResponse({ ...permission, permission: "read" });
    }
    return answer;
  });
  t.after(() => github.restore());
  const connection = githubConnection({ version: 1 });
  const targets = await spaceLaunchTargetRepositories(GITHUB_APP_ENV, connection);
  assert.equal(targets.length, 1);
  assert.deepEqual(await spaceLaunchTargetRepositories(GITHUB_APP_ENV, connection), targets);
  assert.equal(catalogs, 1, "the same Space's edge answer is shared");
  administers = false;
  assert.deepEqual(await spaceLaunchTargetRepositories(GITHUB_APP_ENV, { ...connection, version: 2 }), []);
  assert.equal(catalogs, 2, "a processed event cannot reuse the previous authorization hint");
});
