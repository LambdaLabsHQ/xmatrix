/**
 * The web Worker's error reporting, started on first use. `register()` in
 * instrumentation.ts does not reach every server bundle's copy of the
 * reporter (a route handler answered `reference: null` with a DSN set), so
 * every server caller starts it here; starting is idempotent. A build without
 * a DSN (local, self-hosted) reports nothing.
 */
export async function webErrorReporting() {
  if (!process.env.NEXT_PUBLIC_SENTRY_DSN) return null;
  const reporting = await import("@xmatrix/protocol/error-reporting");
  reporting.startErrorReporting({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    component: "web",
  });
  return reporting;
}
