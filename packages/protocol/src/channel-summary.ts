/**
 * Where a Channel's summary came from. The Hub records it with every summary
 * write, so a reader can tell who wrote the summary, when, and how far into the
 * conversation it reaches, instead of trusting an unattributed string.
 */
export interface ChannelSummarySource {
  /** The Run that wrote the summary and the Agent it ran as. */
  author: { kind: "run"; runId: string; agentName: string };
  generatedAt: string;
  /** Sequence of the newest message the author read, when it named one in this Channel. */
  throughSequence?: number;
}

/** The summary source kept in Channel metadata, or undefined when it is absent or malformed. */
export function channelSummarySource(metadata: unknown): ChannelSummarySource | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const value = (metadata as Record<string, unknown>).summarySource;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const author = source.author as Record<string, unknown> | undefined;
  if (!author || author.kind !== "run" || typeof author.runId !== "string" ||
      typeof author.agentName !== "string" || typeof source.generatedAt !== "string") {
    return undefined;
  }
  const throughSequence = Number(source.throughSequence);
  return {
    author: { kind: "run", runId: author.runId, agentName: author.agentName },
    generatedAt: source.generatedAt,
    ...(Number.isSafeInteger(throughSequence) && throughSequence > 0 ? { throughSequence } : {}),
  };
}
