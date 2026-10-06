/**
 * The key two sibling names collide on: NFC, whitespace collapsed, and
 * case-folded the same way in every store (Postgres and the relay authority),
 * so a name taken in one is taken in the other.
 */
export function portableNameKey(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim()
    .toLocaleLowerCase("en-US").replace(/ß/gu, "ss").replace(/ς/gu, "σ");
}
