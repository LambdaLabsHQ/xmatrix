import { AGENT_NAME_PATTERN, parseHandoffInstanceTarget, type AgentContinuationSource , utf8ByteLength } from "@xmatrix/protocol";

/** Closed presentation schema. Run/Channel authorization remains in Runtime. */
export function readContinuationSource(value: unknown): AgentContinuationSource | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const text = (key: string, max = 300): string | undefined => typeof raw[key] === "string" &&
    raw[key].length > 0 && utf8ByteLength(raw[key]) <= max ? raw[key] : undefined;
  const sourceMessageId = text("sourceMessageId"), sourceMention = text("sourceMention", 4_500);
  const sourceInstanceId = text("sourceInstanceId");
  const sourceRunId = text("sourceRunId"), targetInstanceId = text("targetInstanceId");
  const sourceName = text("sourceName", 128), sourceOrdinal = raw.sourceOrdinal;
  const sourceMessageVersion = raw.sourceMessageVersion;
  if (raw.schemaVersion !== 1 || (raw.kind !== "reborn" && raw.kind !== "handoff") ||
      !sourceMessageId || !sourceMention || !sourceInstanceId || !sourceRunId ||
      !targetInstanceId || !sourceName || !AGENT_NAME_PATTERN.test(sourceName) ||
      !Number.isSafeInteger(sourceOrdinal) || Number(sourceOrdinal) < 1 ||
      !Number.isSafeInteger(sourceMessageVersion) || Number(sourceMessageVersion) < 1) return undefined;
  const mention = sourceMention.replace(/^[@＠]/u, "");
  if (mention === sourceMention) return undefined;
  if (raw.kind === "reborn") {
    // UI controls address the Instance, while sourceName is a historical
    // display label. Both must resolve to this same already-bound source Run.
    const expected = [sourceName, sourceInstanceId].map(address => `${address}:${sourceOrdinal}:reborn`.toLowerCase());
    if (!expected.includes(mention.toLowerCase()) ||
        targetInstanceId !== sourceInstanceId) return undefined;
  } else {
    const parsed = parseHandoffInstanceTarget(mention);
    if (!parsed || ![sourceName, sourceInstanceId].some(address =>
        parsed.sourceAgentName.toLowerCase() === address.toLowerCase()) ||
        parsed.channelInstanceId !== sourceOrdinal || targetInstanceId === sourceInstanceId) return undefined;
  }
  return { schemaVersion: 1, kind: raw.kind, sourceMessageId,
    sourceMessageVersion: Number(sourceMessageVersion), sourceMention,
    sourceInstanceId, sourceRunId, sourceName, sourceOrdinal: Number(sourceOrdinal), targetInstanceId };
}
