/** Validate boundary values while keeping each authority's error contract. */
export function requireSafeIntegerRange(value: unknown, minimum: number, maximum: number,
  invalid: () => Error): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid();
  }
  return value as number;
}

export function requireLowercaseSha256(value: unknown, invalid: () => Error): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw invalid();
  return value;
}

/** Whether `value` holds a C0 control character or DEL (U+0000–U+001F, U+007F). */
export function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Replace each C0 control character or DEL in `value`, except those in `keep`. */
export function replaceControlCharacters(value: string, replacement = "", keep = ""): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += (code < 0x20 || code === 0x7f) && !keep.includes(character) ? replacement : character;
  }
  return result;
}
