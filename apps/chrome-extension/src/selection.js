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

  const MARK = `<svg viewBox="0 0 14 14" aria-hidden="true"><rect x="6" y="1" width="3.6" height="3.6" rx=".8"/><rect x="9.6" y="1" width="3.4" height="3.6" rx=".8"/><rect x="9.6" y="4.6" width="3.4" height="3.6" rx=".8"/><rect x="1" y="8.8" width="3.6" height="3.6" rx=".8"/></svg>`;
  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; display: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
      .pill { display: flex; align-items: center; gap: 7px; height: 32px; min-width: 168px; border: 0; border-radius: 999px; padding: 0 14px 0 10px;
        background: #fff; color: oklch(0.49 0.03 62); font-size: 13px; font-weight: 500; cursor: text;
        box-shadow: 0 8px 20px -8px oklch(0.18 0.04 55 / 0.5), 0 0 0 1px oklch(0.46 0.05 60 / 20%);
        animation: in 140ms cubic-bezier(0.2, 0.9, 0.3, 1); }
      .pill:hover { color: oklch(0.255 0.025 58); box-shadow: 0 8px 20px -8px oklch(0.18 0.04 55 / 0.55), 0 0 0 1px oklch(0.46 0.05 60 / 34%); }
      .pill:focus-visible { outline: 2px solid oklch(0.46 0.065 58); outline-offset: 2px; }
      svg { width: 14px; height: 14px; flex: none; fill: oklch(0.62 0.11 75); }
      .box { display: none; width: 360px; max-width: calc(100vw - 16px); padding: 12px; border-radius: 18px;
        background: oklch(0.976 0.005 85); color: oklch(0.255 0.025 58);
        box-shadow: 0 22px 48px -18px oklch(0.18 0.04 55 / 0.55), 0 0 0 1px oklch(0.46 0.05 60 / 18%);
        animation: in 160ms cubic-bezier(0.2, 0.9, 0.3, 1); }
      @keyframes in { from { opacity: 0; transform: translateY(4px) scale(0.98); } }
      @media (prefers-reduced-motion: reduce) { .pill, .box { animation: none; } }
      .head { display: flex; align-items: center; gap: 6px; margin: 0 2px 8px; font-size: 12.5px; font-weight: 650; }
      .where { flex: 1; min-width: 0; overflow: hidden; color: oklch(0.49 0.03 62); font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
      .close { width: 24px; height: 24px; border: 0; border-radius: 999px; background: none; color: oklch(0.49 0.03 62); font-size: 16px; line-height: 1; cursor: pointer; }
      .close:hover { background: oklch(0.255 0.025 58 / 7%); }
      .quote { margin: 0 2px 10px; padding-left: 10px; border-left: 2px solid oklch(0.62 0.11 75 / 55%); color: oklch(0.42 0.03 62);
        font-size: 12.5px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .field { position: relative; }
      textarea { display: block; width: 100%; min-height: 64px; max-height: 180px; resize: none; border: 1px solid oklch(0.46 0.05 60 / 18%);
        border-radius: 14px; padding: 10px 46px 10px 12px; background: #fff; color: inherit; font-size: 14px; line-height: 1.45; outline: 0; }
      textarea:focus { border-color: oklch(0.46 0.05 60 / 42%); box-shadow: 0 0 0 3px oklch(0.62 0.11 75 / 14%); }
      textarea::placeholder { color: oklch(0.49 0.03 62 / 80%); }
      .send { position: absolute; right: 8px; bottom: 8px; display: grid; place-items: center; width: 30px; height: 30px; border: 0; border-radius: 999px;
        color: oklch(0.12 0.015 55); background: oklch(0.83 0.07 76); cursor: pointer;
        box-shadow: inset 0 1px 0 oklch(1 0.02 90 / 0.5), 0 6px 14px -8px oklch(0.18 0.04 55 / 0.7); }
      .send svg { fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
      .send:disabled { opacity: 0.45; cursor: default; }
      .foot { margin: 8px 2px 0; min-height: 16px; font-size: 11.5px; color: oklch(0.49 0.03 62); }
      .foot.error { color: oklch(0.55 0.19 28); }
      .foot.done { color: oklch(0.45 0.09 150); font-weight: 600; }
      kbd { font: inherit; padding: 0 4px; border-radius: 4px; background: oklch(0.255 0.025 58 / 7%); }
    </style>
    <button class="pill" type="button">${MARK}Ask about this…</button>
    <form class="box" aria-label="Ask about this">
      <div class="head">${MARK}<span class="where"></span><button class="close" type="button" aria-label="Close">×</button></div>
      <p class="quote"></p>
      <div class="field">
        <textarea rows="2" placeholder="Ask about this…"></textarea>
        <button class="send" type="submit" aria-label="Ask" disabled><svg viewBox="0 0 14 14"><path d="M7 11.5v-9M3 6l4-4 4 4"/></svg></button>
      </div>
      <p class="foot"></p>
    </form>`;
  document.documentElement.append(host);

  const pill = root.querySelector(".pill");
  const box = root.querySelector(".box");
  const where = root.querySelector(".where");
  const quote = root.querySelector(".quote");
  const field = root.querySelector("textarea");
  const send = root.querySelector(".send");
  const foot = root.querySelector(".foot");
  const HINT = "<kbd>Enter</kbd> to ask · an Agent answers in the side panel";
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
    placeAt(rect, 30);
  }

  function setFoot(html, kind = "") {
    foot.innerHTML = html;
    foot.className = `foot ${kind}`;
  }

  /** Opens the box beside `rect` (the selection), or at the top right of the page for the page itself. */
  async function openBox(rect) {
    pill.style.display = "none";
    box.style.display = "block";
    quote.textContent = text || document.title || location.host;
    field.value = "";
    send.disabled = true;
    where.textContent = "xMatrix";
    setFoot(HINT);
    const anchor = rect ?? { top: 16, bottom: 16, left: innerWidth - 376 };
    placeAt(anchor, box.offsetHeight || 190);
    field.focus();
    const target = await chrome.runtime.sendMessage({ type: "quick-ask-target" }).catch(() => null);
    if (target?.ok && target.value?.signedIn === false) {
      setFoot("Sign in to xMatrix in the side panel first.", "error");
    } else if (target?.ok && target.value?.spaceName) {
      where.textContent = target.value.spaceName;
      where.title = `Asked in ${target.value.spaceName}, the Space open in the side panel`;
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
      setFoot(`Asked in ${answer.value.spaceName} · the answer opens in the side panel`, "done");
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
  root.querySelector(".close").addEventListener("click", () => { asking = false; hide(); });
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
