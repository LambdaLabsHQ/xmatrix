// Ask about what you are reading, right on the page. Beside a selection this
// script frames the extension's question box (app/ask.html, built from apps/web
// extension-app/ask.tsx): the App's own selection toolbar with one item, Ask,
// which opens into the App's margin comment box. Enter starts a conversation
// with the passage and the question in the Space the side panel shows, where
// an Agent picks it up, and the side panel opens on it.
//
// This script draws nothing of its own: it places, sizes and hides the frame,
// and when the person clicks Ask, hands the extension the selected text
// (background.js keeps it for this tab). The frame reads its passage and session from the extension, never
// from this page.
//
// It runs beside every selection only after the person turned that on (it is
// registered with the web-page access they granted, background.js
// syncSelectionScript). The context menu's "Ask about…" injects it into the
// one tab it was used on (activeTab) and opens the box at once.
(() => {
  if (window.top !== window || globalThis.__xmatrixAsk) return;
  globalThis.__xmatrixAsk = true;

  const ASK_PAGE = chrome.runtime.getURL("app/ask.html");
  const ORIGIN = new URL(ASK_PAGE).origin;
  let frame = null;
  let mode = "hidden";
  let anchor = null;
  let picked = "";

  function makeFrame(box) {
    frame?.remove();
    frame = document.createElement("iframe");
    frame.src = box ? `${ASK_PAGE}?box=1` : ASK_PAGE;
    frame.title = "Ask xMatrix";
    frame.allow = "clipboard-write";
    // Transparent only when the frame's color scheme is the page's it frames: the App's page is light.
    frame.style.cssText = "all: initial; position: fixed; z-index: 2147483647; border: 0; background: transparent; "
      // It lays out at a box's size, hidden, until it says how big its surface is.
      + "color-scheme: light; width: 448px; height: 240px; top: 0; left: 0; visibility: hidden;";
    document.documentElement.append(frame);
  }

  function hide() {
    mode = "hidden";
    frame?.remove();
    frame = null;
  }

  /** Below the selection, or above it when there is no room; inside the window. */
  function place(width, height) {
    if (!frame || !anchor) return;
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

  /** Typing in a field selects text too; the toolbar stays out of the way there. */
  function inEditable() {
    const active = document.activeElement;
    return Boolean(active && active !== frame && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(active.tagName)));
  }

  function showToolbar() {
    if (mode === "box") return;
    const text = String(globalThis.getSelection() ?? "").trim();
    const rect = selectionRect();
    if (text.length < 2 || !rect || inEditable()) return hide();
    anchor = rect;
    picked = text;
    mode = "toolbar";
    if (!frame) makeFrame(false);
    else frame.contentWindow?.postMessage({ xmatrixAsk: "toolbar" }, ORIGIN);
  }

  window.addEventListener("message", (event) => {
    // Only the frame this script made, from the extension.
    if (!frame || event.source !== frame.contentWindow || event.origin !== ORIGIN || !event.data?.xmatrixAsk) return;
    if (event.data.type === "size") {
      const { width, height } = event.data;
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
        if (event.data.box) mode = "box";
        place(Math.min(width, innerWidth - 16), Math.min(height, innerHeight - 16));
      }
    } else if (event.data.type === "open") {
      // Asked about: only now does the selected text leave this page, to the extension.
      chrome.runtime.sendMessage({ type: "askPrepare", text: picked })
        .then(() => frame?.contentWindow?.postMessage({ xmatrixAsk: "prepared" }, ORIGIN))
        .catch(() => undefined);
    } else if (event.data.type === "close") {
      hide();
    }
  });

  document.addEventListener("mouseup", (event) => {
    if (event.target === frame) return;
    setTimeout(showToolbar, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") hide();
    else if (event.shiftKey) setTimeout(showToolbar, 0);
  });
  document.addEventListener("scroll", () => {
    if (mode === "toolbar") hide();
  }, { capture: true, passive: true });

  // The context menu's "Ask about…": the box opens at once, on the selection or the page.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "open-ask") return;
    anchor = (!message.page && selectionRect()) || { top: 16, bottom: 16, left: innerWidth };
    mode = "box";
    makeFrame(true);
  });
})();
