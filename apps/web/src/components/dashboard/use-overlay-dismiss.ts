"use client";

import { useEffect, type RefObject } from "react";

/** Escape closes only an enabled overlay; busy dialogs retain their guard. */
export function useEscapeDismiss(enabled: boolean, onDismiss: () => void) {
  useEffect(() => {
    if (!enabled) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [enabled, onDismiss]);
}

/** Pointer predicates remain with each overlay's owning DOM boundary. */
export function listenForOverlayDismissal(pointerdown: (event: PointerEvent) => void, onDismiss: () => void) {
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") onDismiss();
  };
  document.addEventListener("pointerdown", pointerdown);
  document.addEventListener("keydown", keydown);
  return () => {
    document.removeEventListener("pointerdown", pointerdown);
    document.removeEventListener("keydown", keydown);
  };
}

/** A menu floating beside its anchor: the page scrolling away takes it along,
 * and a press outside both, or Escape, closes it. Scrolling inside it does not. */
export function useAnchoredMenuDismiss(anchor: HTMLElement, popup: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const scrolled = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      onClose();
    };
    window.addEventListener("scroll", scrolled, { capture: true, passive: true });
    const stop = listenForOverlayDismissal((event) => {
      const target = event.target instanceof Node ? event.target : null;
      if (target && (anchor.contains(target) || popup.current?.contains(target))) return;
      onClose();
    }, onClose);
    return () => { window.removeEventListener("scroll", scrolled, { capture: true }); stop(); };
  }, [anchor, popup, onClose]);
}
