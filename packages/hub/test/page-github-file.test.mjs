import assert from "node:assert/strict";
import { test } from "node:test";

/**
 * A page embeds a GitHub file by reference (docs/design/pages-live-document.md
 * §6.5): the Hub reads it through this Space's installation with a token that
 * can only read that one repository's contents, and keeps no copy.
 */
import { GITHUB_FILE_TEXT_LIMIT, GitHubFileError, readGitHubFile } from "../src/app-connectors.ts";
import { githubAppEnv, githubConnection, jsonResponse, stubGitHubInstallation } from "./support/github-app.mjs";
import { agentRunAllowed as allowed } from "./support/agent-run-routes.mjs";

const env = await githubAppEnv();
const file = { owner: "LambdaLabsHQ", repo: "xmatrix", path: "docs/prompts/bootstrap.md", ref: null };
const contentsUrl = "https://api.github.com/repos/LambdaLabsHQ/xmatrix/contents/docs/prompts/bootstrap.md";

function contents(text, fields = {}) {
  return { type: "file", encoding: "base64", content: Buffer.from(text).toString("base64").replace(/(.{60})/gu, "$1\n"),
    size: Buffer.byteLength(text), sha: "abc123", html_url: "https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/prompts/bootstrap.md",
    ...fields };
}

async function read(handler, overrides = {}, permissions = { contents: "read", metadata: "read" }) {
  const github = stubGitHubInstallation(permissions, handler);
  try {
    return { result: await readGitHubFile(env, githubConnection(), { ...file, ...overrides }), calls: github.calls };
  } catch (error) {
    return { error, calls: github.calls };
  } finally {
    github.restore();
  }
}

test("an embedded file is read as text with a token for its one repository", async () => {
  const { result, calls } = await read((call) => call.url === contentsUrl ? jsonResponse(contents("# Prompt\n\nHello 你好\n"))
    : jsonResponse({}, 404));
  assert.deepEqual(result, { repository: "LambdaLabsHQ/xmatrix", path: "docs/prompts/bootstrap.md", ref: null,
    sha: "abc123", size: 23, htmlUrl: "https://github.com/LambdaLabsHQ/xmatrix/blob/main/docs/prompts/bootstrap.md",
    text: "# Prompt\n\nHello 你好\n", truncated: false });
  const mint = calls.find((call) => call.url.includes("/access_tokens"));
  assert.deepEqual(mint.body?.repositories, ["xmatrix"], "the token reaches only the embedded file's repository");
});

test("a pinned ref is read at that ref", async () => {
  const { result, calls } = await read((call) => call.url === `${contentsUrl}?ref=release%2F1.0`
    ? jsonResponse(contents("pinned")) : jsonResponse({}, 404), { ref: "release/1.0" });
  assert.equal(result.text, "pinned");
  assert.equal(result.ref, "release/1.0");
  assert.ok(calls.some((call) => call.url === `${contentsUrl}?ref=release%2F1.0`));
});

test("a binary file, or one GitHub sends without content, has no text; a long one is cut", async () => {
  const binary = await read(() => jsonResponse(contents("\u0000\u0001PNG")));
  assert.equal(binary.result.text, null);
  const large = await read(() => jsonResponse({ ...contents(""), content: "", encoding: "none", size: 5_000_000 }));
  assert.equal(large.result.text, null);
  assert.equal(large.result.size, 5_000_000);
  const long = await read(() => jsonResponse(contents("x".repeat(GITHUB_FILE_TEXT_LIMIT + 10))));
  assert.equal(long.result.text.length, GITHUB_FILE_TEXT_LIMIT);
  assert.equal(long.result.truncated, true);
});

test("each refusal says what is missing", async () => {
  const missing = await read(() => jsonResponse({ message: "Not Found" }, 404));
  assert.ok(missing.error instanceof GitHubFileError);
  assert.deepEqual([missing.error.code, missing.error.status], ["github_file_not_found", 404]);

  const directory = await read(() => jsonResponse([{ type: "file", name: "a.md" }]));
  assert.deepEqual([directory.error.code, directory.error.status], ["github_file_not_a_file", 422]);

  const outage = await read(() => jsonResponse({}, 500));
  assert.deepEqual([outage.error.code, outage.error.status], ["github_read_failed", 502]);

  const unreadable = await read(() => jsonResponse(contents("x")), {}, { metadata: "read" });
  assert.deepEqual([unreadable.error.code, unreadable.error.status], ["github_repository_not_covered", 403],
    "an installation that cannot read contents does not show the file");
});

test("a repository outside this Space's installations is refused before any file is read", async () => {
  const github = stubGitHubInstallation({ contents: "read" }, () => jsonResponse(contents("secret")));
  try {
    await assert.rejects(readGitHubFile(env, githubConnection({ metadata: { installationIds: ["999"] } }), file),
      (error) => error instanceof GitHubFileError && error.code === "github_repository_not_covered");
    assert.ok(!github.calls.some((call) => call.url.includes("/contents/")), "no file is read");
  } finally {
    github.restore();
  }
});

test("an Agent Run reads a page's embedded files as its owner may", () => {
  assert.equal(allowed("GET", "/api/spaces/space-1/pages/page-1/github-file"), true);
  assert.equal(allowed("POST", "/api/spaces/space-1/pages/page-1/github-file"), false);
});
