import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HUB_ROUTES } from "@xmatrix/protocol";
import type { Env } from "./types";
import { jsonErrors, requireMachineDaemonAuth } from "./index-shared";
import { machineRunLifecycleReport } from "./machine-run-lifecycle-report";

import { executionReportCommand } from "./machine-execution-report-command";

export function registerMachineExecutionRoutes(app: Hono<{ Bindings: Env }>): void {
  app.post(HUB_ROUTES.daemon_execution_report, bodyLimit({ maxSize: 132 * 1024 }), c => jsonErrors(c, async () => {
    const principal = await requireMachineDaemonAuth(c.req.raw, c.env);
    const command = executionReportCommand(principal, await c.req.json().catch(() => null));
    if (!command) return c.json({ error: "Execution report request is invalid" }, 400);
    return c.json(await machineRunLifecycleReport(c.env, command), 200, { "cache-control": "private, no-store" });
  }));
}
