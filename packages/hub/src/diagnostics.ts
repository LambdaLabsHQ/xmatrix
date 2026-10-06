import { parseNaturalRunId, lowercaseHex } from "@xmatrix/protocol";
export interface DiagnosticsEventInput {
  userId?: string;
  agentId?: string;
  workspaceId?: string;
  channelId?: string;
  runId?: string;
  spawnSignature?: string;
  hashKey?: string;
  routeGroup: string;
  clientKind?: string;
  eventType: string;
  reason?: string;
  status?: string;
  count?: number;
  durationMs?: number;
}

export async function diagnosticsEntityHash(
  value: string | undefined,
  hashKey: string | undefined,
  fallback = "unknown",
): Promise<string> {
  const normalized = value?.trim();
  const key = hashKey?.trim();
  if (!normalized) return fallback;
  if (!key) return "hash_key_missing";
  const cryptoKey = await hmacKeyFor(key);
  const digest = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(normalized));
  return lowercaseHex(digest).slice(0, 16);
}

let cachedHmacKeySource: string | undefined;
let cachedHmacKey: Promise<CryptoKey> | undefined;

function hmacKeyFor(key: string): Promise<CryptoKey> {
  if (!cachedHmacKey || cachedHmacKeySource !== key) {
    cachedHmacKeySource = key;
    cachedHmacKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return cachedHmacKey;
}

function diagnosticsDimension(value: string | undefined, fallback = "unknown"): string {
  if (!value?.trim()) return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, "_");
  return normalized.slice(0, 80) || fallback;
}

function shortRunId(runId: string | undefined): string {
  const natural = runId ? parseNaturalRunId(runId) : null;
  if (natural) return "about" in natural ? `about#${natural.runOrdinal}` : `${natural.channelInstanceId}#${natural.runOrdinal}`;
  return runId?.replace(/^run:/, "").slice(0, 8) || "unknown";
}

export async function diagnosticsDataPoint(input: DiagnosticsEventInput): Promise<AnalyticsEngineDataPoint> {
  return {
    indexes: [await diagnosticsEntityHash(input.userId, input.hashKey)],
    blobs: [
      diagnosticsDimension(input.routeGroup),
      diagnosticsDimension(input.clientKind),
      diagnosticsDimension(input.eventType),
      diagnosticsDimension(input.reason),
      diagnosticsDimension(input.status),
      await diagnosticsEntityHash(input.agentId, input.hashKey),
      await diagnosticsEntityHash(input.workspaceId, input.hashKey),
      await diagnosticsEntityHash(input.channelId, input.hashKey),
      await diagnosticsEntityHash(input.spawnSignature, input.hashKey),
      shortRunId(input.runId),
    ],
    doubles: [
      Number.isFinite(input.count) ? input.count || 1 : 1,
      Number.isFinite(input.durationMs) ? input.durationMs || 0 : 0,
    ],
  };
}
