import assert from "node:assert/strict";
import test from "node:test";

import {
  parseHumanChannelCatalogChangedMessage,
  parseHumanTraceAccessServerMessage,
  parseTraceAccessGrant,
} from "../dist/connections/human.js";

test("Human Channel catalog invalidations are exact positive Space watermarks", () => {
  const input = {
    type: "space_channel_catalog_changed",
    spaceId: "space-one",
    revision: 42,
  };
  assert.deepEqual(parseHumanChannelCatalogChangedMessage(input), input);
  for (const candidate of [
    { ...input, revision: 0 },
    { ...input, revision: 1.5 },
    { ...input, extra: true },
    { ...input, spaceId: "" },
    { ...input, spaceId: "x".repeat(201) },
  ]) {
    assert.equal(parseHumanChannelCatalogChangedMessage(candidate), undefined);
  }
});


test("Human trace access invalidations require exact versioned owner/viewer metadata", () => {
  const input = {
    type: "trace_access_updated",
    grant: {
      id: "grant-1",
      ownerUserId: "owner-1",
      viewerUserId: "viewer-1",
      agentId: "agent-1",
      instanceId: "instance-1",
      duration: "once",
      status: "expired",
      requestedAt: "2026-07-20T00:00:00.000Z",
      decidedAt: "2026-07-20T00:01:00.000Z",
      expiresAt: "2026-07-20T00:01:00.000Z",
      version: 3,
    },
  };
  assert.deepEqual(parseHumanTraceAccessServerMessage(input), input);
  assert.equal(parseHumanTraceAccessServerMessage({ ...input, body: "payload" }), undefined);
  assert.equal(parseHumanTraceAccessServerMessage({
    ...input,
    grant: { ...input.grant, version: undefined },
  }), undefined);
  assert.equal(parseHumanTraceAccessServerMessage({
    ...input,
    grant: { ...input.grant, viewerUserId: input.grant.ownerUserId },
  }), undefined);
  assert.equal(parseHumanTraceAccessServerMessage({
    ...input,
    grant: { ...input.grant, ownerUserId: "o".repeat(201) },
  }), undefined);
  assert.equal(parseHumanTraceAccessServerMessage({
    type: "trace_access_requested",
    grant: { ...input.grant, status: "expired" },
  }), undefined);
  assert.deepEqual(parseTraceAccessGrant({ ...input.grant, channelId: "channel-1" }), {
    ...input.grant, channelId: "channel-1",
  });
  assert.deepEqual(parseTraceAccessGrant({
    ...input.grant, duration: "channel", channelId: "channel-1", instanceId: "instance-1",
  })?.instanceId, "instance-1");
  const permanentWithLegacyContext = {
    ...input.grant,
    duration: "permanent",
    expiresAt: undefined,
  };
  delete permanentWithLegacyContext.expiresAt;
  assert.deepEqual(parseTraceAccessGrant(permanentWithLegacyContext), permanentWithLegacyContext);
  const restrictivePermanent = {
    ...permanentWithLegacyContext,
    expiresAt: "2026-07-20T00:01:00.000000001Z",
  };
  assert.deepEqual(parseTraceAccessGrant(restrictivePermanent), restrictivePermanent);
  const inertTerminal = { ...input.grant, duration: "once" };
  delete inertTerminal.instanceId;
  delete inertTerminal.expiresAt;
  assert.deepEqual(parseTraceAccessGrant(inertTerminal), inertTerminal);
  const inertApproved = { ...inertTerminal, status: "approved" };
  assert.deepEqual(
    parseTraceAccessGrant(inertApproved),
    inertApproved,
    "an incomplete historical status remains decodable without becoming executable authority",
  );
  const inertPending = { ...inertApproved, status: "pending" };
  delete inertPending.decidedAt;
  assert.deepEqual(parseTraceAccessGrant(inertPending), inertPending);
  const multilingual = {
    ...input.grant,
    ownerLabel: "界".repeat(200),
    viewerLabel: "🙂".repeat(100),
    agentName: "界".repeat(200),
    reason: "界".repeat(500),
  };
  assert.deepEqual(parseTraceAccessGrant(multilingual), multilingual);
  assert.equal(parseTraceAccessGrant({
    ...multilingual,
    ownerLabel: "界".repeat(267),
  }), undefined);
  assert.equal(parseTraceAccessGrant({ ...input.grant, status: "pending" }), undefined);
  assert.equal(parseTraceAccessGrant({ ...input.grant, status: "approved", decidedAt: undefined }), undefined);
  assert.equal(parseTraceAccessGrant({
    ...input.grant,
    requestedAt: "2026-07-20T00:00:00.999999999Z",
    decidedAt: "2026-07-20T00:00:00.000000001Z",
  }), undefined);
  const immediatelyExpired = {
    ...input.grant,
    requestedAt: "2026-07-20T00:00:00.000000001Z",
    expiresAt: "2026-07-20T00:00:00.000000001Z",
  };
  delete immediatelyExpired.decidedAt;
  assert.deepEqual(parseTraceAccessGrant(immediatelyExpired)?.status, "expired");
  const migratedExpired = {
    ...input.grant,
    channelId: "legacy-context-channel",
  };
  delete migratedExpired.decidedAt;
  assert.deepEqual(parseTraceAccessGrant(migratedExpired), migratedExpired);
  assert.equal(parseTraceAccessGrant({
    ...input.grant,
    status: "approved",
    requestedAt: "2026-07-20T00:00:00.000000001Z",
    expiresAt: "2026-07-20T00:00:00.000000001Z",
  }), undefined);
  for (const requestedAt of [
    "2026-07-20T00:00:00Z",
    "2026-07-20T00:00:00.1Z",
    "2026-07-20T00:00:00.123456789Z",
    "2026-07-20t00:00:00.123456789+23:59",
    "2024-02-29T23:59:59.000000001-00:00",
  ]) {
    assert.deepEqual(parseHumanTraceAccessServerMessage({
      ...input,
      grant: { ...input.grant, requestedAt },
    })?.grant.requestedAt, requestedAt);
  }
  for (const requestedAt of [
    "2026-02-30T00:00:00Z",
    "2026-07-20 00:00:00Z",
    "2026-07-20T00:00:00.Z",
    "2026-07-20T00:00:00.1234567890Z",
    "2026-07-20T24:00:00Z",
    "2026-07-20T00:60:00Z",
    "2026-07-20T00:00:60Z",
    "2026-07-20T00:00:00+24:00",
    "2026-07-20T00:00:00+00:60",
    "2026-07-20T00:00:00",
    " 2026-07-20T00:00:00Z",
  ]) {
    assert.equal(parseHumanTraceAccessServerMessage({
      ...input,
      grant: { ...input.grant, requestedAt },
    }), undefined);
  }
});
