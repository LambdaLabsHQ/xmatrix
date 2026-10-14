import { nativeGmailGet } from "./gmail-watch-client";
import { ProviderRequestError } from "./http";
import { record } from "./command-support";

/** The notification reader never fetches message bodies. */
export async function gmailIncomingChanges(accessToken: string, historyId: string, pageToken?: string) {
  if (!/^\d{1,30}$/u.test(historyId) || (pageToken?.length ?? 0)>2000) throw new ProviderRequestError(400,"Invalid Gmail cursor");
  const result = await nativeGmailGet(accessToken,"/history", { startHistoryId: historyId,
    historyTypes: "messageAdded", labelId: "INBOX", maxResults: "20", ...(pageToken ? { pageToken } : {}) });
  const messages = new Set<string>();
  for (const change of Array.isArray(result.history) ? result.history : []) {
    const row = record(change);
    for (const item of Array.isArray(row.messagesAdded) ? row.messagesAdded : []) {
      const message = record(record(item).message);
      const labels = Array.isArray(message.labelIds) ? message.labelIds : [];
      if (typeof message.id === "string" && /^[a-f0-9]{8,32}$/u.test(message.id) &&
          labels.includes("INBOX") && !labels.includes("SENT") && !labels.includes("SPAM") && !labels.includes("TRASH")) {
        messages.add(message.id);
      }
    }
  }
  if (messages.size>100 || typeof result.historyId !== "string" || !/^\d{1,30}$/u.test(result.historyId)) {
    throw new ProviderRequestError(502,"Gmail notification page exceeded its bounds");
  }
  const next = typeof result.nextPageToken === "string" ? result.nextPageToken : undefined;
  if (next && next.length>2000) throw new ProviderRequestError(502,"Gmail notification page token exceeded its bounds");
  return { messages: [...messages], historyId: next ? historyId : result.historyId, pageToken: next };
}
