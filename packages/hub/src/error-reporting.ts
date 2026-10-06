import { startErrorReporting } from "@xmatrix/protocol/error-reporting";

// The production release compiles its DSN and tag in (`wrangler deploy
// --define`), so the Worker and every Durable Object report from module load.
// Any other build leaves them undefined and reports nothing.
declare const XMATRIX_SENTRY_DSN: string | undefined;
declare const XMATRIX_SENTRY_RELEASE: string | undefined;

startErrorReporting({
  dsn: typeof XMATRIX_SENTRY_DSN === "string" ? XMATRIX_SENTRY_DSN : undefined,
  release: typeof XMATRIX_SENTRY_RELEASE === "string" ? XMATRIX_SENTRY_RELEASE : undefined,
  component: "hub",
});
