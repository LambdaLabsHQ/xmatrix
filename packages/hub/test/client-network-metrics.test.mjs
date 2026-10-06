import assert from "node:assert/strict";
import test from "node:test";

import {
  clientNetworkSampleAnalytics,
  clientNetworkSampleReason,
  parseClientNetworkSample,
} from "../src/client-network-metrics.ts";

const cliReconnectSample = {
  clientKind: "cli",
  mode: "reconnect",
  networkState: "online",
  result: "success",
  channelId: "channel-1",
  latencyMs: 1_250,
  reconnectAttempt: 3,
  lastServerActivityAgeMs: 75_000,
  reason: "reconnected",
};

test("accepts the complete CLI reconnect telemetry wire payload", () => {
  assert.deepEqual(parseClientNetworkSample(cliReconnectSample), cliReconnectSample);
  assert.equal(clientNetworkSampleReason(cliReconnectSample), "reconnect:online:reconnected");
  assert.deepEqual(clientNetworkSampleAnalytics(cliReconnectSample), {
    reason: "reconnect:online:reconnected",
    count: 1,
    durationMs: 1_250,
    extraDoubles: [3, 75_000],
  });
});

test("accepts the CLI initial telemetry payload with a reason", () => {
  const sample = {
    clientKind: "cli",
    mode: "initial",
    networkState: "online",
    result: "success",
    channelId: "channel-1",
    reason: "channel_joined",
  };
  assert.deepEqual(parseClientNetworkSample(sample), sample);
});

test("rejects unknown, malformed, and unbounded telemetry fields", () => {
  for (const sample of [
    { ...cliReconnectSample, secret: "must-not-pass" },
    { ...cliReconnectSample, reconnectAttempt: -1 },
    { ...cliReconnectSample, lastServerActivityAgeMs: 1.5 },
    { ...cliReconnectSample, reason: "x".repeat(241) },
  ]) {
    assert.equal(parseClientNetworkSample(sample), undefined);
  }
});
