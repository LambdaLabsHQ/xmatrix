import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { startPgHubWorker as startHubWorker } from "./agent-launch-postgres.fixture.mjs";

const MOCK_TOKEN = "hub-authority-product-pagination-e2e-token";
/**
 * Authority answers at most 200 rows per page, so a directory has to exceed that
 * before a dropped cursor is observable at all. Every silent truncation this
 * suite guards against was invisible below this line.
 */
const AUTHORITY_PAGE_LIMIT = 200;
const ROWS = AUTHORITY_PAGE_LIMIT + 17;

async function json(response) {
  assert.ok(response.ok, `${response.status}: ${await response.clone().text()}`);
  return response.json();
}

test("a directory larger than one Authority page is read complete", async () => {
  const userId = `pagination-${randomUUID()}`;
  const worker = await startHubWorker({
    vars: {
      XMATRIX_MOCK_AUTH_TOKEN: MOCK_TOKEN,
      XMATRIX_MOCK_AUTH_USER_ID: userId,
      XMATRIX_MOCK_AUTH_EMAIL: "pagination@example.com",
      XMATRIX_MOCK_AUTH_NAME: "Pagination E2E",
    },
  });
  try {
    const auth = {
      Authorization: `Bearer ${MOCK_TOKEN}`,
      "content-type": "application/json",
    };
    const machineId = `machine:pagination-${randomUUID()}`;
    const hostId = `pagination-host-${randomUUID()}`;
    const expected = [];
    for (let index = 0; index < ROWS; index += 1) {
      // Zero-padded so lexical order matches creation order, making a skipped or
      // repeated page boundary legible in the failure diff.
      const canonicalCwd = `/tmp/xmatrix-pagination/${String(index).padStart(4, "0")}`;
      expected.push(canonicalCwd);
      await json(await worker.fetch("/api/workspaces", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          machineId,
          hostId,
          hostName: hostId,
          canonicalCwd,
          displayName: `pagination-${index}`,
          runtime: "codex",
        }),
      }));
    }

    const listed = await json(await worker.fetch("/api/workspaces", {
      headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
    }));
    const seen = listed.workspaces.map((workspace) => workspace.canonicalCwd).sort();

    assert.equal(
      seen.length,
      ROWS,
      `the registry stopped at ${seen.length} of ${ROWS}; a page cursor was dropped`,
    );
    assert.deepEqual(seen, [...expected].sort(), "pages skipped or repeated a row");
    assert.equal(new Set(seen).size, ROWS, "a row was returned by two pages");
  } finally {
    await worker.stop();
  }
});
