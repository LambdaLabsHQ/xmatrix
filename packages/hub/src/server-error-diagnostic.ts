import { replaceControlCharacters } from "@xmatrix/protocol";
const DIAGNOSTIC_TEXT_LIMIT = 1_000;
const DIAGNOSTIC_STACK_LIMIT = 4_000;
const DIAGNOSTIC_CAUSE_LIMIT = 4;

export interface ServerErrorDiagnostic {
  diagnosticId: string;
  causes: Array<{
    name: string;
    message: string;
    code?: string;
    stack?: string;
  }>;
}

export function safeServerDiagnosticId(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^diag_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
    ? value
    : undefined;
}

function boundedDiagnosticText(value: unknown, limit: number): string {
  return replaceControlCharacters(String(value ?? ""), "", "\t\n\r").slice(0, limit);
}

function errorCause(value: unknown): unknown {
  if (!value || typeof value !== "object" || !("cause" in value)) return undefined;
  return (value as { cause?: unknown }).cause;
}

export function captureServerErrorDiagnostic(
  event: string,
  error: unknown,
  context: Record<string, string | number | boolean | undefined> = {},
): ServerErrorDiagnostic {
  const diagnosticId = `diag_${crypto.randomUUID()}`;
  const safeContext = Object.fromEntries(
    Object.entries(context).slice(0, 16).map(([key, value]) => [
      boundedDiagnosticText(key, 80),
      typeof value === "string" ? boundedDiagnosticText(value, 240) : value,
    ]),
  );
  const causes: ServerErrorDiagnostic["causes"] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && causes.length < DIAGNOSTIC_CAUSE_LIMIT && !seen.has(current)) {
    seen.add(current);
    const record = current && typeof current === "object"
      ? current as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown }
      : undefined;
    const code = record?.code;
    causes.push({
      name: boundedDiagnosticText(record?.name || typeof current, 120),
      message: boundedDiagnosticText(record?.message ?? current, DIAGNOSTIC_TEXT_LIMIT),
      ...(typeof code === "string" || typeof code === "number"
        ? { code: boundedDiagnosticText(code, 160) }
        : {}),
      ...(typeof record?.stack === "string"
        ? { stack: boundedDiagnosticText(record.stack, DIAGNOSTIC_STACK_LIMIT) }
        : {}),
    });
    current = errorCause(current);
  }
  console.error("xMatrix server operation failed", {
    event: boundedDiagnosticText(event, 160),
    ...safeContext,
    diagnosticId,
    causes,
  });
  return { diagnosticId, causes };
}
