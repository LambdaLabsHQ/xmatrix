/**
 * A table's columns fit what they hold, so a long cell would squeeze its
 * short neighbours until "10/28 三" or "16:00 租板" broke in two. A cell
 * about as wide as a date or a time keeps to one line; longer cells wrap.
 * CJK characters count double, as they are drawn about twice as wide.
 */
const SHORT_CELL_WIDTH = 14;

export function isShortCell(text: string): boolean {
  let width = 0;
  for (const char of text.trim()) {
    width += /[⺀-鿿가-힯＀-￯]/u.test(char) ? 2 : 1;
    if (width > SHORT_CELL_WIDTH) return false;
  }
  return true;
}

export const SHORT_CELL_CLASS = "page-cell-short";

/** The same for a page drawn without the editor. */
export function markShortCells(target: HTMLElement) {
  for (const cell of target.querySelectorAll("td, th")) {
    if (isShortCell(cell.textContent ?? "")) cell.classList.add(SHORT_CELL_CLASS);
  }
}
