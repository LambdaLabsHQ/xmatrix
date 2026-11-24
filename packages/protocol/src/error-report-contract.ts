import type { ErrorEvent, Exception, StackFrame } from "@sentry/core";
import {
  admitsDiagnosticField, isDiagnosticCode, isDiagnosticId, isErrorClass, type DiagnosticField,
} from "./diagnostic-events.js";

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
 * paths under a home directory and token-shaped strings removed, and the
 * structured operational evidence its reporters declare (`SERVER_EXTRA`).
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

/** A name code gave a function, class, query or operation: `PostgresMachineDaemonPort.refresh`, `op:content.ref.commit`, `40P01`. */
const CODE_IDENTIFIER = /^[A-Za-z0-9_$][\w$.:<>-]{0,159}$/u;
/** Function names a reporter listed: `verifyCredential,MachineDaemonPort.refresh`. */
const CODE_IDENTIFIER_LIST = /^[A-Za-z_$][\w$.<>]{0,119}(?:,[A-Za-z_$][\w$.<>]{0,119}){1,7}$/u;

/** Whether a value lists code identifiers, such as a logged `origin` of function names. */
export const isCodeIdentifierList = (value: unknown): value is string =>
  typeof value === "string" && CODE_IDENTIFIER_LIST.test(value);

/**
 * A structured extra's shape. Leaves are diagnostic fields or code-written
 * text (an `identifier` or a fixed `pattern`); an object keeps only its declared fields and a list only its
 * first `max` items. A value outside its shape is dropped, never cut to fit.
 */
type ExtraShape =
  | DiagnosticField
  | { kind: "identifier" }
  | { kind: "pattern"; pattern: RegExp }
  | { kind: "either"; of: readonly ExtraShape[] }
  | { kind: "list"; max: number; item: ExtraShape }
  | { kind: "record"; fields: Readonly<Record<string, ExtraShape>> };

const identifier: ExtraShape = { kind: "identifier" };
const code: ExtraShape = { kind: "code" };
const flag: ExtraShape = { kind: "boolean" };
const durationMs: ExtraShape = { kind: "number", min: 0, max: 120_000, integer: true };
const httpStatus: ExtraShape = { kind: "number", min: 0, max: 599, integer: true };
const record = (fields: Record<string, ExtraShape>): ExtraShape => ({ kind: "record", fields });
const list = (max: number, item: ExtraShape): ExtraShape => ({ kind: "list", max, item });

const backend = record({
  state: { kind: "enum", values: ["active", "idle in transaction", "idle in transaction (aborted)", "idle", "unknown"] },
  wait: identifier, owner: identifier, ageMs: durationMs, queryName: code, queryAgeMs: durationMs, stateAgeMs: durationMs,
});
const lockWait = record({ status: code, waiter: backend, blockers: list(4, backend) });
const ROUTE_TEMPLATE = /^(?:GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD) (?:\*|(?:\/(?:[a-z][a-z0-9-]*|:[A-Za-z]+|\*))+)$/u;
const DEADLOCK_EDGE =String.raw`[1-8]>[1-8]:[A-Za-z]+:(?:transaction|relation|tuple|object)`;

/**
 * Operational evidence Hub reporters attach as `extra` (packages/hub, db):
 * attempts, phases, codes, error classes, durations, statuses and code
 * names, never a message body. A `json` extra is JSON-encoded by its reporter
 * and leaves re-encoded in its declared shape, the string Sentry's issue
 * reader parses. Any other non-scalar extra is dropped.
 */
