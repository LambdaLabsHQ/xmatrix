import type { Instrumentation } from "next";

// NEXT_PUBLIC_SENTRY_* are compiled into the server bundle as well; a build
// without a DSN (local, self-hosted) reports nothing.
export async function register() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const { startErrorReporting } = await import("@xmatrix/protocol/error-reporting");
  startErrorReporting({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    component: "web",
  });
}

/** A server error Next.js answers itself, sent before the Worker invocation ends. */
export const onRequestError: Instrumentation.onRequestError = async (error) => {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return;
  const { reportError, sendErrorReports } = await import("@xmatrix/protocol/error-reporting");
  reportError(error);
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  getCloudflareContext().ctx.waitUntil(sendErrorReports());
};
