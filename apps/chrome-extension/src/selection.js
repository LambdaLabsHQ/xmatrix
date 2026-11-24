// Ask about what you are reading, right on the page. As soon as the person
// selects text, this script frames the extension's question box under it
// (app/ask.html, built from apps/web extension-app/ask.tsx): the App's own
// conversation composer, for the question (the selection is the quote, sent
// with it). It does not take the focus, so the selection can still be
// copied; a click goes into it. Enter
// starts a conversation in the Space the side panel shows, where an Agent
// picks it up, and the side panel opens on it.
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
  let prepared = false;
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
      // It lays out at a box's size, hidden, until it says how big the composer is.
      + "color-scheme: light; width: 480px; height: 240px; top: 0; left: 0; visibility: hidden;";
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

  /** Tells the box its passage and placement are ready to read, once both it and the passage are. */
  function deliver() {
    if (!frame || !frameReady || !prepared || !anchor) return;
    prepared = false;
    layout = chooseLayout(anchor, innerHeight);
    frame.contentWindow?.postMessage({
      xmatrixAsk: "prepared",
      placement: layout.placement,
      maxPanelHeight: layout.maxPanelHeight,
    }, ORIGIN);
  }

  /** Wakes the extension's service worker (and renews its sign-in if due) while the person is still selecting. */
  let warmed = 0;
  function warm() {
    if (Date.now() - warmed < 20_000) return;
    warmed = Date.now();
    chrome.runtime.sendMessage({ type: "askWarm" }).catch(() => undefined);
  }

  /** Hidden, not removed: the next selection opens it again at once. */
  function hide() {
    if (frame) frame.style.visibility = "hidden";
    if (frame && document.activeElement === frame) frame.blur();
    shown = "";
    lastSize = null;
  }

  /**
   * Anchors the visible capsule on the chosen side of the selection:
   * - `below`: top edge stays pinned below the selection as the dropdown grows downward.
   * - `above`: bottom edge stays pinned above the selection as the popup grows upward.
   */
  function place(width, height, insets) {
    if (!frame || !anchor || !shown) return;
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

  /** Opens the box on `text`, under `rect` (or the page's top right for the page itself). */
  async function open(text, rect) {
    anchor = rect;
    shown = text;
    ensureFrame();
    await chrome.runtime.sendMessage({ type: "askPrepare", text, title: document.title, url: location.href });
    if (shown !== text) return;
    prepared = true;
    deliver();
  }

  function onSelection() {
    if (document.activeElement === frame) return;
    const text = String(globalThis.getSelection() ?? "").trim();
    const rect = selectionRect();
    if (text.length < 2 || !rect || inEditable()) return hide();
    if (text === shown) return;
    open(text, rect).catch(() => hide());
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
    } else if (event.data.type === "close") {
      hide();
    }
  });

  // Keep the open box adapted if the browser window is resized around it.
  listen(window, "resize", () => {
    if (!frame || !anchor || !shown) return;
    const next = chooseLayout(anchor, innerHeight);
    if (next.placement !== layout.placement || next.maxPanelHeight !== layout.maxPanelHeight) {
      layout = next;
      frame.contentWindow?.postMessage({
        xmatrixAsk: "layout",
        placement: layout.placement,
        maxPanelHeight: layout.maxPanelHeight,
      }, ORIGIN);
    }
    if (lastSize) place(lastSize.width, lastSize.height, lastSize);
  });

  // A click on the page, away from the box, closes it, as a click away closes the App's popovers;
  // the selection that click may make opens it again.
  listen(document, "mousedown", (event) => {
    if (shown && event.target !== frame) hide();
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
    if (event.key === "Escape") hide();
    else if (event.shiftKey) setTimeout(onSelection, 0);
  });
  // Scrolling moves the passage away from a box no one is writing in.
  listen(document, "scroll", () => {
    if (shown && document.activeElement !== frame) hide();
  }, { capture: true, passive: true });

  // The context menu's "Ask about…": the extension has the passage already; the box opens on it.
  const onOpenAsk = (message) => {
    if (message?.type !== "open-ask") return;
    anchor = (!message.page && selectionRect()) || { top: 16, bottom: 16, left: innerWidth };
    shown = String(message.text ?? "");
    ensureFrame();
    prepared = true;
    deliver();
  };
  chrome.runtime.onMessage.addListener(onOpenAsk);

  globalThis.__xmatrixAsk = {
    stop() {
      for (const remove of listeners) remove();
      try {
        chrome.runtime.onMessage.removeListener(onOpenAsk);
      } catch {
        // Cut off from the extension: nothing more reaches it anyway.
      }
      frame?.remove();
      frame = null;
      frameReady = false;
      shown = "";
    },
  };
})();
