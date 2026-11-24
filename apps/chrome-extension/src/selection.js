// Ask about what you are reading, right on the page. As soon as the person
// selects text, this script frames the extension's surface under it
// (app/ask.html, built from apps/web extension-app/ask.tsx):
// - When no side panel is open: the floating question capsule. Pressing Enter
//   expands it in place into a live inline conversation card (page scrolling
//   no longer dismisses it). Minimizing or clicking away docks a quiet tab on
//   the right viewport edge so the person can always open the side panel back
//   onto that conversation.
// - When the side panel is already open for this tab: the right-edge dock
//   hides, and selecting text offers a compact "Quote to side panel" pill so
//   there are never two competing input boxes.
//
// This script draws nothing of its own: it hands the extension the selected
// text (background.js keeps it for this tab, in this browser), then places,
// sizes and hides the frame. The frame reads its passage and session from the
// extension, never from this page.
//
// It runs on every page only after the person turned that on (it is
// registered with the web-page access they granted, background.js
// syncSelectionScript). The context menu's "Ask about…" injects it into the
// one tab it was used on (activeTab) and opens the box at once.
(() => {
  if (window.top !== window) return;
  // A page open while the extension updated still runs the old script, cut off from the extension (it can no
  // longer hand over a passage). The extension injects this one into such pages: the old one steps aside.
  globalThis.__xmatrixAsk?.stop?.();
  // After a reload Chrome may give the new script a fresh world, where the old one is not seen: its frame still is.
  for (const old of document.querySelectorAll('iframe[title="Ask xMatrix"]')) {
    if (old.src.startsWith(chrome.runtime.getURL(""))) old.remove();
  }
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const ASK_PAGE = chrome.runtime.getURL("app/ask.html");
  const ORIGIN = new URL(ASK_PAGE).origin;
  let frame = null;
  let frameReady = false;
  /** Message queued until the extension frame reports ready. */
  let pendingMessage = null;
  /** Current surface mode: hidden | ask | thread | dock | quote. */
  let mode = "hidden";
  let panelOpen = false;
  let hasThread = false;
  let anchor = null;
  let shown = "";
  let layout = { placement: "below", maxPanelHeight: 320 };
  let lastSize = null;

  /**
   * The box is made, hidden, as soon as the person starts selecting, so its
   * page and the App's scripts load while they drag; by the time they let go
   * it only has to show the passage. It stays, hidden, for the next selection.
   */
  function ensureFrame() {
    if (frame) return;
    frameReady = false;
    frame = document.createElement("iframe");
    frame.src = ASK_PAGE;
    frame.title = "Ask xMatrix";
    frame.allow = "clipboard-write";
    // Transparent only when the frame's color scheme is the page's it frames: the App's page is light.
    frame.style.cssText = "all: initial; position: fixed; z-index: 2147483647; border: 0; background: transparent; "
      // It lays out at a box's size, hidden, until it says how big the surface is.
      + "color-scheme: light; width: 480px; height: 240px; top: 0; left: 0; right: auto; visibility: hidden;";
    document.documentElement.append(frame);
  }

  /** Visual gap between the selection and the capsule, and between the capsule and the viewport edges. */
  const GAP = 8;
  const EDGE_MARGIN = 8;
  const DEFAULT_TOP_INSET = 12;
  const DEFAULT_BOTTOM_INSET = 24;
  const DEFAULT_SIDE_INSET = 12;
  // Room below the selection where the composer plus an open completion list fit comfortably without flipping up.
  const PREFERRED_ROOM = 320;
  // Vertical budget inside the capsule for the input row and chrome before the completion list scrolls.
  const COMPOSER_CHROME_HEIGHT = 84;
  const MIN_PANEL_HEIGHT = 120;
  const MIN_SIDE_ROOM = 80;

  /**
   * Picks which side of the selection the box opens on and how tall its
   * completion list may grow there without covering the selection or leaving
   * the viewport:
   * - below (dropdown downward) whenever below has comfortable room or at least as much room as above;
   * - above (popup upward) when below is tight and above has more room;
   * - pinned near the bottom opening upward if a huge selection leaves neither side with room.
   */
  function chooseLayout(rect, viewportHeight) {
    const spaceBelow = Math.max(0, viewportHeight - EDGE_MARGIN - (rect.bottom + GAP));
    const spaceAbove = Math.max(0, rect.top - GAP - EDGE_MARGIN);
    if (Math.max(spaceBelow, spaceAbove) < MIN_SIDE_ROOM) {
      const available = Math.max(MIN_SIDE_ROOM, viewportHeight - EDGE_MARGIN * 2);
      return {
        placement: "above",
        maxPanelHeight: Math.max(MIN_PANEL_HEIGHT, Math.floor(available - COMPOSER_CHROME_HEIGHT)),
      };
    }
    const placement = spaceBelow < PREFERRED_ROOM && spaceAbove > spaceBelow ? "above" : "below";
    const available = placement === "above" ? spaceAbove : spaceBelow;
    return {
      placement,
      maxPanelHeight: Math.max(MIN_PANEL_HEIGHT, Math.floor(available - COMPOSER_CHROME_HEIGHT)),
    };
  }

  /** Delivers the latest surface transition once the extension frame is ready. */
  function deliver() {
    if (!frame || !frameReady || !pendingMessage) return;
    const message = pendingMessage;
    pendingMessage = null;
    frame.contentWindow?.postMessage(message, ORIGIN);
  }

  /** Wakes the extension's service worker (and renews its sign-in if due) while the person is still selecting. */
  let warmed = 0;
  function warm() {
    if (Date.now() - warmed < 20_000) return;
    warmed = Date.now();
    chrome.runtime.sendMessage({ type: "askWarm" }).catch(() => undefined);
  }

  /** Fully hidden, not removed: the next selection opens it again at once. */
  function hide() {
    if (frame) frame.style.visibility = "hidden";
    if (frame && document.activeElement === frame) frame.blur();
    mode = "hidden";
    shown = "";
    lastSize = null;
    pendingMessage = null;
  }

  /** Docks a compact tab flush to the right viewport edge when this page already has a thread and the panel is closed. */
  function showDock() {
    if (panelOpen || !hasThread) return hide();
    if (frame && document.activeElement === frame) frame.blur();
    mode = "dock";
    shown = "";
    lastSize = null;
    ensureFrame();
    pendingMessage = { xmatrixAsk: "dock" };
    deliver();
  }

  /** Closes the active popup: returns to the right-edge dock if this page already has a thread, else hides cleanly. */
  function dismiss() {
    if (hasThread && !panelOpen) showDock();
    else hide();
  }

  /**
   * Positions the visible surface inside the viewport:
   * - `dock`: flush to the right edge at ~42% viewport height so the user knows the right side panel can be opened.
   * - `ask` / `quote` / `thread`: anchored beside the selection and clamped cleanly inside viewport bounds.
   */
  function place(width, height, insets) {
    if (!frame || mode === "hidden") return;
    if (mode === "dock") {
      const frameWidth = Math.min(width, innerWidth);
      const frameHeight = Math.min(height, innerHeight);
      const top = Math.max(EDGE_MARGIN, Math.min(innerHeight - EDGE_MARGIN - frameHeight, Math.round(innerHeight * 0.42 - frameHeight / 2)));
      frame.style.left = "auto";
      frame.style.right = "0px";
      frame.style.top = `${top}px`;
      frame.style.width = `${frameWidth}px`;
      frame.style.height = `${frameHeight}px`;
      frame.style.visibility = "visible";
      return;
    }
    if (!anchor || ((mode === "ask" || mode === "quote") && !shown)) return;
    const topInset = Number.isFinite(insets?.topInset) ? insets.topInset : DEFAULT_TOP_INSET;
    const bottomInset = Number.isFinite(insets?.bottomInset) ? insets.bottomInset : DEFAULT_BOTTOM_INSET;
    const leftInset = Number.isFinite(insets?.leftInset) ? insets.leftInset : DEFAULT_SIDE_INSET;
    const rightInset = Number.isFinite(insets?.rightInset) ? insets.rightInset : DEFAULT_SIDE_INSET;
    const frameWidth = Math.min(width, innerWidth + leftInset + rightInset);
    const frameHeight = Math.min(height, innerHeight + topInset + bottomInset);
    const rawTop = layout.placement === "above"
      ? anchor.top - GAP - frameHeight + bottomInset
      : anchor.bottom + GAP - topInset;
    const minTop = EDGE_MARGIN - topInset;
    const maxTop = innerHeight - EDGE_MARGIN - (frameHeight - bottomInset);
    const top = Math.max(minTop, Math.min(rawTop, maxTop));
    const minLeft = EDGE_MARGIN - leftInset;
    const maxLeft = innerWidth - EDGE_MARGIN - (frameWidth - rightInset);
    const left = Math.max(minLeft, Math.min(anchor.left - leftInset, maxLeft));
    frame.style.right = "auto";
    frame.style.top = `${top}px`;
    frame.style.left = `${left}px`;
    frame.style.width = `${frameWidth}px`;
    frame.style.height = `${frameHeight}px`;
    frame.style.visibility = "visible";
  }

  function selectionRect() {
    const selection = globalThis.getSelection();
    if (!selection?.rangeCount) return null;
    const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  }

  /** Typing in a field selects text too; the box stays out of the way there. */
  function inEditable() {
    const active = document.activeElement;
    return Boolean(active && active !== frame && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(active.tagName)));
  }

  /** Opens the box (or quote pill if the side panel is open) on `text`, under `rect`. */
  async function open(text, rect) {
    anchor = rect;
    shown = text;
    mode = panelOpen ? "quote" : "ask";
    ensureFrame();
    await chrome.runtime.sendMessage({ type: "askPrepare", text, title: document.title, url: location.href });
    if (shown !== text || (mode !== "ask" && mode !== "quote")) return;
    layout = chooseLayout(anchor, innerHeight);
    pendingMessage = {
      xmatrixAsk: "prepared",
      mode,
      placement: layout.placement,
      maxPanelHeight: layout.maxPanelHeight,
    };
    deliver();
  }

  function onSelection() {
    if (document.activeElement === frame) return;
    // Keep an active inline conversation open while the user reads or highlights text on the page.
    if (mode === "thread") return;
    const text = String(globalThis.getSelection() ?? "").trim();
    const rect = selectionRect();
    if (text.length < 2 || !rect || inEditable()) {
      if (mode === "ask" || mode === "quote") dismiss();
      return;
    }
    if (text === shown && (mode === "ask" || mode === "quote")) return;
    open(text, rect).catch(() => dismiss());
  }

  listen(window, "message", (event) => {
    // Only the frame this script made, from the extension.
    if (!frame || event.source !== frame.contentWindow || event.origin !== ORIGIN || !event.data?.xmatrixAsk) return;
    if (event.data.type === "ready") {
      frameReady = true;
      deliver();
    } else if (event.data.type === "size") {
      const { width, height, topInset, bottomInset, leftInset, rightInset } = event.data;
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        lastSize = { width, height, topInset, bottomInset, leftInset, rightInset };
        place(width, height, lastSize);
      }
    } else if (event.data.type === "mode") {
      if (event.data.mode === "thread") {
        mode = "thread";
        hasThread = true;
        if (!anchor) anchor = { top: 64, bottom: 64, left: Math.max(EDGE_MARGIN, innerWidth - 520) };
        if (lastSize) place(lastSize.width, lastSize.height, lastSize);
      } else if (event.data.mode === "dock") {
        hasThread = true;
        showDock();
      }
    } else if (event.data.type === "docked") {
      // Side panel opened via ◫ or edge dock: hide the in-page surface cleanly.
      hasThread = true;
      hide();
    } else if (event.data.type === "close") {
      dismiss();
    }
  });

  // Keep the open surface adapted if the browser window is resized around it.
  listen(window, "resize", () => {
    if (!frame || mode === "hidden") return;
    if (mode === "dock") {
      if (lastSize) place(lastSize.width, lastSize.height, lastSize);
      return;
    }
    if (!anchor) return;
    if (mode === "ask" || mode === "quote") {
      const next = chooseLayout(anchor, innerHeight);
      if (next.placement !== layout.placement || next.maxPanelHeight !== layout.maxPanelHeight) {
        layout = next;
        frame.contentWindow?.postMessage({
          xmatrixAsk: "layout",
          placement: layout.placement,
          maxPanelHeight: layout.maxPanelHeight,
        }, ORIGIN);
      }
    }
    if (lastSize) place(lastSize.width, lastSize.height, lastSize);
  });

  // A click on the page, away from the popup, closes it (or docks it if a thread is active);
  // never dismiss the quiet right-edge dock tab on page clicks.
  listen(document, "mousedown", (event) => {
    if ((mode === "ask" || mode === "quote" || mode === "thread") && event.target !== frame) dismiss();
  }, true);
  // The person is selecting text (not just clicking): get the box ready while they drag.
  listen(document, "selectionchange", () => {
    if (frame && frameReady) return;
    if (globalThis.getSelection()?.isCollapsed !== false || inEditable()) return;
    ensureFrame();
    warm();
  });
  listen(document, "mouseup", (event) => {
    if (event.target === frame) return;
    setTimeout(onSelection, 0);
  });
  listen(document, "keyup", (event) => {
    if (event.key === "Escape") {
      if (mode === "ask" || mode === "quote" || mode === "thread") dismiss();
    } else if (event.shiftKey) {
      setTimeout(onSelection, 0);
    }
  });
  // Scrolling moves the passage away from a selection capsule no one is writing in,
  // but NEVER closes an active inline conversation or the right-edge dock tab.
  listen(document, "scroll", () => {
    if ((mode === "ask" || mode === "quote") && document.activeElement !== frame) dismiss();
  }, { capture: true, passive: true });

  // Context menu "Ask about…" and side-panel open/close notifications from background.js.
  const onExtensionMessage = (message) => {
    if (message?.type === "open-ask") {
      anchor = (!message.page && selectionRect()) || { top: 16, bottom: 16, left: innerWidth };
      shown = String(message.text ?? "");
      mode = panelOpen ? "quote" : "ask";
      ensureFrame();
      layout = chooseLayout(anchor, innerHeight);
      pendingMessage = {
        xmatrixAsk: "prepared",
        mode,
        placement: layout.placement,
        maxPanelHeight: layout.maxPanelHeight,
      };
      deliver();
    } else if (message?.type === "panel-state") {
      panelOpen = Boolean(message.open);
      if (typeof message.hasThread === "boolean") hasThread = message.hasThread;
      if (panelOpen) {
        if (mode !== "quote") hide();
      } else if (hasThread && mode === "hidden") {
        showDock();
      }
    }
  };
  chrome.runtime.onMessage.addListener(onExtensionMessage);

  // Sync initial tab state: if this page already has an active thread and the side panel is closed,
  // show the right-edge dock tab right away so the user can pick up the conversation.
  Promise.resolve(chrome.runtime.sendMessage({ type: "askPageState", url: location.href }))
    .then((res) => {
      if (!res?.ok || !res.value) return;
      panelOpen = Boolean(res.value.panelOpen);
      hasThread = Boolean(res.value.hasThread);
      if (!panelOpen && hasThread && mode === "hidden") showDock();
    })
    .catch(() => undefined);

  globalThis.__xmatrixAsk = {
    stop() {
      for (const remove of listeners) remove();
      try {
        chrome.runtime.onMessage.removeListener(onExtensionMessage);
      } catch {
        // Cut off from the extension: nothing more reaches it anyway.
      }
      frame?.remove();
      frame = null;
      frameReady = false;
      mode = "hidden";
      shown = "";
      pendingMessage = null;
    },
  };
})();
