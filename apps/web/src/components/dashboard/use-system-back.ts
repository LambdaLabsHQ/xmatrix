"use client";

import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";

import { getDesktopBridge } from "@/lib/desktop/bridge";
import { BROWSER_BACK_ENTRY_STATE_KEY } from "./browser-back-entry-script";

type SystemBackEntry = {
  run: () => boolean;
  /** The screen's own step to its parent, taken only when no layer over it takes Back. */
  screen: boolean;
};

declare global {
  interface Window {
    /** The iOS app's left-edge swipe and a phone browser's Back; true when the page went Back. */
    __xmatrixNativeBack?: () => boolean;
    /** The page keeps a marked entry for a phone browser's Back. */
    __xmatrixBackEntryActive?: boolean;
  }
}

/*
 * Every Back a phone has (the bar's chevron aside) ends here: Android's Back,
 * the iOS app's edge swipe and a phone browser's Back button. Each consumer
 * goes Back to its parent screen or closes its layer; none of them walks the
 * browser history, which on a phone never grows (pushBrowserPath).
 */
const systemBackEntries: SystemBackEntry[] = [];
let unsubscribeSystemBack: (() => void) | null = null;
let nativeBackAnimation = false;

/** UIKit already moves the outgoing snapshot during an iOS edge swipe. */
export function nativeBackOwnsAnimation(): boolean {
  return nativeBackAnimation;
}

function dispatchIOSBack(): boolean {
  nativeBackAnimation = true;
  try {
    let handled = false;
    // The native cover starts settling as soon as this call answers. Commit
    // the parent (or dismiss the top layer) underneath it before then.
    flushSync(() => { handled = dispatchSystemBack(); });
    return handled;
  } finally {
    nativeBackAnimation = false;
  }
}

function dispatchSystemBack(): boolean {
  // A layer mounted with the shell registers before it (children's effects run
  // first), so the screen's step waits for every layer whatever the order.
  for (const screen of [false, true]) {
    for (let index = systemBackEntries.length - 1; index >= 0; index -= 1) {
      const entry = systemBackEntries[index];
      if (entry?.screen === screen && entry.run() === true) return true;
    }
  }
  return false;
}

function ensureSystemBackDispatcher(): void {
  if (unsubscribeSystemBack) return;
  const bridge = getDesktopBridge();
  const unsubscribeAndroid = bridge?.client === "android" && bridge.onBackRequested
    ? bridge.onBackRequested(dispatchSystemBack)
    : null;
  const nativeBack = bridge?.client === "ios" ? dispatchIOSBack : dispatchSystemBack;
  window.__xmatrixNativeBack = nativeBack;
  unsubscribeSystemBack = () => {
    unsubscribeAndroid?.();
    if (window.__xmatrixNativeBack === nativeBack) delete window.__xmatrixNativeBack;
  };
}

function removeSystemBackEntry(entry: SystemBackEntry): void {
  const index = systemBackEntries.indexOf(entry);
  if (index >= 0) systemBackEntries.splice(index, 1);
  if (systemBackEntries.length > 0) return;
  unsubscribeSystemBack?.();
  unsubscribeSystemBack = null;
}

/**
 * Registers one synchronous system-Back consumer. Local consumers are kept in
 * one Web-owned stack: React may re-run a parent navigation effect while a
 * dialog stays open, so native listener registration order alone is not a
 * stable representation of visual layer order.
 */
export function useSystemBackHandler(active: boolean, handler: () => boolean, options: { screen?: boolean } = {}): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const screen = options.screen === true;

  useEffect(() => {
    if (!active) return;
    const entry: SystemBackEntry = { run: () => handlerRef.current(), screen };
    systemBackEntries.push(entry);
    ensureSystemBackDispatcher();
    return () => removeSystemBackEntry(entry);
  }, [active, screen]);
}

/** Dismisses a modal surface first, while keeping Back consumed when it is busy. */
export function useSystemBackDismiss(
  active: boolean,
  onDismiss: () => void,
  blocked = false
): void {
  useSystemBackHandler(active, () => {
    if (!blocked) onDismiss();
    return true;
  });
}

function onBrowserBackEntry(): boolean {
  const state: unknown = window.history.state;
  return Boolean(state && typeof state === "object" &&
    (state as Record<string, unknown>)[BROWSER_BACK_ENTRY_STATE_KEY]);
}

/**
 * A phone browser's Back button and edge swipe walk the history, which the app
 * no longer stacks. One marked entry sits above the page, and Back off it is
 * handed to the system-Back consumers (browser-back-entry-script.ts).
 */
export function useBrowserBackEntry(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    window.__xmatrixBackEntryActive = true;
    if (!onBrowserBackEntry()) {
      const { pathname, search, hash } = window.location;
      window.history.pushState({ ...window.history.state, [BROWSER_BACK_ENTRY_STATE_KEY]: true }, "",
        `${pathname}${search}${hash}`);
    }
    return () => { window.__xmatrixBackEntryActive = false; };
  }, [active]);
}
