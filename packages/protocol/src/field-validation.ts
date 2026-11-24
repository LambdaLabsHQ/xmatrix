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

/**
 * `value` without the trailing run of any of `characters`. A loop, not
 * `/[…]+$/`: that regex rescans every inner run and turns quadratic on
 * hostile input.
 */
export function trimEnd(value: string, characters: string): string {
  let end = value.length;
  while (end > 0 && characters.includes(value[end - 1]!)) end -= 1;
  return value.slice(0, end);
}

/** `value` without the leading or trailing run of any of `characters`. */
export function trimEdges(value: string, characters: string): string {
  let start = 0;
  while (start < value.length && characters.includes(value[start]!)) start += 1;
  return trimEnd(value.slice(start), characters);
}

/**
 * Drops NUL (U+0000) and replaces unpaired UTF-16 surrogates with U+FFFD so
 * `JSON.stringify` never emits Unicode escapes PostgreSQL `jsonb` rejects (22P05).
 */
export function postgresJsonText(value: string): string {
  let out = "";
  let chunkStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) {
      out += value.slice(chunkStart, index);
      chunkStart = index + 1;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      out += `${value.slice(chunkStart, index)}\uFFFD`;
      chunkStart = index + 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      out += `${value.slice(chunkStart, index)}\uFFFD`;
      chunkStart = index + 1;
    }
  }
  return chunkStart === 0 ? value : out + value.slice(chunkStart);
}

/** Slices at most `maxCodeUnits` UTF-16 code units without splitting a surrogate pair. */
export function sliceCodeUnitsSafe(value: string, maxCodeUnits: number): string {
  if (maxCodeUnits <= 0) return "";
  if (value.length <= maxCodeUnits) return value;
  let cut = maxCodeUnits;
  const last = value.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) {
    const next = value.charCodeAt(cut);
    if (next >= 0xdc00 && next <= 0xdfff) cut -= 1;
  }
  return value.slice(0, cut);
}
