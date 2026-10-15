/**
 * Where a Channel's summary came from. The Hub records it with every summary
 * write, so a reader can tell who wrote the summary, when, and how far into the
 * conversation it reaches, instead of trusting an unattributed string.
 */
export interface ChannelSummarySource {
  /**
   * The Agent harness that wrote the summary: one execution handed the conversation (`task`), or,
   * before those, a Run and the Agent it ran as.
   */
  author: { kind: "task"; agentName: string } | { kind: "run"; runId: string; agentName: string };
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
  if (!author || typeof author.agentName !== "string" || typeof source.generatedAt !== "string") return undefined;
  if (author.kind !== "task" && (author.kind !== "run" || typeof author.runId !== "string")) return undefined;
  const throughSequence = Number(source.throughSequence);
  return {
    author: author.kind === "task" ? { kind: "task", agentName: author.agentName }
      : { kind: "run", runId: author.runId as string, agentName: author.agentName },
    generatedAt: source.generatedAt,
    ...(Number.isSafeInteger(throughSequence) && throughSequence > 0 ? { throughSequence } : {}),
  };
}
