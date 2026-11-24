import { parseDiagnosticEvent, type ClientNetworkSample, type DiagnosticEventSchema } from "@xmatrix/protocol";

const count = { kind: "number", min: 0, max: Number.MAX_SAFE_INTEGER, integer: true, optional: true } as const;

/**
 * The declared fields of one network sample (protocol diagnostic-events):
 * fixed values, counts and the Channel's opaque id, which the data point
 * hashes. `reason` is a code the client defines (`websocket_connect_failed`),
 * never an error's own text.
 */
const CLIENT_NETWORK_SAMPLE_EVENT = {
  clientKind: { kind: "enum", values: ["web", "ios", "cli"] },
  mode: { kind: "enum", values: ["initial", "refresh", "reconnect", "send"] },
  networkState: { kind: "enum", values: ["online", "reconnecting", "offline", "unknown"] },
  result: { kind: "enum", values: ["success", "failed", "timeout"] },
  channelId: { kind: "id" },
  latencyMs: { kind: "number", min: 0, max: Number.MAX_VALUE, optional: true },
  entryCount: count,
  truncated: { kind: "boolean", optional: true },
  afterSequence: count,
  lastSequence: count,
  reconnectAttempt: count,
  lastServerActivityAgeMs: count,
  reason: { kind: "code", optional: true },
} as const satisfies DiagnosticEventSchema;

export function parseClientNetworkSample(value: unknown): ClientNetworkSample | undefined {
  return parseDiagnosticEvent(CLIENT_NETWORK_SAMPLE_EVENT, value);
}

export function clientNetworkSampleReason(sample: ClientNetworkSample): string {
  return [sample.mode, sample.networkState, sample.reason].filter(Boolean).join(":");
}

export function clientNetworkSampleAnalytics(sample: ClientNetworkSample) {
  return {
    reason: clientNetworkSampleReason(sample),
    count: sample.entryCount ?? 1,
    durationMs: sample.latencyMs ?? 0,
    extraDoubles: [sample.reconnectAttempt ?? -1, sample.lastServerActivityAgeMs ?? -1],
  };
}
