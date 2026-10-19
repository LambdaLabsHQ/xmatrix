import type { Page } from "@playwright/test";

/** Virtuoso holds its scroll corrections in the list's margin only under this UA test. */
export const IPHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

/* On iPhone a scroll written while the reader is scrolling, or a size
   correction held as a top margin on react-virtuoso's list, blanks the list
   above a line cut through a row. Records each into `window.listCorrections`;
   the page sets `window.readerScrolling` around its own stand-in for the reader. */
export async function recordListCorrections(page: Page) {
  await page.addInitScript(() => {
    const probe = window as unknown as { listCorrections: string[]; readerScrolling: boolean };
    probe.listCorrections = [];
    probe.readerScrolling = false;
    const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop")!;
    Object.defineProperty(Element.prototype, "scrollTop", {
      ...scrollTop,
      set(value: number) {
        if (!probe.readerScrolling) probe.listCorrections.push(`scrollTop=${value}`);
        scrollTop.set!.call(this, value);
      },
    });
    for (const method of ["scrollBy", "scrollTo"] as const) {
      const original = Element.prototype[method] as (...args: unknown[]) => void;
      Element.prototype[method] = function (this: Element, ...args: unknown[]) {
        probe.listCorrections.push(`${method}(${JSON.stringify(args)})`);
        original.apply(this, args);
      } as typeof original;
    }
    new MutationObserver((records) => {
      for (const { target } of records) {
        const list = target as HTMLElement;
        if (list.dataset?.testid === "virtuoso-item-list" && parseFloat(list.style.marginTop || "0") !== 0) {
          probe.listCorrections.push(`margin-top: ${list.style.marginTop}`);
        }
      }
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ["style"] });
  });
}
