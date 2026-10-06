import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A machine that runs agents for more than one Space must never hold a
 * credential that reaches past the repository it was asked about. These tests
 * pin the mint request itself, because that is where the narrowing happens --
 * once GitHub has issued a wide token, nothing downstream can take it back.
 */
import {
  mintGitHubRepositoryToken,
} from "../src/app-connectors.ts";
import { githubAppEnv, jsonResponse, stubGitHubFetch, stubGitHubInstallation } from "./support/github-app.mjs";

const GITHUB_APP_ENV = await githubAppEnv();

function connection(installationIds) {
  return {
    id: "space-1:github",
    providerId: "github",
    providerName: "GitHub",
    status: "configured",
    metadata: { installationIds },
  };
}

/** Records every GitHub call so a test can assert on the mint body. */

test("the minted token is narrowed to the one repository that was asked for", async () => {
  const github = stubGitHubInstallation({ contents: "write", metadata: "read" }, () => jsonResponse({}), { token: "ghs_scoped", expires_at: "2026-08-06T01:00:00Z" });

  try {
    const grant = await mintConfiguredRepositoryToken();

    const mint = github.calls.find((call) => call.url.includes("/access_tokens"));
    assert.ok(mint, "an installation token must be minted");
    assert.deepEqual(
      mint.body?.repositories,
      ["xmatrix"],
      "the mint must name the single repository, otherwise the token spans the whole installation",
    );
    assert.equal(grant.token, "ghs_scoped");
    assert.equal(grant.expiresAt, "2026-08-06T01:00:00Z");
    assert.deepEqual(grant.repository, { owner: "LambdaLabsHQ", repo: "xmatrix" });
    assert.ok(grant.capabilities.includes("github.contents.write"));
  } finally {
    github.restore();
  }
});

test("a repository outside this Space's installation is refused", async () => {
  const github = stubGitHubFetch((call) => {
    if (call.url.endsWith("/installation")) {
      // The repository resolves to an installation this Space does not own.
      return jsonResponse({ id: 999 });
    }
    if (call.url.includes("/access_tokens")) {
      return jsonResponse({ message: "not accessible" }, 422);
    }
    return jsonResponse({ message: "not found" }, 404);
  });

  try {
    await assert.rejects(
      () => mintGitHubRepositoryToken(GITHUB_APP_ENV, connection(["777"]), "OtherOrg", "secrets"),
      /github_/,
      "a foreign repository must fail at mint time, not later as a Git error",
    );
  } finally {
    github.restore();
  }
});

test("capabilities report what the installation actually granted", async () => {
  const github = stubGitHubInstallation({ contents: "read", metadata: "read" }, () => jsonResponse({}), { token: "ghs_readonly" });

  try {
    const grant = await mintConfiguredRepositoryToken();
    assert.ok(grant.capabilities.includes("github.contents.read"));
    assert.ok(
      !grant.capabilities.includes("github.contents.write"),
      "an unaccepted permission request must surface as a missing capability",
    );
  } finally {
    github.restore();
  }
});

test("a non-GitHub connection cannot mint a repository token", async () => {
  await assert.rejects(
    () => mintGitHubRepositoryToken(
      GITHUB_APP_ENV, { ...connection(["777"]), providerId: "slack" }, "LambdaLabsHQ", "xmatrix",
    ),
    /github_connection_required/,
  );
});

function mintConfiguredRepositoryToken() {
  return mintGitHubRepositoryToken(GITHUB_APP_ENV, connection(["777"]), "LambdaLabsHQ", "xmatrix");
}
