import assert from "node:assert/strict";
import test from "node:test";

import {
  MessageAuthorityError,
  PostgresMessageRepository,
} from "../dist/message-control.js";
import { openMessageChannel, recordingDatabase, storedMessageRow } from "./recording-database.fixture.mjs";

/**
 * `xmatrix.` annotation namespaces hold the Hub's own judgments
 * (docs/design/conversation-activity.md §3.3): only annotateAsSystem writes
 * them, so no principal writes, replaces or removes one.
 */

const at = "2026-09-27T00:00:00.000Z";
const judgment = {
  id: "xmatrix.superseded:message-1", namespace: "xmatrix.superseded",
  target: { kind: "message", messageId: "message-1" }, authorUserId: "system:xmatrix",
  authorLabel: "xMatrix", payload: { supersededBy: "message-2" }, version: 1,
  createdAt: at, updatedAt: at,
};

function database() {
  return recordingDatabase((query) => openMessageChannel(query)
    ?? (query.name?.startsWith("message_mutation_candidate_")
      ? [storedMessageRow(at, { annotations_json: [judgment] })] : []));
}

function annotation(fields) {
  return {
    requestId: "annotation-test", spaceId: "space-1", channelId: "channel-1", messageId: "message-1",
    principal: { kind: "user", id: "author-1" }, commandId: "annotation-1",
    requestDigest: "5".repeat(64), expectedEntityVersion: 1, kind: "annotation", ...fields,
  };
}

async function refused(fields) {
  const db = database();
  await assert.rejects(new PostgresMessageRepository(db).mutateCollection(annotation(fields)),
    (error) => error instanceof MessageAuthorityError && error.code === "forbidden" &&
      /reserved/u.test(error.message));
  assert.ok(!db.calls.some((query) => /^message_annotation_(upsert|remove)_/u.test(query.name ?? "")),
    "no annotation row is touched");
}

test("the author cannot write an annotation in a reserved namespace", async () => {
  await refused({ action: "upsert", annotationId: "mine", namespace: " XMatrix.superseded" });
});

test("the author cannot replace the Hub's judgment under another namespace", async () => {
  await refused({ action: "upsert", annotationId: judgment.id, namespace: "memory" });
});

test("the author cannot remove the Hub's judgment", async () => {
  await refused({ action: "remove", annotationId: judgment.id });
});
