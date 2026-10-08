"use client";

import { useEffect, useRef } from "react";
import { OVERLAY_SCROLLBARS_ATTRIBUTE } from "./overlay-scrollbars-mode";

/**
 * Scrollbars that float over the content the way macOS and iOS draw them.
 *
 * Where the platform already overlays its scrollbars (macOS, iOS, Android)
 * nothing changes. Where it reserves a permanent gutter (Chrome and Electron on
 * Windows and Linux, or macOS set to always show them) the root layout marks
 * the document with `data-overlay-scrollbars`, globals.css hides the native
 * bars, and this layer draws a thin thumb over whatever is scrolling, fading
 * out shortly after it stops. A thumb under the pointer stays, widens and can
 * be dragged. Scrollers styled `scrollbar-width: none` keep no scrollbar.
 */

const HIDE_AFTER_MS = 900;
/** The hit area across the thumb; the visible pill sits inside it. */
const THICKNESS = 12;
const MIN_LENGTH = 28;
const INSET = 2;

/** Where a thumb sits along a track of `track` pixels, or null when nothing overflows. */
export function overlayThumb(viewport: number, content: number, fraction: number, track: number) {
  if (content - viewport < 1 || track <= 0) return null;
  const length = Math.min(track, Math.max(MIN_LENGTH, (track * viewport) / content));
  return { start: (track - length) * Math.min(1, Math.max(0, fraction)), length };
}

type Axis = "y" | "x";

interface Scroller {
  element: Element;
  thumbs: Partial<Record<Axis, HTMLDivElement>>;
  reversed: Partial<Record<Axis, boolean>>;
  hideTimer: number | undefined;
  held: boolean;
}

function scrollingElementOf(target: EventTarget | null): Element | null {
  if (target === document) return document.scrollingElement;
  return target instanceof Element ? target : null;
}

function scrollAxes(element: Element, style: CSSStyleDeclaration): Axis[] {
  if (style.getPropertyValue("scrollbar-width") === "none") return [];
  const root = element === document.scrollingElement;
  const scrolls = (overflow: string) => overflow === "auto" || overflow === "scroll" || (root && overflow === "visible");
  const axes: Axis[] = [];
  if (scrolls(style.overflowY)) axes.push("y");
  if (scrolls(style.overflowX)) axes.push("x");
  return axes;
}

