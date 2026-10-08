import { init } from "@sentry/browser";
import { isBrowserNotice, isStaleBuild } from "./lib/error-noise";

// The Desktop and iOS apps load this same Web app, so this also reports their
// page errors. A build without a DSN (local, self-hosted) reports nothing.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** A URL without its query and fragment, which can carry one-time codes. */
const pathOnly = (url: string) => url.replace(/[?#].*$/u, "");

if (dsn) {
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
      if (isStaleBuild(hint.originalException) || isBrowserNotice(hint.originalException)) return null;
      if (event.request?.url) event.request = { url: pathOnly(event.request.url) };
      delete event.user;
      return event;
    },
  });
}
