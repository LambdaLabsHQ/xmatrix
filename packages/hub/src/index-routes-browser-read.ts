import type { Hono } from "hono";
import { HUB_ROUTES, parseBrowserReadAnswer, type BrowserReadAnswer } from "@xmatrix/protocol";
import { requireAgentRunChannelDelegation } from "./agent-run-channel-delegation";
import { requireAuth, requireHumanAuth, requestErrorResponse } from "./index-shared";
import { relayRuntimeCellNamed, relayRuntimeOwnerCellName, relayRuntimeSingleCell } from "./relay-authority-locator";
import {
  RELAY_RUNTIME_BROWSER_READ_ANSWER_PATH,
  RELAY_RUNTIME_BROWSER_READ_WAIT_PATH,
} from "./runtime-transport/relay-runtime-product-adapter";
import { browserReadText } from "./browser-read";
import type { Env } from "./types";

const NO_STORE = { "cache-control": "private, no-store" };
const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/u;

/** The relay cell holding a user's live clients: where a page read waits for their browser (browser-read.ts). */
function ownerCell(env: Env, userId: string) {
  const name = relayRuntimeOwnerCellName(userId);
  return name ? relayRuntimeCellNamed(env, name) : relayRuntimeSingleCell(env);
}

async function cellCall(env: Env, userId: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await ownerCell(env, userId).fetch(new Request(`https://relay-runtime${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  if (!response.ok) throw new Error(`relay cell answered ${response.status}`);
  return await response.json() as Record<string, unknown>;
}

/** Why the page was not read, in words for the Agent. */
function refusalMessage(refusal: string, ownerName: string): string {
  switch (refusal) {
    case "offline": return `${ownerName}'s browser is not connected: the xMatrix side panel is not open in Chrome. Ask them to open it, then try again.`;
    case "denied": return `${ownerName} did not allow reading that tab.`;
    case "not-open": return "That page is not open in the browser. The extension reads only pages the person has open; ask them to open it.";
    case "no-page": return "This conversation was not started from a page in the browser; pass --tab <address> for a tab the person has open.";
    case "no-access": return `${ownerName} has not given the xMatrix extension access to web pages, so it can read only the page a conversation was started from. They can turn it on in the side panel.`;
    case "unreadable": return "The browser could not read that page (it may be a browser page, or the extension has no access to it).";
    default: return refusal;
  }
}

/** `POST /api/browser/read` (Agent Runs) and its answer from the owner's browser. */
export function registerBrowserReadRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.browser_read, async (c) => {
    try {
      const user = await requireAuth(c.req.raw, c.env);
      const run = user.agentRun;
      if (!run?.instanceId) return c.json({ error: "Reading a page through the browser requires an Agent Run" }, 403, NO_STORE);
      await requireAgentRunChannelDelegation(c.env, run, []);
      const body = await c.req.json().catch(() => null) as { requestId?: unknown; target?: unknown } | null;
      const requestId = typeof body?.requestId === "string" && REQUEST_ID.test(body.requestId) ? body.requestId : null;
      const target = body?.target === undefined || body.target === "conversation" ? "conversation"
        : typeof body.target === "string" && /^https?:\/\//u.test(body.target) && body.target.length <= 2_000 ? body.target : null;
      if (!requestId || !target) {
        return c.json({ error: "Provide a requestId, and a target that is \"conversation\" or a page address" }, 400, NO_STORE);
      }
      const waited = await cellCall(c.env, run.ownerUserId, RELAY_RUNTIME_BROWSER_READ_WAIT_PATH, {
        ownerUserId: run.ownerUserId, requestId, channelId: run.channelId, target, agentName: run.agentName,
      });
      const answer = waited.answer as BrowserReadAnswer | null;
      // A refusal is the person's or the browser's, not a fault: 409 so the CLI does not retry it as an outage.
      if (!answer) {
        return c.json({ error: "No browser answered in time. The xMatrix side panel may be closed in Chrome (ask the person to open it), or the person did not answer whether to allow the tab; try again once they have." }, 409, NO_STORE);
      }
      if ("refusal" in answer) return c.json({ error: refusalMessage(answer.refusal, "The person") }, 409, NO_STORE);
      return c.json({ title: answer.title, href: answer.href, text: browserReadText(answer) }, 200, NO_STORE);
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });

  app.post("/api/browser/read/:requestId/answer", async (c) => {
    try {
      const user = requireHumanAuth(await requireAuth(c.req.raw, c.env));
      const requestId = c.req.param("requestId");
      const body = await c.req.json().catch(() => null) as unknown;
      const answer = parseBrowserReadAnswer(body);
      if (!REQUEST_ID.test(requestId) || !answer) return c.json({ error: "Invalid answer" }, 400, NO_STORE);
      // Only the owner's own cell holds the request, and it takes only the owner's answer.
      const settled = await cellCall(c.env, user.id, RELAY_RUNTIME_BROWSER_READ_ANSWER_PATH,
        { ownerUserId: user.id, requestId, answer });
      return c.json({ settled: settled.settled === true }, 200, NO_STORE);
    } catch (error) {
      return requestErrorResponse(c, error);
    }
  });
}
