import { clientErrorReport } from "@xmatrix/protocol";

import { diagnosticsMaySendNow, isDiagnosticsEnabled, subscribeDiagnosticsPreference } from "./lib/diagnostics-preference";
import { earlyScriptLocation, isBrowserNoticeReport, isStaleBuild } from "./lib/error-noise";

// The Desktop and iOS apps load this same Web app, so this also reports their
// page errors once the signed-in user opts in. Unauthenticated marketing and
// legal pages never load Sentry, and builds without a DSN report nothing.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Only signed-in app routes may initialize browser Sentry. */
const isSignedInAppRoute = () => {
  const pathname = typeof window === "undefined" ? "" : window.location.pathname;
  return pathname === "/app" || pathname.startsWith("/app/");
};

/** Uncaught errors and rejections raised before error reporting has loaded. */
const early: { error: unknown; where: ReturnType<typeof earlyScriptLocation> }[] = [];
const holdError = (event: ErrorEvent) => {
  early.push({ error: event.error ?? event.message, where: earlyScriptLocation(event) });
};
const holdRejection = (event: PromiseRejectionEvent) => { early.push({ error: event.reason, where: {} }); };

let initialized = false;

// Error reporting is not part of the first screen: it loads once the page has
// loaded and the browser is idle. What fails before then is held here and sent
// when it starts, through the same filters as everything after.
async function startErrorReporting(dsn: string) {
  const { captureException, init } = await import("@sentry/browser");
  init({
    dsn,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    environment: "production",
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    tracesSampleRate: 0,
    // A report never carries breadcrumbs (clicks, console lines, URLs), so none are collected.
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Breadcrumbs" && integration.name !== "Console"),
    async beforeSend(event, hint) {
      if (!isSignedInAppRoute()) return null;
      // A reload fixes a stale build, and the failure screen offers it; neither is a defect to report.
      if (isStaleBuild(hint.originalException) || isBrowserNoticeReport(hint.originalException, event)) return null;
      // Decided per report, against a current answer from the Hub: a switch
      // turned off, or a move into a country that needs consent, stops it.
      if (!await diagnosticsMaySendNow()) return null;
      // The error's class, code and stack locations only: never what it said (protocol error-report-contract).
      return clientErrorReport(event, hint.originalException);
    },
  });
  removeEventListener("error", holdError);
  removeEventListener("unhandledrejection", holdRejection);
  for (const held of early.splice(0)) {
    const extra: Record<string, string | number> = {};
    if (held.where.script !== undefined) extra.script = held.where.script;
    if (held.where.line !== undefined) extra.line = held.where.line;
    if (held.where.column !== undefined) extra.column = held.where.column;
    // `mechanism` and `extra` are exclusive on this capture call. The location
    // is capture context, which is what a later report shows.
    captureException(held.error, {
      mechanism: { type: "onerror", handled: false },
      ...(Object.keys(extra).length > 0 ? { captureContext: { extra } } : {}),
    });
  }
}

function maybeStartErrorReporting() {
  if (initialized || !dsn || !isSignedInAppRoute() || !isDiagnosticsEnabled()) return;
  initialized = true;
  addEventListener("error", holdError);
  addEventListener("unhandledrejection", holdRejection);
  // A stale build cannot load the chunk; the page offers a reload for that.
  const load = () => void startErrorReporting(dsn).catch(() => undefined);
  // Safari, and so the iOS app, has no idle callback.
  const start = () => "requestIdleCallback" in window ? requestIdleCallback(load, { timeout: 2_000 }) : setTimeout(load, 1);
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}

if (dsn && typeof window !== "undefined") {
  maybeStartErrorReporting();
  subscribeDiagnosticsPreference(maybeStartErrorReporting);
}