/** The scroller's padding box in viewport coordinates. */
function viewportBox(element: Element) {
  if (element === document.scrollingElement) {
    return { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
  }
  const rect = element.getBoundingClientRect();
  return { left: rect.left + element.clientLeft, top: rect.top + element.clientTop,
    width: element.clientWidth, height: element.clientHeight };
}

/** How far along the scroller is, 0 at the start; reversed flex columns count their negative offsets from the end. */
function scrollFraction(element: Element, axis: Axis, reversed: boolean | undefined) {
  const offset = axis === "y" ? element.scrollTop : element.scrollLeft;
  const max = axis === "y" ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
  if (max <= 0) return 0;
  return reversed ? 1 + offset / max : offset / max;
}

function overflows(element: Element, axis: Axis) {
  return axis === "y" ? element.scrollHeight - element.clientHeight >= 1 : element.scrollWidth - element.clientWidth >= 1;
}

/** The thumb's track, leaving the corner to the other thumb only when that axis overflows too. */
function trackLength(scroller: Scroller, axis: Axis, box: ReturnType<typeof viewportBox>) {
  const other: Axis = axis === "y" ? "x" : "y";
  const corner = scroller.thumbs[other] && overflows(scroller.element, other) ? THICKNESS : 0;
  return (axis === "y" ? box.height : box.width) - 2 * INSET - corner;
}

export function OverlayScrollbars() {
  const layerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const active = new Map<Element, Scroller>();
    let frame = 0;

    const release = (scroller: Scroller) => {
      window.clearTimeout(scroller.hideTimer);
      for (const thumb of Object.values(scroller.thumbs)) thumb?.remove();
      active.delete(scroller.element);
    };

    const scheduleHide = (scroller: Scroller) => {
      window.clearTimeout(scroller.hideTimer);
      if (scroller.held) return;
      scroller.hideTimer = window.setTimeout(() => {
        for (const thumb of Object.values(scroller.thumbs)) thumb?.removeAttribute("data-visible");
        scroller.hideTimer = window.setTimeout(() => release(scroller), 200);
      }, HIDE_AFTER_MS);
    };

    const place = (scroller: Scroller) => {
      const { element } = scroller;
      if (!element.isConnected) return release(scroller);
      const box = viewportBox(element);
      for (const [axis, thumb] of Object.entries(scroller.thumbs) as [Axis, HTMLDivElement][]) {
        const vertical = axis === "y";
        const track = trackLength(scroller, axis, box);
        const geometry = overlayThumb(vertical ? element.clientHeight : element.clientWidth,
          vertical ? element.scrollHeight : element.scrollWidth,
          scrollFraction(element, axis, scroller.reversed[axis]), track);
        if (!geometry) {
          thumb.removeAttribute("data-visible");
          continue;
        }
        thumb.style.left = `${vertical ? box.left + box.width - THICKNESS : box.left + INSET + geometry.start}px`;
        thumb.style.top = `${vertical ? box.top + INSET + geometry.start : box.top + box.height - THICKNESS}px`;
        thumb.style.width = `${vertical ? THICKNESS : geometry.length}px`;
        thumb.style.height = `${vertical ? geometry.length : THICKNESS}px`;
        thumb.setAttribute("data-visible", "");
      }
    };

    const placeAll = () => {
      frame = 0;
      for (const scroller of active.values()) place(scroller);
    };
    const schedulePlace = () => {
      if (!frame) frame = window.requestAnimationFrame(placeAll);
    };

    const drag = (scroller: Scroller, axis: Axis, thumb: HTMLDivElement, event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      thumb.setPointerCapture(event.pointerId);
      const { element } = scroller;
      const vertical = axis === "y";
      const start = vertical ? event.clientY : event.clientX;
      const from = vertical ? element.scrollTop : element.scrollLeft;
      const length = vertical ? thumb.offsetHeight : thumb.offsetWidth;
      const track = trackLength(scroller, axis, viewportBox(element));
      const max = vertical ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
      const ratio = track > length ? max / (track - length) : 0;
      thumb.setAttribute("data-dragging", "");
      const move = (next: PointerEvent) => {
        const to = from + ((vertical ? next.clientY : next.clientX) - start) * ratio;
        if (vertical) element.scrollTop = to;
        else element.scrollLeft = to;
      };
      const end = () => {
        thumb.removeAttribute("data-dragging");
        thumb.removeEventListener("pointermove", move);
        thumb.removeEventListener("pointerup", end);
        thumb.removeEventListener("pointercancel", end);
        if (!thumb.matches(":hover")) {
          scroller.held = false;
          scheduleHide(scroller);
        }
      };
      thumb.addEventListener("pointermove", move);
      thumb.addEventListener("pointerup", end);
      thumb.addEventListener("pointercancel", end);
    };

    const track = (element: Element): Scroller | null => {
      const existing = active.get(element);
      if (existing) return existing;
      const style = getComputedStyle(element);
      const axes = scrollAxes(element, style);
      if (axes.length === 0) return null;
      const reversed = style.flexDirection;
      const scroller: Scroller = { element, thumbs: {}, hideTimer: undefined, held: false,
        reversed: { y: reversed === "column-reverse", x: reversed === "row-reverse" } };
      for (const axis of axes) {
        const thumb = document.createElement("div");
        thumb.className = "overlay-scrollbar-thumb";
        thumb.dataset.axis = axis;
        thumb.addEventListener("pointerenter", () => {
          scroller.held = true;
          window.clearTimeout(scroller.hideTimer);
        });
        thumb.addEventListener("pointerleave", () => {
          if (thumb.hasAttribute("data-dragging")) return;
          scroller.held = false;
          scheduleHide(scroller);
        });
        thumb.addEventListener("pointerdown", (event) => drag(scroller, axis, thumb, event));
        layer.appendChild(thumb);
        scroller.thumbs[axis] = thumb;
      }
      active.set(element, scroller);
      return scroller;
    };

    const onScroll = (event: Event) => {
      if (!document.documentElement.hasAttribute(OVERLAY_SCROLLBARS_ATTRIBUTE)) return;
      const element = scrollingElementOf(event.target);
      const scroller = element && track(element);
      if (scroller) scheduleHide(scroller);
      if (active.size > 0) schedulePlace();
    };
    const onResize = () => {
      if (active.size > 0) schedulePlace();
    };

    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      document.removeEventListener("scroll", onScroll, { capture: true });
      window.removeEventListener("resize", onResize);
      window.cancelAnimationFrame(frame);
      for (const scroller of active.values()) release(scroller);
    };
  }, []);

  return <div ref={layerRef} className="overlay-scrollbars" aria-hidden="true" />;
}
