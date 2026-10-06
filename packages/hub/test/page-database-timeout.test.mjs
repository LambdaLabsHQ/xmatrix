import assert from "node:assert/strict";
import test from "node:test";

import { PageControlError, PostgresPageRepository } from "@xmatrix/db";
import { Pool } from "pg";
import { pageDatabaseOptions } from "../src/index-routes-pages.ts";
import { RelayPageSession } from "../src/page-session-do.ts";
import { POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS } from "../src/postgres-message-database-policy.ts";
import { authorityFailure } from "../src/run-principal.ts";

function context() {
  return { json: (body, status) => Response.json(body, { status }) };
}

test("page checkout uses the message connect budget and keeps the statement budget", () => {
  assert.equal(pageDatabaseOptions.connectTimeoutMs, POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS);
  assert.equal(pageDatabaseOptions.connectTimeoutMs, 8_000);
  assert.equal(pageDatabaseOptions.statementTimeoutMs, 5_000);
  assert.equal(pageDatabaseOptions.transactionTimeoutMs, 10_000);
  assert.equal(pageDatabaseOptions.lockTimeoutMs, 2_000);
  assert.notEqual(pageDatabaseOptions.connectTimeoutMs, 3_000);
});

test("a forbidden page edit stays forbidden instead of a postgres outage", async () => {
  const response = authorityFailure(context(), new PageControlError("page_edit_forbidden", 403));
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "page_edit_forbidden");
  assert.equal(body.error, "page_edit_forbidden");
  assert.notEqual(body.error, "PostgreSQL is unavailable");
});

test("a page checkout timeout stays a retryable postgres outage", async () => {
  const response = authorityFailure(context(),
    new Error("Connection terminated due to connection timeout"));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, {
    error: "PostgreSQL is unavailable",
    code: "postgres_unavailable",
    retryable: true,
  });
});

for (const phase of ["load", "commit"]) {
  test(`the actual Page Session ${phase} path gives its driver the page checkout budget`, async (t) => {
    const checkouts = [];
    t.mock.method(Pool.prototype, "connect", async function () {
      checkouts.push(this.options);
      throw new Error("test checkout intercepted");
    });
    if (phase === "commit") {
      t.mock.method(PostgresPageRepository.prototype, "read", async () => ({
        page: { headRevision: 1, body: "# Before\n", agentSuggestOnly: false },
      }));
    }
    // Use the actual DO ports without constructing Node's unavailable Worker runtime.
    const stored = new Map();
    const object = Object.create(RelayPageSession.prototype);
    Object.assign(object, {
      spaceId: null, pageId: null, rehydrated: null,
      env: { RELAY_POSTGRES_SHARD_ID: "test", RELAY_POSTGRES: { connectionString: "postgresql://localhost/unused" } },
      ctx: { getWebSockets: () => [], storage: {
        get: async key => stored.get(key), put: async (key, value) => stored.set(key, value),
      } },
    });
    object.session = object.newSession();
    t.after(() => object.session.destroy());
    const response = await object.fetch(new Request("http://session/internal/edit", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: "space", pageId: "page", principal: { kind: "user", id: "author" },
        baseRevision: 1, body: "# After\n", conversationIds: [] }),
    }));
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /test checkout intercepted/u);
    assert.equal(checkouts.length, 1, "the driver was reached without opening a network connection");
    assert.equal(checkouts[0].application_name, "xmatrix-page-session");
    assert.equal(checkouts[0].connectionTimeoutMillis, POSTGRES_MESSAGE_CONNECT_TIMEOUT_MS);
  });
}
