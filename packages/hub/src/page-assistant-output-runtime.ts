import { PageAssistantOutputReceiver, parsePageAssistantOutput } from "./page-assistant-output";
import { PAGE_OUTPUT_LIFETIME_MS, type PageOutputReceipt } from "./page-output-receipts";
import type { PageSessionPrincipal } from "./page-session";
import { pageSessionId } from "./page-session-id";
import type { Env } from "./types";
import { domainFailure, failureResponse, ServiceUnavailable } from "./error-contract";

/** Called only by the authenticated Worker route, in the Run owner's runtime cell. */
export async function receivePageAssistantOutput(request: Request, env: Env, storage: DurableObjectStorage,
  receiver: PageAssistantOutputReceiver): Promise<Response> {
  const body = await request.json() as { spaceId: string; principal: PageSessionPrincipal; input: unknown };
  const input = parsePageAssistantOutput(body.input);
  const proof = body.principal?.runProof;
  if (!input || body.principal.kind !== "agent" || !proof?.instanceId || !proof.executionKey || !body.spaceId) {
    return Response.json({ error: "Invalid assistant output binding" }, { status: 400 });
  }
  const scopeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    body.spaceId, body.principal.id, proof.runId, proof.instanceId, proof.executionKey,
  ])));
  const scope = Array.from(new Uint8Array(scopeBytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  try {
    const result = await receiver.receive(scope, input, {
      load: (key) => storage.get(key),
      save: (key, state) => storage.put(key, state),
      admit: async (prefix, now) => {
        // Also retire other completed Runs. Without the owner-wide bound, a
        // receipt prefix per Run would grow forever after those Runs left.
        const records = await storage.list<{ startedAt: number }>({ prefix: "page-output:", limit: 1025 });
        for (const [key, record] of records) if (record.startedAt + PAGE_OUTPUT_LIFETIME_MS <= now) {
          await storage.delete(key);
          records.delete(key);
        }
        return records.size < 1024 && [...records.keys()].filter((key) => key.startsWith(prefix)).length < 128;
      },
      write: async (pageId, write) => {
        const namespace = env.RELAY_PAGE_SESSION;
        if (!namespace) throw new Error("Page output service is unavailable");
        const response = await namespace.get(namespace.idFromName(pageSessionId(body.spaceId, pageId)))
          .fetch(new Request("https://page-session/internal/output", { method: "POST",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ spaceId: body.spaceId,
              pageId, principal: body.principal, write }) }));
        if (response.status >= 400 && response.status < 500) return { status: "rejected", seq: write.seq };
        if (!response.ok) {
          const failure = await response.json<{ retryable?: boolean }>().catch(() => null);
          if (failure?.retryable) throw new ServiceUnavailable("page_output_unavailable", "Page output could not be acknowledged");
          return { status: "unknown", seq: write.seq };
        }
        return response.json<PageOutputReceipt>();
      },
    });
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ServiceUnavailable) return failureResponse(domainFailure(error));
    throw error;
  }
}
