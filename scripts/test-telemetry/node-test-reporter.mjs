import path from "node:path";

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function safeCounts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = {};
  for (const key of ["tests", "failed", "passed", "cancelled", "skipped", "todo", "topLevel", "suites"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return result;
}

function portableFileName(file, rootDirectory) {
  if (typeof file !== "string" || file.length === 0) return null;
  const absoluteRoot = path.resolve(rootDirectory);
  const absoluteFile = path.resolve(absoluteRoot, file);
  const relative = path.relative(absoluteRoot, absoluteFile);
  if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  // Never put an absolute runner-local path into the audit artifact.
  return path.basename(absoluteFile);
}

function timeoutFailure(error) {
  const seen = new Set();
  let current = error;
  for (let depth = 0; current && typeof current === "object" && depth < 5; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    const markers = [current.failureType, current.code, current.name, current.type];
    if (markers.some((value) => typeof value === "string" && /timeout/i.test(value))) return true;
    current = current.cause;
  }
  return false;
}

export function sanitizeNodeTestEvent(event, rootDirectory) {
  if (!event || typeof event !== "object" || !event.data || typeof event.data !== "object") return null;
  const data = event.data;
  const file = portableFileName(data.file, rootDirectory);
  if (!file) return null;

  if (event.type === "test:summary") {
    return {
      kind: "file_summary",
      file,
      durationMs: finiteNonnegative(data.duration_ms),
      counts: safeCounts(data.counts),
      success: typeof data.success === "boolean" ? data.success : null,
    };
  }

  if (event.type === "test:complete") {
    const name = typeof data.name === "string" ? data.name.split(path.sep).join("/") : "";
    if (name !== file && path.basename(name) !== path.basename(file)) return null;
    return {
      kind: "file_complete",
      file,
      durationMs: finiteNonnegative(data.details?.duration_ms),
      passed: typeof data.details?.passed === "boolean" ? data.details.passed : null,
    };
  }

  if (event.type === "test:fail") {
    return {
      kind: "failure",
      file,
      timeout: timeoutFailure(data.details?.error),
    };
  }

  return null;
}

export default async function* telemetryReporter(source) {
  const rootDirectory = process.env.XMATRIX_TEST_TELEMETRY_ROOT || process.cwd();
  for await (const event of source) {
    const sanitized = sanitizeNodeTestEvent(event, rootDirectory);
    if (sanitized) yield `${JSON.stringify(sanitized)}\n`;
  }
}
