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
  let lastFrameHeight = 0;
  let askPanelOpen = false;
  let askCollapsedHeight = 0;
  let pendingResetDraftAfterDrag = false;

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
  const DEFAULT_BOTTOM_INSET = 36;
  const DEFAULT_SIDE_INSET = 24;
  // Unified room threshold for both ask capsule and inline thread card so pressing Enter
  // never flips placement or jumps over the selected text.
  const PREFERRED_ROOM = 400;
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
  function chooseLayout(rect, viewportHeight, preferredRoom = PREFERRED_ROOM) {
    const spaceBelow = Math.max(0, viewportHeight - EDGE_MARGIN - (rect.bottom + GAP));
    const spaceAbove = Math.max(0, rect.top - GAP - EDGE_MARGIN);
    if (Math.max(spaceBelow, spaceAbove) < MIN_SIDE_ROOM) {
      const available = Math.max(MIN_SIDE_ROOM, viewportHeight - EDGE_MARGIN * 2);
      return {
        placement: "above",
        maxPanelHeight: Math.max(MIN_PANEL_HEIGHT, Math.floor(available - COMPOSER_CHROME_HEIGHT)),
      };
    }
    const placement = spaceBelow < preferredRoom && spaceAbove > spaceBelow ? "above" : "below";
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
  function hide({ resetDraft = true } = {}) {
    const wasAsk = mode === "ask";
    if (frame) {
      if (resetDraft && (wasAsk || pendingResetDraftAfterDrag) && frameReady) {
        frame.contentWindow?.postMessage({ xmatrixAsk: "reset-draft" }, ORIGIN);
      }
      frame.style.visibility = "hidden";
      frame.style.clipPath = "none";
    }
    if (frame && document.activeElement === frame) frame.blur();
    mode = "hidden";
    shown = "";
    lastSize = null;
    lastFrameHeight = 0;
    askPanelOpen = false;
    askCollapsedHeight = 0;
    pendingResetDraftAfterDrag = !resetDraft && wasAsk;
    pendingMessage = null;
  }

  /**
   * Computes a fixed vertical runway for `ask` mode so the iframe's `top` and
   * `height` never move while typing or opening/closing `@` completion; `clip-path`
   * reveals only the active capsule/list and keeps the unused runway click-through.
   */
  function askFrameBox(rect, viewportHeight, chosenLayout, topInset = DEFAULT_TOP_INSET, bottomInset = DEFAULT_BOTTOM_INSET) {
    if (chosenLayout.placement === "above") {
      const visibleBottom = Math.max(EDGE_MARGIN + 64, Math.min(rect.top - GAP, viewportHeight - EDGE_MARGIN));
      const availableVisible = Math.max(80, visibleBottom - EDGE_MARGIN);
      const reservedHeight = Math.min(viewportHeight + topInset + bottomInset, Math.ceil(availableVisible + topInset + bottomInset));
      const fixedTop = visibleBottom + bottomInset - reservedHeight;
      return { fixedTop, reservedHeight };
    }
    const visibleTop = Math.max(EDGE_MARGIN, Math.min(rect.bottom + GAP, viewportHeight - EDGE_MARGIN - 64));
    // Leave full shadow clearance above the viewport bottom edge so the card's drop shadow is never clipped.
    const bottomClearance = Math.max(EDGE_MARGIN, bottomInset);
    const availableVisible = Math.max(80, viewportHeight - bottomClearance - visibleTop);
    const reservedHeight = Math.min(viewportHeight + topInset, Math.ceil(availableVisible + topInset + bottomInset));
    const fixedTop = visibleTop - topInset;
    return { fixedTop, reservedHeight };
  }

  /** Pre-sizes the hidden iframe to its fixed `ask`/`thread` runway before showing, so 100vh is already settled. */
  function prepareAskFrameBox() {
    if (!frame || !anchor || (mode !== "ask" && mode !== "thread")) return;
    askPanelOpen = false;
    askCollapsedHeight = 0;
    const { fixedTop, reservedHeight } = askFrameBox(anchor, innerHeight, layout);
    lastFrameHeight = reservedHeight;
    frame.style.right = "auto";
    frame.style.top = `${fixedTop}px`;
    frame.style.height = `${reservedHeight}px`;
    frame.style.clipPath = "none";
  }

  /**
   * Two-tier clip-path for `ask` / `thread`:
   * - Resting (`askPanelOpen === false`): hugs the exact surface height so the webpage below stays interactive.
   * - Completion open (`mode === "ask" && askPanelOpen`): opens ONCE to `collapsedHeight + maxPanelHeight`
   *   so filtering/backspacing/growing candidates never moves the clip edge or flickers a frame.
   */
  function applySurfaceClipPath(frameHeight, surfaceHeight) {
    if (!frame) return;
    const visibleHeight = mode === "ask" && askPanelOpen
      ? Math.min(frameHeight, Math.max(surfaceHeight, (askCollapsedHeight || surfaceHeight) + layout.maxPanelHeight))
      : surfaceHeight;
    const unused = Math.max(0, frameHeight - visibleHeight);
    frame.style.clipPath = unused > 0
      ? (layout.placement === "above"
        ? `inset(${unused}px 0px 0px 0px)`
        : `inset(0px 0px ${unused}px 0px)`)
      : "none";
  }

  /** Docks a compact tab flush to the right viewport edge when this page already has a thread and the panel is closed. */
  function showDock() {
    askPanelOpen = false;
    askCollapsedHeight = 0;
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
   * - `ask`: fixed vertical runway (`top` + `height` constant) with `clip-path` hugging the visible capsule/list
   *   so opening/closing `@` completion never causes a cross-origin iframe resize or frame jump.
   * - `quote` / `thread`: anchored beside the selection and clamped cleanly inside viewport bounds.
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
      frame.style.clipPath = "none";
      frame.style.visibility = "visible";
      return;
    }
    if (!anchor || ((mode === "ask" || mode === "quote") && !shown)) return;
    const topInset = Number.isFinite(insets?.topInset) ? insets.topInset : DEFAULT_TOP_INSET;
    const bottomInset = Number.isFinite(insets?.bottomInset) ? insets.bottomInset : DEFAULT_BOTTOM_INSET;
    const leftInset = Number.isFinite(insets?.leftInset) ? insets.leftInset : DEFAULT_SIDE_INSET;
    const rightInset = Number.isFinite(insets?.rightInset) ? insets.rightInset : DEFAULT_SIDE_INSET;
    const frameWidth = Math.min(width, innerWidth + leftInset + rightInset);
    const minLeft = EDGE_MARGIN - leftInset;
    const maxLeft = innerWidth - EDGE_MARGIN - (frameWidth - rightInset);
    const left = Math.max(minLeft, Math.min(anchor.left - leftInset, maxLeft));

    if (mode === "ask" || mode === "thread") {
      const { fixedTop, reservedHeight } = askFrameBox(anchor, innerHeight, layout, topInset, bottomInset);
      const frameHeight = Math.max(reservedHeight, Math.min(height, innerHeight + topInset + bottomInset));
      const top = layout.placement === "above"
        ? fixedTop - (frameHeight - reservedHeight)
        : fixedTop;
      const bottomLimit = layout.placement === "below"
        ? innerHeight - frameHeight
        : innerHeight - EDGE_MARGIN - (frameHeight - bottomInset);
      const clampedTop = Math.max(EDGE_MARGIN - topInset, Math.min(top, bottomLimit));
      lastFrameHeight = frameHeight;
      if (mode === "ask" && !askPanelOpen) askCollapsedHeight = height;
      frame.style.right = "auto";
      frame.style.top = `${clampedTop}px`;
      frame.style.left = `${left}px`;
      frame.style.width = `${frameWidth}px`;
      frame.style.height = `${frameHeight}px`;
      applySurfaceClipPath(frameHeight, height);
      frame.style.visibility = "visible";
      return;
    }

    const frameHeight = Math.min(height, innerHeight + topInset + bottomInset);
    const rawTop = layout.placement === "above"
      ? anchor.top - GAP - frameHeight + bottomInset
      : anchor.bottom + GAP - topInset;
    const minTop = EDGE_MARGIN - topInset;
    const maxTop = innerHeight - EDGE_MARGIN - (frameHeight - bottomInset);
    const top = Math.max(minTop, Math.min(rawTop, maxTop));
    frame.style.right = "auto";
    frame.style.top = `${top}px`;
    frame.style.left = `${left}px`;
    frame.style.width = `${frameWidth}px`;
    frame.style.height = `${frameHeight}px`;
    frame.style.clipPath = "none";
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

  /**
   * Opens the surface beside `rect` for selected `text`:
   * - Side panel already open -> compact `quote` pill;
   * - This page already has a conversation -> full inline `thread` card (existing chat + quoted composer);
   * - Brand-new page with no conversation yet -> floating `ask` composer capsule.
   */
  async function open(text, rect) {
    pendingResetDraftAfterDrag = false;
    anchor = rect;
    shown = text;
    if (mode === "dock" && frame) {
      frame.style.visibility = "hidden";
      frame.style.clipPath = "none";
    }
    mode = panelOpen ? "quote" : hasThread ? "thread" : "ask";
    ensureFrame();
    const prepared = await chrome.runtime.sendMessage({ type: "askPrepare", text, title: document.title, url: location.href });
    if (shown !== text || (mode !== "ask" && mode !== "quote" && mode !== "thread")) return;
    if (prepared?.ok && prepared.value) {
      if (typeof prepared.value.panelOpen === "boolean") panelOpen = prepared.value.panelOpen;
      if (typeof prepared.value.hasThread === "boolean") hasThread = prepared.value.hasThread;
      mode = panelOpen ? "quote" : hasThread ? "thread" : "ask";
    }
    layout = chooseLayout(anchor, innerHeight, PREFERRED_ROOM);
    prepareAskFrameBox();
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
    const text = String(globalThis.getSelection() ?? "").trim();
    const rect = selectionRect();
    if (mode === "thread") {
      // D1/D2: keep an open inline conversation card alive on plain clicks/empty selections,
      // and smoothly follow any new mouse or keyboard (Shift+Arrow) selection without flashing dock.
      if (text.length >= 2 && rect && !inEditable() && text !== shown) {
        open(text, rect).catch(() => undefined);
      }
      return;
    }
    if (text.length < 2 || !rect || inEditable()) {
      if (pendingResetDraftAfterDrag) {
        pendingResetDraftAfterDrag = false;
        if (frame && frameReady) frame.contentWindow?.postMessage({ xmatrixAsk: "reset-draft" }, ORIGIN);
      }
      if (mode === "ask" || mode === "quote") dismiss();
      return;
    }
    pendingResetDraftAfterDrag = false;
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
    } else if (event.data.type === "panel") {
      if (mode === "ask") {
        askPanelOpen = Boolean(event.data.open);
        if (lastFrameHeight > 0 && lastSize) applySurfaceClipPath(lastFrameHeight, lastSize.height);
      }
    } else if (event.data.type === "mode") {
      if (event.data.mode === "thread") {
        askPanelOpen = false;
        askCollapsedHeight = 0;
        mode = "thread";
        hasThread = true;
        if (!anchor) anchor = { top: 64, bottom: 64, left: Math.max(EDGE_MARGIN, innerWidth - 520) };
      } else if (event.data.mode === "ask") {
        askPanelOpen = false;
        askCollapsedHeight = 0;
        mode = "ask";
        hasThread = false;
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

  // D1: A click on the page hides a bare ask capsule or quote pill, while an active inline
  // conversation card stays open while the user reads/scrolls/copies (closed via ×, Escape, or ◫).
  // Item 6: On mousedown during `ask`, defer `reset-draft` until mouseup so dragging a new
  // selection on the webpage preserves whatever the user already typed in the capsule.
  listen(document, "mousedown", (event) => {
    if (event.target === frame) return;
    if (mode === "ask") hide({ resetDraft: false });
    else if (mode === "quote") dismiss();
  }, true);
  listen(window, "blur", () => {
    if (pendingResetDraftAfterDrag) {
      pendingResetDraftAfterDrag = false;
      if (frame && frameReady) frame.contentWindow?.postMessage({ xmatrixAsk: "reset-draft" }, ORIGIN);
    }
  });
  // The person is selecting text (not just clicking): get the box ready while they drag,
  // and pre-warm the embedded App on drag-start when this tab already has a bound thread (Item 4).
  let prewarmedDrag = false;
  listen(document, "selectionchange", () => {
    const collapsed = globalThis.getSelection()?.isCollapsed !== false;
    if (collapsed || inEditable()) {
      prewarmedDrag = false;
      return;
    }
    if (hasThread && !panelOpen && mode === "dock" && frame && frameReady && !prewarmedDrag) {
      prewarmedDrag = true;
      frame.contentWindow?.postMessage({ xmatrixAsk: "prewarm" }, ORIGIN);
      return;
    }
    if (frame && frameReady) return;
    ensureFrame();
    warm();
  });
  listen(window, "mouseup", (event) => {
    if (event.target === frame) return;
    prewarmedDrag = false;
    setTimeout(onSelection, 0);
  });
  // Keep an open inline thread card synced with client-side history navigation (Item 2).
  const notifyClientPageChange = () => {
    if (mode === "thread" && frame && frameReady) {
      frame.contentWindow?.postMessage({ xmatrixAsk: "page-updated", title: document.title, href: location.href }, ORIGIN);
    }
  };
  listen(window, "popstate", notifyClientPageChange);
  listen(window, "hashchange", notifyClientPageChange);
  // B5: Let the frame release any off-screen warm App when this tab moves to the background.
  listen(document, "visibilitychange", () => {
    if (frame && frameReady) {
      frame.contentWindow?.postMessage({ xmatrixAsk: "visibility", hidden: Boolean(document.hidden) }, ORIGIN);
    }
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
      if (typeof message.hasThread === "boolean") hasThread = message.hasThread;
      if (mode === "dock" && frame) {
        frame.style.visibility = "hidden";
        frame.style.clipPath = "none";
      }
      mode = panelOpen ? "quote" : hasThread ? "thread" : "ask";
      ensureFrame();
      layout = chooseLayout(anchor, innerHeight, PREFERRED_ROOM);
      prepareAskFrameBox();
      pendingMessage = {
        xmatrixAsk: "prepared",
        mode,
        placement: layout.placement,
        maxPanelHeight: layout.maxPanelHeight,
      };
      deliver();
    } else if (message?.type === "page-updated") {
      if (frame && frameReady && typeof message.href === "string" && message.href) {
        frame.contentWindow?.postMessage({
          xmatrixAsk: "page-updated",
          title: typeof message.title === "string" ? message.title : document.title,
          href: message.href,
        }, ORIGIN);
      }
    } else if (message?.type === "panel-state") {
      panelOpen = Boolean(message.open);
      if (typeof message.hasThread === "boolean") hasThread = message.hasThread;
      if (panelOpen) {
        // Hide visually at once, but keep the inline App alive until `panel-release`
        // arrives from background.js once the side panel displays the conversation.
        if (mode !== "quote") hide();
      } else if (hasThread && mode === "hidden") {
        showDock();
      } else if (!hasThread && mode === "dock") {
        hide();
      }
    } else if (message?.type === "panel-release") {
      if (panelOpen && frame && frameReady) {
        frame.contentWindow?.postMessage({ xmatrixAsk: "release" }, ORIGIN);
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
