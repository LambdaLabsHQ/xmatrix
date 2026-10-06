/** One message whose body, attachment name, or sender label contains the search text. */
export interface MessageSearchHit {
  kind: "message";
  entityId: string;
  entityVersion: number;
  matchTier: "verified_substring";
  field: "body" | "attachment" | "sender";
  fieldPriority: number;
  searchRankSeq: string;
  snippet: string;
  channelId: string;
  messageId: string;
  timelineSequence: number;
}

/**
 * One page of a Space message search. `proven` means every readable message
 * was scanned; `budget_exhausted` stopped early and `resumeToken` continues it.
 */
export interface MessageSearchPage {
  results: MessageSearchHit[];
  execution: "proven" | "budget_exhausted";
  resumeToken?: string;
}
