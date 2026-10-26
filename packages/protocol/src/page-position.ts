/** A sibling order key that will not fit between its neighbours, or whose neighbours are reversed. */
export class PagePositionError extends Error {
  readonly code: "invalid_page_position" | "page_position_exhausted";

  constructor(code: PagePositionError["code"], message: string) {
    super(message);
    this.name = "PagePositionError";
    this.code = code;
  }
}

/**
 * Between two sibling positions (either may be absent), a key that sorts strictly between them.
 * The page store owns the order; a list may use the same key so a row lands where it was dropped
 * before the store's answer arrives.
 */
export function pagePositionBetween(before: string | null, after: string | null): string {
  const digits = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const lo = before ?? "";
  const hi = after ?? "";
  if (hi && lo >= hi) throw new PagePositionError("invalid_page_position", "positions are out of order");
  let result = "";
  for (let i = 0; ; i++) {
    const a = i < lo.length ? digits.indexOf(lo[i]!) : 0;
    const b = hi && i < hi.length ? digits.indexOf(hi[i]!) : digits.length;
    if (b - a > 1) return result + digits[Math.floor((a + b) / 2)]!;
    result += digits[a]!;
    if (result.length >= 99) throw new PagePositionError("page_position_exhausted", "no position is left between these siblings");
  }
}
