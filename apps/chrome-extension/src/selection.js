// Ask about what you are reading, right on the page. Selecting text shows a
// small field beside it, "Ask about this…"; a click opens it into the question
// box there, holding the passage.
// Enter starts a conversation with the passage and the question, straight
// through the Hub (background.js quickAsk), in the Space the side panel shows,
// where an Agent picks it up; the side panel opens on it.
//
// The button beside a selection runs only after the person turned it on (it
// is registered with the web-page access they granted, background.js
// syncSelectionScript). The context menu's "Ask about…" injects this script
// into the one tab it was used on (activeTab) and opens the box at once. It
// reads nothing until the person acts, and then only the selected text.
(() => {
  if (window.top !== window || globalThis.__xmatrixAsk) return;
  globalThis.__xmatrixAsk = true;

  // The App's own surfaces for the same moment (apps/web page-editor.tsx and page-comment-box.tsx):
  // a slip of wood-tinted paper (PaperPopover: 8px corners, no border) holding a toolbar for a
  // selection, or a white capsule field. Inter comes from the package, as the App ships it.
  const font = chrome.runtime.getURL("assets/fonts/inter-latin.woff2");
  if (!document.fonts.check("13px xMatrixInter")) {
    const face = new FontFace("xMatrixInter", `url(${font})`, { weight: "100 900" });
    face.load().then(() => document.fonts.add(face)).catch(() => undefined);
  }
  const ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"/></svg>`;
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; display: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; margin: 0; font-family: xMatrixInter, Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased; }
      .slip { --ink: oklch(0.24 0.03 60); --muted: oklch(0.49 0.03 62);
        background: color-mix(in oklch, oklch(0.83 0.07 76) 35%, oklch(0.976 0.005 85)); color: var(--ink); border-radius: 8px;
        /* The App's slips sit on its paper with no shadow; on someone else's page a faint lift keeps the edge. */
        box-shadow: 0 1px 2px oklch(0.2 0.03 55 / 0.10), 0 6px 18px -8px oklch(0.2 0.03 55 / 0.22);
        animation: in 120ms ease-out; }
      @keyframes in { from { opacity: 0; transform: translateY(2px); } }
      @media (prefers-reduced-motion: reduce) { .slip { animation: none; } }
      .bar { display: flex; overflow: hidden; }
      .bar button { display: flex; align-items: center; gap: 6px; min-height: 36px; border: 0; padding: 0 12px; background: transparent;
        color: inherit; font-size: 14px; font-weight: 500; cursor: pointer; }
      .bar button:hover, .bar button:focus-visible { outline: 0; background: color-mix(in oklch, var(--ink) 7%, transparent); }
      svg { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .box { display: none; width: 380px; max-width: calc(100vw - 16px); padding: 10px 10px 8px; }
      .quote { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
        margin: 2px 6px 8px; color: var(--muted); font-size: 13px; line-height: 1.45; }
      .quote::before { content: "“"; margin-right: 1px; }
      .quote::after { content: "”"; margin-left: 1px; }
      .field { display: flex; align-items: flex-end; gap: 4px; min-height: 44px; padding: 4px 4px 4px 16px; border-radius: 22px; background: #fff; }
      textarea { flex: 1; display: block; min-height: 36px; max-height: 160px; resize: none; border: 0; padding: 8px 0; background: transparent;
        color: var(--ink); font-size: 15px; line-height: 20px; outline: 0; }
      textarea::placeholder { color: color-mix(in oklch, var(--muted) 85%, transparent); }
      .send { display: grid; place-items: center; flex: none; width: 36px; height: 36px; border: 0; border-radius: 999px;
        background: var(--ink); color: #fff; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
      .send:disabled { background: color-mix(in oklch, var(--ink) 10%, transparent); color: color-mix(in oklch, var(--ink) 40%, transparent); cursor: default; }
      .send svg { width: 18px; height: 18px; stroke-width: 2.25; }
      .foot { display: flex; gap: 6px; margin: 7px 6px 0; min-height: 16px; font-size: 12px; line-height: 16px; color: var(--muted); }
      .where { overflow: hidden; color: var(--ink); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
      .status { flex: 1; text-align: right; white-space: nowrap; }
      .foot.error .status { color: oklch(0.55 0.19 28); text-align: left; white-space: normal; }
      .foot.error .where { display: none; }
    </style>
    <div class="slip bar" role="toolbar" aria-label="xMatrix"><button type="button" class="ask">${ICON}Ask</button></div>
    <form class="slip box" aria-label="Ask about this">
      <p class="quote"></p>
      <div class="field">
        <textarea rows="1" placeholder="Ask your Agent about this"></textarea>
        <button class="send" type="submit" aria-label="Ask" disabled><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
      </div>
      <p class="foot"><span class="where"></span><span class="status"></span></p>
    </form>`;
  document.documentElement.append(host);

  const pill = root.querySelector(".bar");
  const box = root.querySelector(".box");
  const where = root.querySelector(".where");
  const quote = root.querySelector(".quote");
  const field = root.querySelector("textarea");
  const send = root.querySelector(".send");
  const foot = root.querySelector(".foot");
  const status = root.querySelector(".status");
  const HINT = "Enter to ask";
  let text = "";
  let asking = false;
  const boxOpen = () => box.style.display === "block";

  function hide() {
    if (asking) return;
    host.style.display = "none";
    pill.style.display = "flex";
    box.style.display = "none";
    text = "";
  }

  function placeAt(rect, height) {
    host.style.display = "block";
    const below = rect.bottom + 8;
    const top = below + height > innerHeight ? rect.top - height - 8 : below;
    host.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
    host.style.left = `${Math.min(Math.max(8, rect.left), innerWidth - host.offsetWidth - 8)}px`;
  }

  function selectionRect() {
    const selection = globalThis.getSelection();
    if (!selection?.rangeCount) return null;
    const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
    return rect.width || rect.height ? rect : null;
  }

  /** Typing in a field selects text too; the button stays out of the way there. */
  function inEditable() {
    const active = document.activeElement;
    return Boolean(active && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/u.test(active.tagName)));
  }

  function showPill() {
    if (boxOpen()) return;
    const selected = String(globalThis.getSelection() ?? "").trim();
    const rect = selectionRect();
    if (selected.length < 2 || !rect || inEditable()) return hide();
    text = selected;
    pill.style.display = "flex";
    placeAt(rect, 36);
  }

  function setFoot(text, kind = "") {
    status.textContent = text;
    foot.className = `foot ${kind}`;
  }

  /** Opens the box beside `rect` (the selection), or at the top right of the page for the page itself. */
  async function openBox(rect) {
    pill.style.display = "none";
    box.style.display = "block";
    quote.textContent = text || document.title || location.host;
    field.value = "";
    send.disabled = true;
    where.textContent = "";
    setFoot(HINT);
    const anchor = rect ?? { top: 16, bottom: 16, left: innerWidth - 376 };
    placeAt(anchor, box.offsetHeight || 140);
    field.focus();
    const target = await chrome.runtime.sendMessage({ type: "quick-ask-target" }).catch(() => null);
    if (target?.ok && target.value?.signedIn === false) {
      setFoot("Sign in to xMatrix in the side panel first.", "error");
    } else if (target?.ok && target.value?.spaceName) {
      where.textContent = target.value.spaceName;
      where.title = `Goes to ${target.value.spaceName}, the Space open in the side panel`;
    }
  }

  async function submit() {
    const question = field.value.trim();
    if (!question || asking) return;
    asking = true;
    send.disabled = true;
    field.readOnly = true;
    setFoot("Asking…");
    try {
      const answer = await chrome.runtime.sendMessage({ type: "quick-ask", text, question, title: document.title });
      if (!answer?.ok) throw new Error(answer?.error ?? "xMatrix could not be reached.");
      setFoot("Asked · opening in the side panel", "done");
      setTimeout(() => { asking = false; field.readOnly = false; hide(); }, 1400);
    } catch (error) {
      asking = false;
      field.readOnly = false;
      send.disabled = false;
      setFoot(error instanceof Error ? error.message : String(error), "error");
    }
  }

  // Clicks inside keep the page's selection; only the field takes focus.
  root.addEventListener("mousedown", (event) => {
    if (!event.composedPath().includes(field)) event.preventDefault();
  });
  pill.addEventListener("click", () => {
    if (text) openBox(host.getBoundingClientRect());
  });
  box.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  field.addEventListener("input", () => {
    send.disabled = !field.value.trim() || asking;
    field.style.height = "auto";
    field.style.height = `${Math.min(field.scrollHeight + 2, 180)}px`;
  });
  field.addEventListener("keydown", (event) => {
    // The page's own shortcuts must not see what is typed here.
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      asking = false;
      hide();
    }
  });
  for (const type of ["keyup", "keypress"]) field.addEventListener(type, (event) => event.stopPropagation());

  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    // A click outside an untouched box closes it; one with a question keeps it.
    if (boxOpen() && !asking && !field.value.trim()) hide();
    setTimeout(showPill, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape" && !boxOpen()) hide();
    else if (event.shiftKey && !boxOpen()) setTimeout(showPill, 0);
  });
  document.addEventListener("scroll", () => {
    if (!boxOpen()) hide();
  }, { capture: true, passive: true });

  // The context menu's "Ask about…": the box opens at once, on the selection or the page.
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "open-ask") return;
    asking = false;
    text = String(message.text ?? globalThis.getSelection() ?? "").trim();
    openBox(text ? selectionRect() : null);
  });
})();
