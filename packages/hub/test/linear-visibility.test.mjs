import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCommonJsSourceModule } from "./support/commonjs-source-module.mjs";
import { ProviderRequestError } from "../src/connectors/http.ts";
import * as http from "../src/connectors/http.ts";
import { withProviderResponses } from "./support/fetch-responses.mjs";

// The Linear grant each Space connected decides what that Space may receive:
// one read of the event's subject, with that Space's own token.
const visibility = await loadCommonJsSourceModule(new URL("../src/connectors/linear-visibility.ts", import.meta.url),
  (name) => name === "./connection-credentials"
    ? { connectionCredentials: async (_env, spaceId) => spaceId === "unconnected" ? {} : { oauthToken: `token-${spaceId}` } }
    : name === "./http" ? http : assert.fail(`unexpected import ${name}`));
const issue = { eventId: "e", sourceRef: "linear:eng", feature: "issue", summary: "", body: "",
  subject: { entity: "issue", id: "issue-1" } };

test("a Space receives a Linear event only when its own grant reads the event's subject", async () => {
  const visible = (spaceId, event = issue) => visibility.linearEventVisible({}, spaceId, event);
  const read = await withProviderResponses([{ body: { data: { issue: { id: "issue-1" } } } }], () => visible("space-a"));
  assert.equal(read.result, true);
  assert.equal(new Headers(read.calls[0].headers).get("authorization"), "Bearer token-space-a");
  assert.deepEqual(read.calls[0].body.variables, { id: "issue-1" });
  assert.match(read.calls[0].body.query, /issue\(id: \$id\) \{ id \}/u);
  for (const response of [{ body: { data: { issue: null }, errors: [{ message: "Entity not found" }] } },
    { body: { data: { issue: { id: "another" } } } }, { status: 401, body: {} }]) {
    assert.equal((await withProviderResponses([response], () => visible("space-b"))).result, false);
  }
  await assert.rejects(withProviderResponses([{ status: 503, body: {} }], () => visible("space-b")),
    (error) => error instanceof ProviderRequestError && error.status === 503, "an outage is retried, not dropped");
  assert.equal((await withProviderResponses([], () => visible("unconnected"))).result, false);
  assert.equal((await withProviderResponses([], () => visible("space-a", { ...issue, subject: undefined }))).result, false);
  assert.equal((await withProviderResponses([], () => visible("space-a",
    { ...issue, subject: { entity: "organization", id: "x" } }))).result, false);
});
