"use client";

import { useEffect } from "react";

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
