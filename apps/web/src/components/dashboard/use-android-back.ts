"use client";

import { useEffect, useRef } from "react";

import { getDesktopBridge } from "@/lib/desktop/bridge";

type AndroidBackEntry = {
  run: () => boolean;
};

const androidBackEntries: AndroidBackEntry[] = [];
let unsubscribeAndroidBack: (() => void) | null = null;

function ensureAndroidBackDispatcher(): void {
  if (unsubscribeAndroidBack) return;
  const bridge = getDesktopBridge();
  if (bridge?.client !== "android" || !bridge.onBackRequested) return;
  unsubscribeAndroidBack = bridge.onBackRequested(() => {
    for (let index = androidBackEntries.length - 1; index >= 0; index -= 1) {
      if (androidBackEntries[index]?.run() === true) return true;
    }
    return false;
  });
}

function removeAndroidBackEntry(entry: AndroidBackEntry): void {
  const index = androidBackEntries.indexOf(entry);
  if (index >= 0) androidBackEntries.splice(index, 1);
  if (androidBackEntries.length > 0) return;
  unsubscribeAndroidBack?.();
  unsubscribeAndroidBack = null;
}

/**
 * Registers one synchronous Android system-Back consumer. Local consumers are
 * kept in one Web-owned stack: React may re-run a parent navigation effect
 * while a dialog stays open, so native listener registration order alone is
 * not a stable representation of visual layer order.
 */
export function useAndroidBackHandler(active: boolean, handler: () => boolean): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!active) return;
    const entry: AndroidBackEntry = { run: () => handlerRef.current() };
    androidBackEntries.push(entry);
    ensureAndroidBackDispatcher();
    return () => removeAndroidBackEntry(entry);
  }, [active]);
}

/** Dismisses a modal surface first, while keeping Back consumed when it is busy. */
export function useAndroidBackDismiss(
  active: boolean,
  onDismiss: () => void,
  blocked = false
): void {
  useAndroidBackHandler(active, () => {
    if (!blocked) onDismiss();
    return true;
  });
}
