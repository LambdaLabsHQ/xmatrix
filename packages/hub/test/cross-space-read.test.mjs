import assert from "node:assert/strict";
import test from "node:test";

import { crossSpaceRetryOwner } from "../src/cross-space-read.ts";
import { postgresControlErrorResponse } from "../src/postgres-authority-http.ts";
import { CrossSpaceReadError } from "@xmatrix/db";
import { AGENT_RUN as run } from "./support/agent-run-routes.mjs";

// No database binding: the grant authority is absent.
const env = {};
// A binding no test can reach: consulting it would fail, so reaching it at all shows.
const unreachable = { RELAY_POSTGRES: { connectionString: "postgres://unreachable.invalid/none" },
  RELAY_POSTGRES_SHARD_ID: "shard-0" };

test("a Human read, or a refusal that is not about access, never consults grants", async () => {
  const forbidden = new Response(null, { status: 403 });
  assert.equal(await crossSpaceRetryOwner(env, undefined, { channelId: "channel-2" }, forbidden), forbidden);
  const unavailable = new Response(null, { status: 503 });
  assert.equal(await crossSpaceRetryOwner(env, run, { channelId: "channel-2" }, unavailable), unavailable);
});

test("without PostgreSQL the ordinary refusal stands instead of becoming an error", async () => {
  const forbidden = new Response(null, { status: 403 });
  assert.equal(await crossSpaceRetryOwner(env, run, { channelId: "channel-2" }, forbidden), forbidden);
});

test("a Run without an exact Instance cannot be granted a read outside its Space", async () => {
  await assert.rejects(crossSpaceRetryOwner(unreachable, { ...run, instanceId: undefined }, { channelId: "channel-2" },
    new Response(null, { status: 404 })), (error) => error.code === "agent_run_forbidden");
});

test("a missing grant answers with the way to ask for one", async () => {
  const response = postgresControlErrorResponse(new CrossSpaceReadError("cross_space_read_grant_required", 403,
    "ask its owner with `xmatrix access request <channel>`"));
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: "ask its owner with `xmatrix access request <channel>`",
    code: "cross_space_read_grant_required", retryable: false });
});
