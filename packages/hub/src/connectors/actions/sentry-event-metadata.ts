/** Diagnostic provenance only; never copy arbitrary tags, contexts or mechanism data. */
function token(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.@+-]{1,160}$/u.test(value) ? value : undefined;
}

export function sentryEventMetadata(event: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const time = event.dateCreated;
  if (typeof time === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(time) &&
      Number.isFinite(Date.parse(time))) lines.push(`Event time: ${time}`);
  const releaseValue = event.release;
  const release = token(releaseValue && typeof releaseValue === "object"
    ? (releaseValue as { version?: unknown }).version : releaseValue);
  if (release) lines.push(`Release: ${release}`);
  if (Array.isArray(event.tags)) {
    for (const tag of event.tags.slice(0, 100)) {
      if (!tag || typeof tag !== "object") continue;
      if (tag.key === "component" && ["hub", "web"].includes(tag.value)) lines.push(`Component: ${tag.value}`);
      if (tag.key === "environment" && token(tag.value)) lines.push(`Environment: ${tag.value}`);
      // The browser defect endpoint sets this prefix. Do not copy its action text.
      if (tag.key === "operation" && typeof tag.value === "string" && tag.value.startsWith("browser: ")) {
        lines.push("Capture boundary: browser defect endpoint");
      }
    }
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

export function sentryExceptionMechanism(value: Record<string, unknown>): string | undefined {
  const mechanism = value.mechanism;
  if (!mechanism || typeof mechanism !== "object") return undefined;
  const { type, handled, synthetic } = mechanism as { type?: unknown; handled?: unknown; synthetic?: unknown };
  const fields: string[] = [];
  if (token(type)) fields.push(type as string);
  if (typeof handled === "boolean") fields.push(`handled=${handled}`);
  if (typeof synthetic === "boolean") fields.push(`synthetic=${synthetic}`);
  return fields.length ? `Mechanism: ${fields.join(" · ")}` : undefined;
}
