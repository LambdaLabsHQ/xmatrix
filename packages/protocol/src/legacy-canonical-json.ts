/**
 * Compatibility digest serialization: localeCompare key ordering, omitted
 * undefined object fields, and legacy array/primitive JSON behavior. New wire
 * formats continue to use their existing strict canonical JSON contract.
 */
export function legacyCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(legacyCanonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${legacyCanonicalJson(item)}`)
    .join(",")}}`;
}
