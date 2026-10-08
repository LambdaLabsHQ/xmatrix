"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Headers that sit in the top band, where the search capsule floats. */
const BAND_HEADERS = ".app-panel-header, .app-band-header, .app-tool-detail-header";
const CLEARED = "data-global-search-clearance";

/**
 * Any header in the top band that runs under the window's search capsule ends
 * its controls before it: a conversation's ⋯ when no details column sits
 * beside it, a page's History and Share, a conversation docked beside a page.
 * The capsule measures them, so no view has to know where it is.
 */
export function useGlobalSearchClearance(capsuleRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const capsuleElement = capsuleRef.current;
    if (!capsuleElement) return undefined;
    let frame = 0;
    const clear = () => {
      for (const header of Array.from(document.querySelectorAll<HTMLElement>(`[${CLEARED}]`))) {
        header.style.paddingRight = "";
        header.removeAttribute(CLEARED);
      }
    };
    const update = () => {
      frame = 0;
      clear();
      const capsule = capsuleElement.getBoundingClientRect();
      if (!capsule.width) return;
      for (const header of Array.from(document.querySelectorAll<HTMLElement>(BAND_HEADERS))) {
        const box = header.getBoundingClientRect();
        if (!box.width || box.bottom <= capsule.top || box.top >= capsule.bottom) continue;
        if (box.right <= capsule.left || box.left >= capsule.right) continue;
        const padding = parseFloat(getComputedStyle(header).paddingRight) || 0;
        header.style.paddingRight = `${padding + box.right - capsule.left + 12}px`;
        header.setAttribute(CLEARED, "");
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    const mutations = new MutationObserver((records) => {
      // Our own padding writes are attribute changes on cleared headers; only structure re-measures.
      if (records.some((record) => record.type === "childList")) schedule();
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      clear();
    };
  }, [capsuleRef]);
}
