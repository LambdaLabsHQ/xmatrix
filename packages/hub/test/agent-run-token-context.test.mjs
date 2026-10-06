import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AGENT_RUN_TOKEN_CONTEXT_MISMATCH,
  LIVE_RUN_LAUNCH_FIELDS,
  LIVE_RUN_PRINCIPAL_FIELDS,
  agentRunTokenContextMismatch,
  isRecoverableLaunchFailure,
  liveRunAdmissionMismatches,
  liveRunIsAdmitted,
  snapshotLiveRunFromProductGateway,
} from "../src/live-run-admission.ts";

const liveRun = {
  channelId: "channel-1",
  status: "starting",
  metadata: { executionKey: "exec:abc", machineId: "machine:1", hostId: "Host" },
  instanceId: "instance:1",
};

// A Run acts as its Instance.
const liveBody = {
  agentId: "instance:1",
  channelId: "channel-1",
  executionKey: "exec:abc",
};

test("a live starting run with matching identity is admitted", () => {
  assert.equal(agentRunTokenContextMismatch({ run: liveRun, body: liveBody }), undefined);
});

test("a running run with matching identity is admitted", () => {
  assert.equal(
    agentRunTokenContextMismatch({ run: { ...liveRun, status: "running" }, body: liveBody }),
    undefined,
  );
});

test("names a failed status instead of a generic mismatch", () => {
  const error = agentRunTokenContextMismatch({
    run: { ...liveRun, status: "failed" },
    body: liveBody,
  });
  assert.match(error, new RegExp(AGENT_RUN_TOKEN_CONTEXT_MISMATCH, "u"));
  assert.match(error, /status=failed/u);
  assert.doesNotMatch(error, /agentId|channelId|executionKey/u);
});

test("names identity mismatches separately from status", () => {
  const error = agentRunTokenContextMismatch({
    run: liveRun,
    body: { ...liveBody, agentId: "agent:other", channelId: "channel-2" },
  });
  assert.match(error, /agentId/u);
  assert.match(error, /channelId/u);
  assert.doesNotMatch(error, /status=/u);
});

test("launch fields ignore a machine-route drift", () => {
  const snapshot = snapshotLiveRunFromProductGateway(liveRun);
  assert.equal(
    liveRunIsAdmitted(snapshot, { ...liveBody, machineId: "machine:other" }, LIVE_RUN_LAUNCH_FIELDS),
    true,
  );
  assert.deepEqual(
    liveRunAdmissionMismatches(
      snapshot,
      { ...liveBody, machineId: "machine:other", hostId: "Host" },
      LIVE_RUN_PRINCIPAL_FIELDS,
    ),
    ["machineId"],
  );
});

test("optional instanceId is skipped until the proof names one", () => {
  const snapshot = snapshotLiveRunFromProductGateway(liveRun);
  assert.equal(
    liveRunIsAdmitted(
      snapshot,
      { ...liveBody, machineId: "machine:1", hostId: "Host" },
      LIVE_RUN_PRINCIPAL_FIELDS,
    ),
    true,
  );
  assert.deepEqual(
    liveRunAdmissionMismatches(
      snapshot,
      { ...liveBody, machineId: "machine:1", hostId: "Host", instanceId: "instance:other" },
      LIVE_RUN_PRINCIPAL_FIELDS,
    ),
    ["instanceId"],
  );
});

test("opaque and status-only token failures are recoverable launch failures", () => {
  assert.equal(
    isRecoverableLaunchFailure("Agent run token context does not match the live Authority run"),
    true,
  );
  assert.equal(
    isRecoverableLaunchFailure(
      "Agent run token context does not match the live Authority run (status=failed)",
    ),
    true,
  );
  assert.equal(
    isRecoverableLaunchFailure("command lease does not belong to this daemon connection epoch"),
    true,
  );
  assert.equal(
    isRecoverableLaunchFailure(
      "Agent run token context does not match the live Authority run (agentId, channelId)",
    ),
    false,
  );
  assert.equal(isRecoverableLaunchFailure("wrapper_startup_failed"), false);
});

test("transient Hub, database and daemon-reconnect failures before admission are retried", () => {
  for (const detail of [
    "The registered execution location no longer authorizes this Run (allocation_daemon_reconnected)",
    "Request failed with status 503 Service Unavailable",
    "PostgreSQL compatibility authority is unavailable",
    "PostgreSQL Runtime authority is unavailable",
    "error decoding response body for url (https://hub.example/api/spaces/s/channel-mirror): error reading a body from connection: end of file",
  ]) assert.equal(isRecoverableLaunchFailure(detail), true, detail);
  for (const detail of [
    "The registered execution location no longer authorizes this Run (allocation_daemon_changed)",
    "Request failed with status 403 Forbidden",
    "repo pool lease unavailable (disk_exhausted: machine free space 1 bytes is below the 5-byte worktree watermark)",
  ]) assert.equal(isRecoverableLaunchFailure(detail), false, detail);
});
