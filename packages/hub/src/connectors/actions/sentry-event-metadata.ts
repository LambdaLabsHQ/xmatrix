import { parseDatabaseFailureEvidence } from "@xmatrix/db";
import { clientDefectAction } from "@xmatrix/protocol";

/** Diagnostic provenance only; never copy arbitrary tags, contexts or mechanism data. */
function token(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.@+-]{1,160}$/u.test(value) ? value : undefined;
}

export function sentryEventMetadata(event: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const time = timestamp("Event time", event.dateCreated);
  if (time) lines.push(time);
  const releaseValue = event.release;
  const release = token(releaseValue && typeof releaseValue === "object"
    ? (releaseValue as { version?: unknown }).version : releaseValue);
  if (release) lines.push(`Release: ${release}`);
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags.slice(0, 100)) {
      if (!tag || typeof tag !== "object") continue;
      if (tag.key === "component" && ["hub", "web"].includes(tag.value)) lines.push(`Component: ${tag.value}`);
      if (tag.key === "environment" && token(tag.value)) lines.push(`Environment: ${tag.value}`);
      if (tag.key === "operation" && typeof tag.value === "string" &&
          /^scheduled: (?:Account deletion maintenance|Channel deletion maintenance|Sentry event recovery|Gmail notification recovery and renewal|Harness release watch|Machine load history maintenance|(?:Teams|Google Chat|Feishu|Telegram) lifecycle maintenance)$/u.test(tag.value)) {
        lines.push(`Scheduled task: ${tag.value.slice("scheduled: ".length)}`);
      }
      // The browser defect endpoint sets this prefix. Only fixed application copy is readable.
      if (tag.key === "operation" && typeof tag.value === "string" && tag.value.startsWith("browser: ")) {
        lines.push("Capture boundary: browser defect endpoint");
        const action = clientDefectAction(tag.value.slice("browser: ".length));
        if (action) lines.push("Browser action: " + action);
      }
    }
  }
  // Sentry serializes SDK `extra` as `context` in its issue-event API.
  const extra = event.context;
  const attempts = extra && typeof extra === "object" ? (extra as Record<string, unknown>).database_failure_attempts : undefined;
  if (typeof attempts === "string" && attempts.length <= 4096) {
    try {
      for (const [index, failure] of parseDatabaseFailureEvidence(JSON.parse(attempts)).entries()) {
        lines.push(`Database failure ${index + 1}: ${failure.operation} · ${failure.shardId} · ${failure.statement} · ` +
          `${failure.phase} · ${failure.queryName} · ${failure.code} · ${failure.durationMs} ms`);
      }
    } catch { /* Malformed optional diagnostics do not fail the issue read. */ }
  }
  const sdk = event.sdk;
  if (sdk && typeof sdk === "object") {
    const { name, version } = sdk as { name?: unknown; version?: unknown };
    if (token(name)) lines.push(`SDK: ${name}${token(version) ? ` ${version}` : ""}`);
  }
  const contexts = event.contexts;
  if (contexts && typeof contexts === "object") {
    for (const key of ["browser", "runtime"] as const) {
      const context = (contexts as Record<string, unknown>)[key];
      if (!context || typeof context !== "object") continue;
      const { name, version } = context as { name?: unknown; version?: unknown };
      if (typeof name === "string" && /^[A-Za-z0-9_. +()-]{1,80}$/u.test(name)) {
        lines.push(`${key}: ${name}${token(version) ? ` ${version}` : ""}`);
      }
    }
  }
  return [...new Set(lines)];
}

function timestamp(label: string, value: unknown): string | undefined {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value) &&
      Number.isFinite(Date.parse(value))) return `${label}: ${value}`;
}

export function sentryIssueMetadata(issue: Record<string, unknown>): string[] {
  const count = issue.count;
  return [
    ((typeof count === "string" && /^\d{1,16}$/u.test(count)) || typeof count === "number") &&
      Number.isSafeInteger(Number(count)) && Number(count) >= 0 ? `Occurrences: ${count}` : undefined,
    timestamp("First seen", issue.firstSeen), timestamp("Last seen", issue.lastSeen),
  ].filter((line): line is string => line !== undefined);
}

export function sentryExceptionMechanism(value: Record<string, unknown>): string | undefined {
  const mechanism = value.mechanism;
  if (!mechanism || typeof mechanism !== "object") return undefined;
  const { type, handled, synthetic } = mechanism as { type?: unknown; handled?: unknown; synthetic?: unknown };
  const fields: string[] = [];
  if (token(type)) fields.push(type as string);
  if (typeof handled === "boolean") fields.push(`handled=${handled}`);
  if (typeof synthetic === "boolean") fields.push(`synthetic=${synthetic}`);
  // This one fixed diagnostic label is emitted by our Worker reporter. Never
  // export arbitrary mechanism data or imply these are originating frames.
  const data = (mechanism as { data?: { stack_origin?: unknown } }).data;
  if (data?.stack_origin === "capture_boundary") fields.push("stack=capture boundary (origin unavailable)");
  return fields.length ? `Mechanism: ${fields.join(" · ")}` : undefined;
}
