// Quick select: when text is selected on a page the person allowed, a small
// bar appears beside it. "Ask" opens a box right there to write a question;
// Enter starts a conversation with the passage and the question straight
// through the Hub (background.js quickAsk), and the side panel opens on it.
// "Quote" adds the passage to the conversation open in the panel.
//
// It is registered only after the person grants web-page access from the side
// panel (background.js syncSelectionScript). It reads nothing until they act,
// and then only the selected text.
(() => {
  if (window.top !== window || globalThis.__xmatrixSelection) return;
  globalThis.__xmatrixSelection = true;

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; display: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: Inter, system-ui, -apple-system, sans-serif; }
      .bar { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: oklch(0.976 0.005 85);
        box-shadow: 0 6px 18px -6px oklch(0.18 0.04 55 / 0.45), 0 0 0 1px oklch(0.46 0.05 60 / 18%); }
      .bar button { display: flex; align-items: center; gap: 6px; height: 26px; border: 0; border-radius: 999px; padding: 0 10px;
        background: transparent; color: oklch(0.255 0.025 58); font-size: 12.5px; font-weight: 600; cursor: pointer; }
      .bar button:hover, .bar button:focus-visible { outline: 0; background: oklch(0.255 0.025 58 / 7%); }
      svg { width: 14px; height: 14px; fill: oklch(0.75 0.09 70); }
      .ask { display: none; width: 340px; padding: 12px; border-radius: 16px; background: oklch(0.976 0.005 85);
        box-shadow: 0 16px 36px -12px oklch(0.18 0.04 55 / 0.5), 0 0 0 1px oklch(0.46 0.05 60 / 18%); color: oklch(0.255 0.025 58); }
      .quote { margin: 0 0 8px; padding-left: 9px; border-left: 2px solid oklch(0.43 0.065 58 / 30%); color: oklch(0.49 0.03 62);
        font-size: 12.5px; line-height: 1.45; max-height: 3.2em; overflow: hidden; }
      textarea { display: block; width: 100%; min-height: 62px; resize: none; border: 1px solid oklch(0.46 0.05 60 / 18%);
        border-radius: 12px; padding: 8px 11px; background: #fff; color: inherit; font-size: 13.5px; line-height: 1.45; outline: 0; }
      textarea:focus { border-color: oklch(0.46 0.05 60 / 40%); }
      .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: oklch(0.49 0.03 62); }
      .row span { flex: 1; }
      .send { height: 30px; border: 0; border-radius: 999px; padding: 0 14px; color: oklch(0.12 0.015 55); font-size: 13px; font-weight: 700;
        background: oklch(0.83 0.07 76); box-shadow: inset 0 1px 0 oklch(1 0.02 90 / 0.48), 0 6px 14px -8px oklch(0.18 0.04 55 / 0.7); cursor: pointer; }
      .send:disabled { opacity: 0.55; cursor: default; }
      .error { color: oklch(0.55 0.19 28); }
    </style>
    <div class="bar" role="toolbar" aria-label="xMatrix">
      <button type="button" data-action="ask"><svg viewBox="0 0 14 14" aria-hidden="true"><rect x="6" y="1" width="3.6" height="3.6" rx=".8"/><rect x="9.6" y="1" width="3.4" height="3.6" rx=".8"/><rect x="9.6" y="4.6" width="3.4" height="3.6" rx=".8"/><rect x="1" y="8.8" width="3.6" height="3.6" rx=".8"/></svg>Ask</button>
      <button type="button" data-action="quote">Quote</button>
    </div>
    <form class="ask">
      <p class="quote"></p>
      <textarea placeholder="Ask about this, or @claude to hand it over"></textarea>
      <div class="row"><span class="status">Enter to start a conversation</span><button class="send" type="submit">Ask</button></div>
    </form>`;
  document.documentElement.append(host);

  const bar = root.querySelector(".bar");
  const form = root.querySelector(".ask");
  const quote = root.querySelector(".quote");
  const field = root.querySelector("textarea");
  const status = root.querySelector(".status");
  const send = root.querySelector(".send");
  let text = "";
  let asking = false;

  function hide() {
    if (asking) return;
    host.style.display = "none";
    bar.style.display = "flex";
    form.style.display = "none";
    text = "";
  }

  function placeAt(rect, height) {
    host.style.display = "block";
    const below = rect.bottom + 8;
    const top = below + height > innerHeight ? rect.top - height - 8 : below;
    host.style.top = `${Math.max(4, top)}px`;
    host.style.left = `${Math.min(Math.max(4, rect.left), innerWidth - host.offsetWidth - 8)}px`;
  }

  function place() {
    if (form.style.display === "block") return;
    const selection = globalThis.getSelection();
    const selected = String(selection ?? "").trim();
    if (!selected || !selection.rangeCount) return hide();
    const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();
    text = selected;
    placeAt(rect, 36);
  }

  function openAsk() {
    const rect = host.getBoundingClientRect();
    bar.style.display = "none";
    form.style.display = "block";
    quote.textContent = text;
    status.textContent = "Enter to start a conversation";
    status.classList.remove("error");
    field.value = "";
    placeAt(rect, 170);
    field.focus();
  }

  async function submit() {
    const question = field.value.trim();
    if (!question || asking) return;
    asking = true;
    send.disabled = true;
    status.classList.remove("error");
    status.textContent = "Starting…";
    try {
      const answer = await chrome.runtime.sendMessage({ type: "quick-ask", text, question });
      if (!answer?.ok) throw new Error(answer?.error ?? "xMatrix could not be reached.");
      status.textContent = `Started in ${answer.value.spaceName}`;
      setTimeout(() => { asking = false; hide(); }, 1200);
    } catch (error) {
      asking = false;
      status.classList.add("error");
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      send.disabled = false;
    }
  }

  root.addEventListener("mousedown", (event) => {
    if (!event.composedPath().includes(field)) event.preventDefault();
  });
  bar.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button || !text) return;
    if (button.dataset.action === "ask") openAsk();
    else {
      chrome.runtime.sendMessage({ type: "chip", target: "current", text }).catch(() => undefined);
      hide();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });
  field.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      asking = false;
      hide();
    }
  });
  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    if (form.style.display === "block" && !asking) hide();
    setTimeout(place, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") hide();
    else if (event.shiftKey) setTimeout(place, 0);
  });
  document.addEventListener("scroll", () => {
    if (form.style.display !== "block") hide();
  }, { capture: true, passive: true });
})();
