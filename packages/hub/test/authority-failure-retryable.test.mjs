import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { ControlError, CrossSpaceReadError, MessageAuthorityError, SpaceSecretError } from "@xmatrix/db";
import { authorityFailure } from "../src/run-principal.ts";
import { requestErrorResponse } from "../src/index-shared.ts";
import { AgentRunDelegationError } from "../src/agent-run-channel-delegation.ts";
import { GitHubFileError } from "../src/app-connectors.ts";
import { RelayR2UploadPrivateApiError } from "../src/relay-r2-upload-private-api.ts";

async function answer(respond) {
  const { Hono } = await import("hono");
  const app = new Hono();
  app.get("/", (c) => respond(c));
  const response = await app.request("/");
  return { status: response.status, body: await response.json() };
}

test("a Space moving shards answers retryable through every authority mapper", async () => {
  const moving = new MessageAuthorityError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  assert.deepEqual(await answer((c) => authorityFailure(c, moving)), {
    status: 503,
    body: { error: "Space placement is unavailable", code: "space_placement_unavailable", retryable: true },
  });
  const placement = new ControlError("space_placement_unavailable", 503, "Space placement is unavailable", true);
  const viaRequest = await answer((c) => requestErrorResponse(c, placement));
  assert.equal(viaRequest.status, 503);
  assert.equal(viaRequest.body.retryable, true);
});

test("a domain refusal stays non-retryable", async () => {
  const refused = new MessageAuthorityError("forbidden", 403, "No");
  assert.equal((await answer((c) => authorityFailure(c, refused))).body.retryable, false);
});

test("every domain rejection answers through one mapper, keeping its status, code and retry policy", async () => {
  for (const [error, status, code, retryable] of [
    [new SpaceSecretError("secret_not_found", 404), 404, "secret_not_found", false],
    [new CrossSpaceReadError("cross_space_read_grant_required", 403, "Ask"), 403, "cross_space_read_grant_required", false],
    [new AgentRunDelegationError("agent_run_channel_unavailable", 503), 503, "agent_run_channel_unavailable", true],
    [new GitHubFileError("github_file_not_found", 404), 404, "github_file_not_found", false],
    [new RelayR2UploadPrivateApiError("invalid_request", 400, "Bad"), 400, "invalid_request", false],
  ]) {
    const answered = await answer((c) => requestErrorResponse(c, error));
    assert.equal(answered.status, status, code);
    assert.equal(answered.body.code, code);
    assert.equal(answered.body.retryable, retryable, code);
  }
});

// A rejection with its own code and status is a ControlError: then requestErrorResponse
// answers it, and no route needs a mapper that can forget `retryable` or the no-store headers.
test("hub and db declare no second code-and-status error shape beside ControlError", () => {
  // Better Auth's status and code are the library's, relayed as it answered them.
  const relayed = new Set(["BetterAuthRequestError"]);
  const offenders = [];
  for (const root of ["src", "../db/src"]) {
    const dir = new URL(`../${root}/`, import.meta.url);
    for (const entry of readdirSync(dir, { recursive: true })) {
      if (!String(entry).endsWith(".ts")) continue;
      const source = readFileSync(join(dir.pathname, String(entry)), "utf8");
      for (const match of source.matchAll(/class (\w+) extends Error \{(\}|[\s\S]*?\n\})/gu)) {
        if (match[1] === "ControlError" || relayed.has(match[1])) continue;
        const declares = (field) => new RegExp(`readonly ${field}\\b|this\\.${field} =`, "u").test(match[2]);
        if (declares("code") && declares("status")) offenders.push(`${entry}: ${match[1]}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
