/** Shared canonical JSON primitives for Relay V2 wire and storage formats.
 * Object keys sort by UTF-16 code unit; a value JSON cannot carry exactly
 * (undefined, a function, a non-finite number) throws instead of encoding. */

export function isCanonicalJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(",")}]`;
  }
  if (isCanonicalJsonRecord(value)) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonical JSON cannot contain a non-finite number");
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("canonical JSON cannot contain undefined");
  return encoded;
}
