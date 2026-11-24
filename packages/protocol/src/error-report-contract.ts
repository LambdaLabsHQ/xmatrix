import type { ErrorEvent, Exception, StackFrame } from "@sentry/core";
import { isDiagnosticCode, isDiagnosticId, isErrorClass } from "./diagnostic-events.js";

/**
 * What an error report may carry when it leaves for Sentry
 * (docs/guide/privacy.md). The report is rebuilt from an allowlist rather
 * than scrubbed in place: the error's class, a stable code, the stack's code
 * locations, the release and the operation and opaque ids the reporting code
 * named. Breadcrumbs, request URLs, people, logged arguments and any field an
 * SDK adds later never pass.
 *
 * The two producers differ only in an error's own text. A browser report
 * (`clientErrorReport`) never carries it: the error is its class and, when the
 * error has one, its code. A Hub or Web Worker report (`serverErrorReport`)
 * keeps the server's own message with quoted values, emails, URL queries,
 * paths under a home directory and token-shaped strings removed.
 */

/** A function name in a stack frame: `Object.load`, `new Foo`, `<anonymous>`. */
const FRAME_FUNCTION = /^[\w$.<>[\] /*@-]{1,160}$/u;
/** A script location without its query: `https://…/chunk.js`, `app:///index.js`, `node:internal/…`, `/srv/index.js`. */
const CODE_LOCATION = /^(?:[a-z][a-z0-9+.-]*:[^\s"'`<>]{1,400}|\/[^\s"'`<>]{1,400}|<anonymous>|native)$/u;
/** A mechanism, tag value or operation the reporting code wrote: `onunhandledrejection`, `POST /api/spaces/:id`. */
const LABEL = /^[A-Za-z0-9][\w .:/@#*()'-]{0,119}$/u;
/** Browser, OS and runtime names and versions. */
const ENVIRONMENT_FACT = /^[\w .()/+,;-]{1,200}$/u;
const SERVER_TEXT_MAX = 400;

const TAGS = new Set(["component", "operation"]);

const locationOf = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const location = value.replace(/[?#].*$/su, "");
  return CODE_LOCATION.test(location) ? location : undefined;
};

const labelOf = (value: unknown) => typeof value === "string" && LABEL.test(value) ? value : undefined;

function defined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) if (value[key] === undefined) delete value[key];
  return value;
}

function frame(input: StackFrame): StackFrame {
  return defined({
    filename: locationOf(input.filename),
    abs_path: locationOf(input.abs_path),
    function: typeof input.function === "string" && FRAME_FUNCTION.test(input.function) ? input.function : undefined,
    lineno: Number.isSafeInteger(input.lineno) ? input.lineno : undefined,
    colno: Number.isSafeInteger(input.colno) ? input.colno : undefined,
    in_app: typeof input.in_app === "boolean" ? input.in_app : undefined,
  });
}

function exception(input: Exception, value: string | undefined): Exception {
  const mechanism = input.mechanism;
  const stackOrigin = mechanism?.data?.stack_origin;
  return defined({
    type: isErrorClass(input.type) ? input.type : "Error",
    value,
    mechanism: mechanism ? defined({
      type: labelOf(mechanism.type) ?? "generic",
      handled: typeof mechanism.handled === "boolean" ? mechanism.handled : undefined,
      synthetic: typeof mechanism.synthetic === "boolean" ? mechanism.synthetic : undefined,
      data: stackOrigin === "capture_boundary" ? { stack_origin: stackOrigin } : undefined,
    }) : undefined,
    stacktrace: input.stacktrace?.frames ? { frames: input.stacktrace.frames.map(frame) } : undefined,
  });
}

function scalarExtra(extra: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z][\w]{0,39}$/u.test(key)) continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || isDiagnosticId(value)) {
      kept[key] = value;
    } else if (key === "script" && locationOf(value)) {
      kept[key] = locationOf(value);
    }
  }
  return Object.keys(kept).length ? kept : undefined;
}

