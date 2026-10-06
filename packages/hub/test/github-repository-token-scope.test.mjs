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

test("the mint asks only for what Git needs, never workflows, Actions or secrets", async () => {
  const github = stubGitHubInstallation({ contents: "write", metadata: "read" }, () => jsonResponse({}));
  try {
    await mintConfiguredRepositoryToken();
    const mint = github.calls.find((call) => call.url.includes("/access_tokens"));
    assert.deepEqual(mint.body?.permissions, { contents: "write", metadata: "read" });
  } finally {
    github.restore();
  }
});

test("an installation without contents write still gets a read token", async () => {
  const github = stubGitHubFetch((call) => {
    if (call.url.endsWith("/installation")) return jsonResponse({ id: 777 });
    if (call.url.includes("/access_tokens")) {
      return call.body?.permissions?.contents === "write"
        ? jsonResponse({ message: "The permissions requested are not granted to this installation." }, 422)
        : jsonResponse({ token: "ghs_read", permissions: { contents: "read", metadata: "read" } });
    }
    return jsonResponse({}, 404);
  });
  try {
    const grant = await mintConfiguredRepositoryToken();
    assert.equal(grant.token, "ghs_read");
    assert.ok(!grant.capabilities.includes("github.contents.write"));
  } finally {
    github.restore();
  }
});

test("a repository of an unconnected installation gets the precise refusal, with no probing", async () => {
  const github = stubGitHubFetch((call) => {
    if (call.url.endsWith("/installation")) return jsonResponse({ id: 999 });
    if (call.url.includes("/access_tokens")) return jsonResponse({ token: "ghs_wrong" });
    return jsonResponse({ full_name: "OtherOrg/secrets" });
  });
  try {
    await assert.rejects(
      () => mintGitHubRepositoryToken(GITHUB_APP_ENV, connection(["777"]), "OtherOrg", "secrets"),
      { message: "github_installation_not_linked_to_space" },
    );
    assert.ok(!github.calls.some((call) => call.url.includes("/access_tokens")),
      "the Space's own installations must not be tried for a repository GitHub placed elsewhere");
  } finally {
    github.restore();
  }
});

test("a repository the App is not installed on is named as such", async () => {
  const github = stubGitHubFetch(() => jsonResponse({ message: "Not Found" }, 404));
  try {
    await assert.rejects(
      () => mintConfiguredRepositoryToken(),
      { message: "github_repository_not_installed" },
    );
    assert.ok(!github.calls.some((call) => call.url.includes("/access_tokens")));
  } finally {
    github.restore();
  }
});

test("when the lookup is down, a same-named repository of another owner is not accepted", async () => {
  const github = stubGitHubFetch((call) => {
    if (call.url.endsWith("/installation")) return jsonResponse({ message: "unavailable" }, 502);
    if (call.url.includes("/access_tokens")) {
      // Installation 777 belongs to OtherOrg and also has a repository named xmatrix.
      return jsonResponse({ token: "ghs_other", repositories: [{ full_name: "OtherOrg/xmatrix" }],
        permissions: { contents: "write", metadata: "read" } });
    }
    // The public repository is readable with any token; that proves nothing.
    return jsonResponse({ full_name: "LambdaLabsHQ/xmatrix" });
  });
  try {
    await assert.rejects(() => mintConfiguredRepositoryToken(), { message: "github_installation_not_linked_to_space" });
  } finally {
    github.restore();
  }
});

test("when the lookup is down, the installation that covers exactly owner/repo is used", async () => {
  const github = stubGitHubFetch((call) => {
    if (call.url.endsWith("/installation")) return jsonResponse({ message: "unavailable" }, 502);
    if (call.url.includes("/app/installations/111/access_tokens")) return jsonResponse({}, 422);
    if (call.url.includes("/app/installations/777/access_tokens")) {
      return jsonResponse({ token: "ghs_right", permissions: { contents: "write", metadata: "read" } });
    }
    if (call.url.includes("/installation/repositories")) {
      return jsonResponse({ repositories: [{ full_name: "lambdalabshq/XMatrix" }] });
    }
    return jsonResponse({}, 404);
  });
  try {
    const grant = await mintGitHubRepositoryToken(GITHUB_APP_ENV, connection(["111", "777"]), "LambdaLabsHQ", "xmatrix");
    assert.equal(grant.token, "ghs_right");
  } finally {
    github.restore();
  }
});

function mintConfiguredRepositoryToken() {
  return mintGitHubRepositoryToken(GITHUB_APP_ENV, connection(["777"]), "LambdaLabsHQ", "xmatrix");
}
