"use client";

import { useLayoutEffect, type RefObject } from "react";

/** Headers that sit in the top band, where the search icon floats. */
const BAND_HEADERS = ".app-panel-header, .app-band-header, .app-tool-detail-header";
const CLEARED = "data-global-search-clearance";

/**
 * Any header in the top band that runs under the window's search icon ends
 * its controls before it: a conversation's ⋯ when no details column sits
 * beside it, a page's History and Share, a conversation docked beside a page.
 * The icon measures them, so no view has to know where it is.
 */
export function useGlobalSearchClearance(iconRef: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const iconElement = iconRef.current;
    if (!iconElement) return undefined;
    let frame = 0;
    let measuredHeaders: HTMLElement[] = [];
    let lastGeometry = "";
    const originalPadding = new Map<HTMLElement, string>();
    const clear = () => {
      for (const [header, padding] of originalPadding) {
        header.style.paddingRight = padding;
        header.removeAttribute(CLEARED);
      }
      originalPadding.clear();
    };
    const update = () => {
      frame = 0;
      const headers = Array.from(document.querySelectorAll<HTMLElement>(BAND_HEADERS));
      const icon = iconElement.getBoundingClientRect();
      const boxes = headers.map((header) => header.getBoundingClientRect());
      const geometry = [icon, ...boxes].map((box) => `${box.left}:${box.top}:${box.right}:${box.bottom}`).join(";");
      if (geometry === lastGeometry && headers.length === measuredHeaders.length &&
        headers.every((header, index) => header === measuredHeaders[index])) return;
      for (const header of measuredHeaders) if (!headers.includes(header)) resize.unobserve(header);
      for (const header of headers) if (!measuredHeaders.includes(header)) resize.observe(header);
      measuredHeaders = headers;
      lastGeometry = geometry;
      clear();
      if (!icon.width) return;
      const changes: Array<{ header: HTMLElement; padding: number }> = [];
      for (const header of headers) {
        const box = header.getBoundingClientRect();
        if (!box.width || box.bottom <= icon.top || box.top >= icon.bottom) continue;
        if (box.right <= icon.left || box.left >= icon.right) continue;
        const padding = parseFloat(getComputedStyle(header).paddingRight) || 0;
        changes.push({ header, padding: padding + box.right - icon.left + 12 });
      }
      for (const { header, padding } of changes) {
        originalPadding.set(header, header.style.paddingRight);
        header.style.paddingRight = `${padding}px`;
        header.setAttribute(CLEARED, "");
      }
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(document.body);
    resize.observe(iconElement);
    update();
    const mutations = new MutationObserver((records) => {
      // A message or a rotating composer hint cannot add/remove a top-band
      // header. Existing headers and the search icon report size changes
      // directly; only newly mounted or removed headers need discovery.
      const containsHeader = (node: Node) => node instanceof Element &&
        (node.matches(BAND_HEADERS) || node.querySelector(BAND_HEADERS) !== null);
      if (records.some((record) => [...record.addedNodes, ...record.removedNodes].some(containsHeader))) schedule();
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
  }, [iconRef]);
}