function environmentContexts(contexts: ErrorEvent["contexts"]): ErrorEvent["contexts"] {
  if (!contexts) return undefined;
  const kept: Record<string, Record<string, string>> = {};
  for (const name of ["os", "browser", "runtime", "device"] as const) {
    const context = contexts[name] as Record<string, unknown> | undefined;
    if (!context) continue;
    const facts: Record<string, string> = {};
    for (const key of ["name", "version", "family", "model"]) {
      const value = context[key];
      if (typeof value === "string" && ENVIRONMENT_FACT.test(value)) facts[key] = value;
    }
    if (Object.keys(facts).length) kept[name] = facts;
  }
  return Object.keys(kept).length ? kept : undefined;
}

function rebuild(event: ErrorEvent, text: {
  exception: (input: Exception, outermost: boolean) => string | undefined;
  message: (message: string) => string | undefined;
}): ErrorEvent {
  const values = event.exception?.values ?? [];
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(event.tags ?? {})) {
    const label = TAGS.has(key) ? labelOf(value) : undefined;
    if (label) tags[key] = label;
  }
  const userAgent = event.request?.headers?.["User-Agent"] ?? event.request?.headers?.["user-agent"];
  const message = typeof event.message === "string" ? text.message(event.message) : undefined;
  return defined({
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    logger: labelOf(event.logger),
    release: event.release,
    dist: event.dist,
    environment: event.environment,
    sdk: event.sdk,
    debug_meta: event.debug_meta,
    fingerprint: event.fingerprint?.every((part) => labelOf(part) || part === "{{ default }}") ? event.fingerprint : undefined,
    message,
    exception: values.length
      ? { values: values.map((value, index) => exception(value, text.exception(value, index === values.length - 1))) }
      : undefined,
    tags: Object.keys(tags).length ? tags : undefined,
    extra: scalarExtra(event.extra),
    contexts: environmentContexts(event.contexts),
    request: typeof userAgent === "string" && ENVIRONMENT_FACT.test(userAgent) ? { headers: { "User-Agent": userAgent } } : undefined,
  }) as ErrorEvent;
}

/** An error's code when it carries a stable one (`error.code = "rate_limited"`). */
function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return isDiagnosticCode(code) ? code : undefined;
}

/**
 * A browser error report: the error's class, its code when it has one, and
 * the code locations of its stack. Nothing an error says is sent; a report
 * without an exception (a captured message) is not sent at all.
 */
export function clientErrorReport(event: ErrorEvent, originalException: unknown): ErrorEvent | null {
  if (!event.exception?.values?.length) return null;
  const code = errorCode(originalException);
  return rebuild(event, { exception: (_, outermost) => outermost ? code : undefined, message: () => undefined });
}

/**
 * Server text as it may leave: quoted values, Postgres key details, emails,
 * URL queries, paths under a home directory and anything shaped like a token
 * or key are replaced, and the text is bounded.
 */
export function scrubDiagnosticText(text: string): string {
  return text
    .replace(/(["'`])(?:(?!\1)[^\n]){0,500}\1/gu, "$1…$1")
    .replace(/\(([^()]{0,200})\)=\(([^()]{0,500})\)/gu, "(…)=(…)")
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu, "<email>")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]+)[?#]\S*/giu, "$1?…")
    .replace(/(\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s]+/gu, "$1…")
    .replace(/\b(bearer|token|secret|password|key)(["']?\s*[:=]\s*["']?|\s+)[^\s"',;]+/giu, "$1$2…")
    // A token or key mixes letters and digits; a long code (`machine_command_result_mismatch`) does not.
    .replace(/(?=[A-Za-z0-9_\-+/]*\d)(?=[A-Za-z0-9_\-+/]*[A-Za-z])[A-Za-z0-9_\-+/]{32,}={0,2}/gu, "…")
    .slice(0, SERVER_TEXT_MAX);
}

/**
 * A Hub or Web Worker error report: the allowlisted shape, with the
 * server's own message and exception text scrubbed (`scrubDiagnosticText`).
 */
export function serverErrorReport(event: ErrorEvent): ErrorEvent {
  const scrub = (value: string | undefined) => value === undefined ? undefined : scrubDiagnosticText(value);
  return rebuild(event, { exception: (value) => scrub(value.value), message: scrub });
}
