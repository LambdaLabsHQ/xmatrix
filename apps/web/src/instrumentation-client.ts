import { isBrowserNoticeReport, isStaleBuild } from "./lib/error-noise";

// The Desktop and iOS apps load this same Web app, so this also reports their
// page errors. A build without a DSN (local, self-hosted) reports nothing.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** A URL without its query and fragment, which can carry one-time codes. */
const pathOnly = (url: string) => url.replace(/[?#].*$/u, "");

/** Uncaught errors and rejections raised before error reporting has loaded. */
const early: unknown[] = [];
const holdError = (event: ErrorEvent) => { early.push(event.error ?? event.message); };
const holdRejection = (event: PromiseRejectionEvent) => { early.push(event.reason); };

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
    // Console lines may quote message content, so they never become breadcrumbs.
    integrations: (defaults) => defaults.filter((integration) => integration.name !== "Console"),
    beforeBreadcrumb(breadcrumb) {
      for (const key of ["url", "from", "to"] as const) {
        const value = breadcrumb.data?.[key];
        if (typeof value === "string") breadcrumb.data![key] = pathOnly(value);
      }
      return breadcrumb;
    },
    beforeSend(event, hint) {
      // A reload fixes a stale build, and the failure screen offers it; neither is a defect to report.
      if (isStaleBuild(hint.originalException) || isBrowserNoticeReport(hint.originalException, event)) return null;
      if (event.request?.url) event.request = { url: pathOnly(event.request.url) };
      delete event.user;
      return event;
    },
  });
  removeEventListener("error", holdError);
  removeEventListener("unhandledrejection", holdRejection);
  for (const error of early.splice(0)) {
    captureException(error, { mechanism: { type: "onerror", handled: false } });
  }
}

if (dsn) {
  addEventListener("error", holdError);
  addEventListener("unhandledrejection", holdRejection);
  // A stale build cannot load the chunk; the page offers a reload for that.
  const load = () => void startErrorReporting(dsn).catch(() => undefined);
  // Safari, and so the iOS app, has no idle callback.
  const start = () => "requestIdleCallback" in window ? requestIdleCallback(load, { timeout: 2_000 }) : setTimeout(load, 1);
  if (document.readyState === "complete") start();
  else addEventListener("load", start, { once: true });
}
