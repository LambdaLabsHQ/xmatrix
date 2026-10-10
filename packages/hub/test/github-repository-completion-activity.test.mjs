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
import { githubAppEnv, githubConnection, jsonResponse } from "./support/github-app.mjs";

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
    owner: { login: fields.owner },
  };
}

function stubInstallationCatalog(repositories) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.includes("/access_tokens")) {
      return jsonResponse({
        token: "ghs_catalog",
        expires_at: "2026-08-17T01:00:00Z",
        permissions: { metadata: "read" },
      });
    }
    if (url.includes("/installation/repositories")) {
      return jsonResponse({ repositories, total_count: repositories.length });
    }
    return jsonResponse({ message: "unexpected" }, 404);
  };
  return {
    restore() {
      globalThis.fetch = original;
    },
  };
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