const SERVER_EXTRA: Readonly<Record<string, { json: boolean; shape: ExtraShape }>> = {
  database_failure_attempts: { json: true, shape: list(4, record({
    operation: identifier, shardId: identifier, statement: code, phase: code, queryName: identifier, code: identifier,
    durationMs, driverReason: code, lockWait, queryWait: lockWait,
    session: record(Object.fromEntries(["wallMs", "queueMs", "checkoutMs", "beginMs", "sqlMs", "sqlMaxMs", "commitMs",
      "roundTrips", "queries"].map((key) => [key, durationMs]))),
  })) },
  message_search_failure: { json: true, shape: record({
    channelFiltered: flag, authorFilter: code, resumed: flag, cursorPresent: flag,
    scanned: { kind: "number", min: 0, max: 20_000, integer: true },
    requested: { kind: "number", min: 0, max: 1_000, integer: true },
  }) },
  cli_release_notice_failure: { json: true, shape: list(32, record({
    channel: code, phase: code, attempt: { kind: "number", min: 1, max: 2, integer: true }, durationMs,
    responseStatus: httpStatus,
  })) },
  apple_commerce_watch_failure: { json: true, shape: list(8, record({
    phase: code, status: httpStatus, kind: code, code: identifier, retryRecorded: flag,
  })) },
  harness_release_watch_failure: { json: true, shape: record({
    phase: code, durationMs, responseStatus: httpStatus, retryable: flag, overloaded: flag,
  }) },
  durable_object_failure: { json: true, shape: record({
    // A code boundary (`PageSession.fetch`) or a route template (`POST /api/spaces/:id`).
    operation: { kind: "either", of: [identifier, { kind: "pattern", pattern: ROUTE_TEMPLATE }] }, retryable: flag, overloaded: flag,
    socket: record({ cell: code, durationMs, remote: { kind: "either", of: [flag, { kind: "enum", values: ["unavailable"] }] },
      reason: code }),
  }) },
  postgres_conflict_locks: { json: false, shape: { kind: "pattern",
    pattern: new RegExp(`^(?:unavailable|${DEADLOCK_EDGE}(?:;${DEADLOCK_EDGE}){0,3})$`, "u") } },
};

/** The part of a value its shape admits; undefined when none is. */
function projectExtra(shape: ExtraShape, value: unknown): unknown {
  switch (shape.kind) {
    case "identifier": return typeof value === "string" && CODE_IDENTIFIER.test(value) ? value : undefined;
    case "pattern": return typeof value === "string" && shape.pattern.test(value) ? value : undefined;
    case "either": {
      for (const option of shape.of) {
        const kept = projectExtra(option, value);
        if (kept !== undefined) return kept;
      }
      return undefined;
    }
    case "list": {
      if (!Array.isArray(value)) return undefined;
      const items = value.slice(0, shape.max).map((item) => projectExtra(shape.item, item))
        .filter((item) => item !== undefined);
      return items.length ? items : undefined;
    }
    case "record": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const kept: Record<string, unknown> = {};
      for (const [key, field] of Object.entries(shape.fields)) {
        const item = Object.hasOwn(value, key) ? projectExtra(field, (value as Record<string, unknown>)[key]) : undefined;
        if (item !== undefined) kept[key] = item;
      }
      return Object.keys(kept).length ? kept : undefined;
    }
    default: return admitsDiagnosticField(shape, value) ? value : undefined;
  }
}

/** A declared structured extra in its shape and its reporter's encoding, or nothing. */
function structuredExtra(key: string, value: unknown): unknown {
  const declared = SERVER_EXTRA[key]!;
  if (!declared.json) return projectExtra(declared.shape, value);
  if (typeof value !== "string" || value.length > 16_384) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return undefined; }
  const kept = projectExtra(declared.shape, parsed);
  return kept === undefined ? undefined : JSON.stringify(kept);
}

function scalarExtra(extra: Record<string, unknown> | undefined, structured: boolean): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (!/^[A-Za-z][\w]{0,39}$/u.test(key)) continue;
    if (structured && Object.hasOwn(SERVER_EXTRA, key)) {
      const projected = structuredExtra(key, value);
      if (projected !== undefined) kept[key] = projected;
    } else if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)) || isDiagnosticId(value)) {
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
  /** Whether the reporters' declared structured extras (`SERVER_EXTRA`) may leave. */
  structured: boolean;
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
    extra: scalarExtra(event.extra, text.structured),
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
  return rebuild(event, { exception: (_, outermost) => outermost ? code : undefined, message: () => undefined, structured: false });
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
  return rebuild(event, { exception: (value) => scrub(value.value), message: scrub, structured: true });
}
