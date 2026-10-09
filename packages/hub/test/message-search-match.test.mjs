import assert from "node:assert/strict";
import { test } from "node:test";

import { matchMessageSearchCandidate } from "../src/postgres-message-authority.ts";

function candidate(overrides = {}) {
  return {
    messageId: "message-1",
    channelId: "channel-1",
    timelineSequence: 7,
    entityVersion: 2,
    searchRankSequence: "pg:00000000000000000042",
    authorKind: "user",
    authorId: "user-1",
    payloadBundleBase64: null,
    legacyBody: "Deploy the Hub after the release train finishes",
    sentAt: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

test("a body match carries the message coordinates and a snippet around the hit", () => {
  const hit = matchMessageSearchCandidate(candidate(), "release train");
  assert.deepEqual({ ...hit, snippet: undefined }, {
    kind: "message", entityId: "message-1", entityVersion: 2, matchTier: "verified_substring",
    field: "body", fieldPriority: 0, searchRankSeq: "pg:00000000000000000042", snippet: undefined,
    channelId: "channel-1", messageId: "message-1", timelineSequence: 7,
    senderLabel: "", sentAt: "2026-10-04T00:00:00.000Z",
  });
  assert.match(hit.snippet, /release train/u);
});

test("matching is case-insensitive and a miss returns null", () => {
  assert.equal(matchMessageSearchCandidate(candidate(), "deploy")?.field, "body");
  assert.equal(matchMessageSearchCandidate(candidate(), "nothing like this"), null);
  assert.equal(matchMessageSearchCandidate(candidate({ legacyBody: null }), "deploy"), null);
});

test("an attachment name matches when the body does not", () => {
  const hit = matchMessageSearchCandidate(candidate({
    legacyBody: "", attachmentNames: ["quarterly-ledger.pdf"],
  }), "ledger");
  assert.equal(hit.field, "attachment");
  assert.equal(hit.snippet, "quarterly-ledger.pdf");
  assert.equal(matchMessageSearchCandidate(candidate({
    legacyBody: "ledger", attachmentNames: ["quarterly-ledger.pdf"],
  }), "ledger")?.field, "body");
});

test("a long body is trimmed to a bounded snippet", () => {
  const body = `${"a".repeat(500)} needle ${"b".repeat(500)}`;
  const hit = matchMessageSearchCandidate(candidate({ legacyBody: body }), "needle");
  assert.ok(hit.snippet.length <= 162);
  assert.match(hit.snippet, /^…a+ needle b+…$/u);
});

test("an empty needle matches every message from its start, for a filter-only search", () => {
  const hit = matchMessageSearchCandidate(candidate(), "");
  assert.equal(hit.field, "body");
  assert.match(hit.snippet, /^Deploy the Hub/u);
});

test("an Agent filter keeps only messages sent under that Agent's name", () => {
  const agent = candidate({ authorKind: "agent", authorId: "instance-1" });
  // Legacy rows carry no sender snapshot, so no Agent name can match them.
  assert.equal(matchMessageSearchCandidate(agent, "deploy", "claude"), null);
});
