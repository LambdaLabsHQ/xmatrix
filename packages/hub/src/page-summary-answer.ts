import type { TextTaskResult } from "@xmatrix/protocol";
import { pageSessionId } from "./page-session-id";
import { pageSummaryLine, pageSummaryRequest, summaryPages } from "./page-summary";
import type { Env } from "./types";

/**
 * A page's summary execution answered. Its line is written only if the page is still at the
 * revision that was read; either way the page's session hears that it
 * ended, and starts the next one if the page has moved on.
 */
export async function pageSummaryAnswered(env: Env, task: { requestId: string; result: TextTaskResult }): Promise<void> {
  const request = pageSummaryRequest(task.requestId);
  if (!request) return;
  const line = task.result.status === "completed" && task.result.text ? pageSummaryLine(task.result.text) : "";
  if (line) {
    await summaryPages(env).recordSummary({ requestId: crypto.randomUUID(), spaceId: request.spaceId, pageId: request.pageId,
      revision: request.revision, summary: line });
  }
  const namespace = env.RELAY_PAGE_SESSION;
  if (!namespace) return;
  await namespace.get(namespace.idFromName(pageSessionId(request.spaceId, request.pageId)))
    .fetch(new Request("https://page-session/internal/summary-ended", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId: request.spaceId, pageId: request.pageId, requestId: task.requestId }) }));
}
