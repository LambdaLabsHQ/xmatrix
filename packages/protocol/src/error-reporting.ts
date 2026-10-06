import {
  captureConsoleIntegration,
  captureException,
  createStackParser,
  createTransport,
  dedupeIntegration,
  flush,
  getGlobalScope,
  linkedErrorsIntegration,
  setCurrentClient,
} from "@sentry/core";
import { nodeStackLineParser, ServerRuntimeClient } from "@sentry/core/server";

/** Where a Worker reports errors: the deployment's DSN and release. */
export type ErrorReportingTarget = {
  dsn: string | undefined;
  release: string | undefined;
  component: "hub" | "web";
};

let reporting = false;

/**
 * Opens error reporting for this Worker isolate; without a DSN nothing is
 * ever sent. A report carries the error, its stack, the component and the
 * release. Nothing instruments bindings, requests or callers, and only
 * `console.error` lines are reported, as the failures the Worker logged.
 */
export function startErrorReporting({ dsn, release, component }: ErrorReportingTarget): void {
  if (!dsn || reporting) return;
  const client = new ServerRuntimeClient({
    dsn,
    release,
    environment: "production",
    platform: "javascript",
    runtime: { name: "cloudflare" },
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false },
    stackParser: createStackParser(nodeStackLineParser()),
    integrations: [
      dedupeIntegration(),
      linkedErrorsIntegration(),
      captureConsoleIntegration({ levels: ["error"] }),
    ],
    transport: (options) => createTransport(options, async ({ body }) => {
      const response = await fetch(options.url, { method: "POST", body: body as BodyInit });
      return {
        statusCode: response.status,
        headers: {
          "retry-after": response.headers.get("retry-after"),
          "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
        },
      };
    }),
  });
  getGlobalScope().setTag("component", component);
  setCurrentClient(client);
  client.init();
  reporting = true;
}

/** Reports a failure the Worker answers or logs instead of rethrowing. */
export function reportError(error: unknown): void {
  if (reporting) captureException(error);
}

/** Settles once the reports raised so far are sent; a Worker waits on it after answering. */
export function sendErrorReports(): Promise<unknown> {
  return reporting ? flush(2000) : Promise.resolve();
}
