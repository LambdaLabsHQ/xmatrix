import {
  captureConsoleIntegration,
  captureException,
  createStackParser,
  createTransport,
  dedupeIntegration,
  flush,
  getGlobalScope,
  linkedErrorsIntegration,
  rewriteFramesIntegration,
  setCurrentClient,
  type ErrorEvent,
  type StackFrame,
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
 * A Worker names its bundled module bare (`index.js`). The release uploads that
 * bundle's source map under `app:///`, so a bare frame is reported there and
 * resolves to `src/`; paths with a scheme or a root are left as they are.
 */
export function bundleFrame(frame: StackFrame): StackFrame {
  const filename = frame.filename;
  if (!filename || filename.startsWith("/") || /^[a-z][a-z0-9+.-]*:/iu.test(filename)) return frame;
  return { ...frame, filename: `app:///${filename}`, abs_path: `app:///${filename}` };
}

const CONSOLE_LINE_LIMIT = 400;

function scalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value) : undefined;
}

/**
 * One logged line as its report's title. A Worker logs a sentence and an
 * object of facts (`console.error("… rejection", { code, status })`); joined
 * as strings the object reads `[object Object]`, so every failure logged under
 * one sentence looked the same. The object's scalar fields are spelled out
 * instead; nested values stay in the report's arguments.
 */
export function consoleLine(args: readonly unknown[]): string {
  const parts = args.map((arg) => {
    if (!arg || typeof arg !== "object" || Array.isArray(arg)) return scalar(arg) ?? "";
    return Object.entries(arg).map(([key, value]) => {
      const text = Array.isArray(value)
        ? value.map(scalar).filter((item) => item !== undefined).join(",") : scalar(value);
      return text === undefined || text === "" ? "" : `${key}=${text}`;
    }).filter(Boolean).join(" ");
  });
  return parts.filter(Boolean).join(" ").slice(0, CONSOLE_LINE_LIMIT);
}

/** Titles a captured `console.error` report with the facts it logged. */
function titleConsoleReport(event: ErrorEvent): ErrorEvent {
  const args = event.extra?.arguments;
  if (event.logger !== "console" || !Array.isArray(args) || !args.some((arg) => arg && typeof arg === "object")) {
    return event;
  }
  const line = consoleLine(args);
  if (!line) return event;
  if (event.message !== undefined) event.message = line;
  const logged = event.exception?.values;
  if (logged?.length === 1 && logged[0]!.mechanism?.synthetic) logged[0]!.value = line;
  return event;
}

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
    beforeSend: titleConsoleReport,
    integrations: [
      dedupeIntegration(),
      linkedErrorsIntegration(),
      rewriteFramesIntegration({ iteratee: bundleFrame }),
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

/**
 * What a boundary was doing when it failed: the operation (a route template or
 * a task name) and the opaque ids it acted on. Never content, never a person.
 */
export type ErrorReportContext = {
  operation: string;
  ids?: Record<string, string>;
};

/**
 * Reports a failure the Worker answers or logs instead of rethrowing, and
 * returns the report's id so the answer can quote it; none when not reporting.
 */
export function reportError(error: unknown, context?: ErrorReportContext): string | undefined {
  if (!reporting) return undefined;
  return captureException(error, context
    ? { tags: { operation: context.operation }, extra: context.ids ?? {} }
    : undefined);
}

/** Settles once the reports raised so far are sent; a Worker waits on it after answering. */
export function sendErrorReports(): Promise<unknown> {
  return reporting ? flush(2000) : Promise.resolve();
}
