// Ask about what you are reading, right on the page. As soon as the person
// selects text, this script frames the extension's question box under it
// (app/ask.html, built from apps/web extension-app/ask.tsx): the App's own
// conversation composer, holding the passage quoted. It does not take the
// focus, so the selection can still be copied; a click goes into it. Enter
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
  const listeners = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };

  const ASK_PAGE = chrome.runtime.getURL("app/ask.html");
  const ORIGIN = new URL(ASK_PAGE).origin;
  let frame = null;
  let anchor = null;
  let shown = "";

  function makeFrame() {
    frame?.remove();
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

  /** Hidden, not removed: the next selection opens it again at once. */
  function hide() {
    if (frame) frame.style.visibility = "hidden";
    if (frame && document.activeElement === frame) frame.blur();
    shown = "";
  }

  /** Under the selection, or above it when there is no room; inside the window. */
  function place(width, height) {
    if (!frame || !anchor || !shown) return;
    const below = anchor.bottom + 8;
    const top = below + height > innerHeight - 8 ? Math.max(8, anchor.top - height - 8) : below;
    frame.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
    frame.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
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
    await chrome.runtime.sendMessage({ type: "askPrepare", text, title: document.title, url: location.href });
    if (shown !== text) return;
    if (!frame) makeFrame();
    else frame.contentWindow?.postMessage({ xmatrixAsk: "prepared" }, ORIGIN);
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
    if (event.data.type === "size") {
      const { width, height } = event.data;
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        place(Math.min(width, innerWidth - 16), Math.min(height, innerHeight - 16));
      }
    } else if (event.data.type === "close") {
      hide();
    }
  });

  // A click on the page, away from the box, closes it, as a click away closes the App's popovers;
  // the selection that click may make opens it again.
  listen(document, "mousedown", (event) => {
    if (shown && event.target !== frame) hide();
  }, true);
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
    if (!frame) makeFrame();
    else frame.contentWindow?.postMessage({ xmatrixAsk: "prepared" }, ORIGIN);
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
      shown = "";
    },
  };
})();
