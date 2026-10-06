import { utf8ByteLength } from "@xmatrix/protocol";
import type { ClientNetworkSample } from "@xmatrix/protocol";

const CLIENT_NETWORK_REASON_MAX_CHARS = 240;

const CLIENT_KINDS = new Set<ClientNetworkSample["clientKind"]>(["web", "ios", "cli"]);
const CLIENT_MODES = new Set<ClientNetworkSample["mode"]>(["initial", "refresh", "reconnect", "send"]);
const NETWORK_STATES = new Set<ClientNetworkSample["networkState"]>([
  "online", "reconnecting", "offline", "unknown",
]);
const SAMPLE_RESULTS = new Set<ClientNetworkSample["result"]>(["success", "failed", "timeout"]);
const ALLOWED_KEYS = new Set([
  "clientKind", "mode", "networkState", "result", "channelId", "latencyMs", "entryCount",
  "truncated", "afterSequence", "lastSequence", "reconnectAttempt", "lastServerActivityAgeMs", "reason",
]);

function optionalCount(value: unknown): value is number | undefined {
  return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
}

export function parseClientNetworkSample(value: unknown): ClientNetworkSample | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some((key) => !ALLOWED_KEYS.has(key)) ||
      typeof body.clientKind !== "string" ||
      !CLIENT_KINDS.has(body.clientKind as ClientNetworkSample["clientKind"]) ||
      typeof body.mode !== "string" || !CLIENT_MODES.has(body.mode as ClientNetworkSample["mode"]) ||
      typeof body.networkState !== "string" ||
      !NETWORK_STATES.has(body.networkState as ClientNetworkSample["networkState"]) ||
      typeof body.result !== "string" || !SAMPLE_RESULTS.has(body.result as ClientNetworkSample["result"]) ||
      typeof body.channelId !== "string" || !body.channelId ||
      utf8ByteLength(body.channelId) > 192 ||
      (body.latencyMs !== undefined &&
        (typeof body.latencyMs !== "number" || !Number.isFinite(body.latencyMs) || body.latencyMs < 0)) ||
      !optionalCount(body.entryCount) || !optionalCount(body.afterSequence) ||
      !optionalCount(body.lastSequence) || !optionalCount(body.reconnectAttempt) ||
      !optionalCount(body.lastServerActivityAgeMs) ||
      (body.truncated !== undefined && typeof body.truncated !== "boolean") ||
      (body.reason !== undefined &&
        (typeof body.reason !== "string" || body.reason.length === 0 ||
          Array.from(body.reason).length > CLIENT_NETWORK_REASON_MAX_CHARS))) {
    return undefined;
  }
  return body as unknown as ClientNetworkSample;
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
