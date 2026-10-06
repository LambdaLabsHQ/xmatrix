/** Read one bounded numeric Node test option, preserving optional defaults. */
export function positiveIntegerFlag(name, { fallback, required = false } = {}) {
  const prefix = `${name}=`;
  const raw = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  if (!raw && !required) return fallback;
  const value = Number(raw?.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
