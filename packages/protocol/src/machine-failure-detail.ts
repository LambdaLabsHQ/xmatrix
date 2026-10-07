/** Startup diagnostics cross into a shared Channel. Keep the cause and line
 * structure, removing credentials and machine-private absolute paths only. */
export function sanitizeMachineFailureDetail(raw: string): string {
  const text = raw
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/]+@/giu, "$1[REDACTED]@")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s?'"<>#]+)[?#][^\s'"<>]*/giu, "$1?[REDACTED]")
    .replace(/((?:authorization|proxy-authorization|cookie|set-cookie)\s*:)\s*[^\r\n]+/giu, "$1 [REDACTED]")
    .replace(/\b(?:bearer|basic)\s+[a-z0-9+/_.=~-]+/giu, "[REDACTED]")
    .replace(/((?:[a-z_]*token|password|passwd|secret|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s&;'")]+)/giu, "$1[REDACTED]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/gu, "[REDACTED]")
    .replace(/(^|[\s('"])(?:file:\/\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s'")]+/gu, "$1[local path]")
    .replace(/\r\n?/gu, "\n");
  const clean = Array.from(text).filter((c) => c === "\n" || c === "\t" || (c.codePointAt(0)! >= 0x20 && c !== "\x7f"));
  return clean.length > 2_000 ? `${clean.slice(0, 2_000).join("").trim()}...` : clean.join("").trim();
}
