import type { Instrumentation } from "next";

import { webErrorReporting } from "./lib/server-error-reporting";

export async function register() {
  await webErrorReporting();
}

/** A server error Next.js answers itself, sent before the Worker invocation ends. */
export const onRequestError: Instrumentation.onRequestError = async (error) => {
  const reporting = await webErrorReporting();
  if (!reporting) return;
  reporting.reportError(error);
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  getCloudflareContext().ctx.waitUntil(reporting.sendErrorReports());
};
