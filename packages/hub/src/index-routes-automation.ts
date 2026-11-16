import { ControlError } from "@xmatrix/db";
import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Context, Hono } from "hono";
import type { Env } from "./types";
import { jsonErrors, requireAuth, requireHumanAuth, requireLiveAgentRun } from "./index-shared";

/**
 * Schedule lines are retired: scheduled work is a `norn run` program on its
 * page (docs/architecture/norn-host.md), and the Hub runs no Automation.
 * Clients released while it did still call these routes: a Web tab loaded
 * before its deploy lists a Space's and a page's schedules and offers to
 * pause, resume, run or delete one, and released CLIs carry `xmatrix page
 * automation …`. Each caller is authenticated as it always was, then reads an
 * empty list or is told where the work lives now.
 */

type HubContext = Context<{ Bindings: Env }>;

const NO_STORE = { "cache-control": "no-store" };

/** The caller, a Human or an Agent Run that is still live. */
async function caller(c: HubContext) {
  const user = await requireAuth(c.req.raw, c.env);
  if (user.agentRun) await requireLiveAgentRun(c.env, user);
  return user;
}

function retired(c: HubContext): Response {
  return c.json({
    error: "Schedule lines are retired: write the work as a `norn run` program on its page "
      + "(https://xmatrix.sh/docs/programs)",
    code: "automations_retired",
  }, 410, NO_STORE);
}

export function registerIndexRoutesAutomation(app: Hono<{ Bindings: Env }>): void {
  const one = `${HUB_ROUTES.automations}/:automationId`;
  const ofPage = "/api/spaces/:spaceId/pages/:pageId/automations";

  app.get(HUB_ROUTES.automations, (c) => jsonErrors(c, async () => {
    await caller(c);
    return c.json({ automations: [], executionEnabled: false, agentManagementEnabled: false }, 200, NO_STORE);
  }));
  app.post(HUB_ROUTES.automations, retired);

  app.get(one, (c) => jsonErrors(c, async () => {
    await caller(c);
    throw new ControlError("not_found", 404, "Automation not found");
  }));
  app.on(["PATCH", "DELETE"], one, (c) => jsonErrors(c, async () => {
    await caller(c);
    return retired(c);
  }));
  app.on("POST", [`${one}/pause`, `${one}/resume`], (c) => jsonErrors(c, async () => {
    await caller(c);
    return retired(c);
  }));
  app.post(`${one}/cancel-execution`, (c) => jsonErrors(c, async () => {
    requireHumanAuth(await requireAuth(c.req.raw, c.env));
    return retired(c);
  }));

  // The answer is the same for every page, so it says nothing about a page the caller cannot read.
  app.get(ofPage, (c) => jsonErrors(c, async () => {
    await requireAuth(c.req.raw, c.env);
    return c.json({ automations: [] }, 200, NO_STORE);
  }));
  app.on("POST", [`${ofPage}/:automationId/pause`, `${ofPage}/:automationId/resume`, `${ofPage}/:automationId/run`],
    (c) => jsonErrors(c, async () => {
      await requireAuth(c.req.raw, c.env);
      return retired(c);
    }));
  app.delete(`${ofPage}/:automationId`, (c) => jsonErrors(c, async () => {
    await requireAuth(c.req.raw, c.env);
    return retired(c);
  }));
}
