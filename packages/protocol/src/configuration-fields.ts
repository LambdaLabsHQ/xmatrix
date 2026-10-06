/** Unknown configuration keys are diagnostics, not configuration or authority.
 * Never log their values; return only an own-property allowlist projection. */
export function configurationFields(value: unknown, allowed: readonly string[], scope: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${scope}`);
  const row = value as Record<string, unknown>;
  const unknown = Object.keys(row).filter(key => !allowed.includes(key));
  if (unknown.length) console.warn("Unknown configuration fields discarded", {
    scope, count: unknown.length,
    fields: unknown.slice(0, 16).map(key => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/u.test(key) ? key : "<invalid-field-name>"),
  });
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
}
