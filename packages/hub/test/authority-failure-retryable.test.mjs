import assert from "node:assert/strict";
import test from "node:test";

import { ControlError, MessageAuthorityError } from "@xmatrix/db";
import { authorityFailure } from "../src/run-principal.ts";
import { requestErrorResponse } from "../src/index-shared.ts";

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
