// Quick select: when text is selected on a page the person allowed, a small
// button appears beside it to discuss it in xMatrix or quote it in the open
// conversation. It is registered only after the person grants web-page access
// from the side panel (background.js syncSelectionScript). It reads nothing
// until they click, and then only the selected text.
(() => {
  if (window.top !== window || globalThis.__xmatrixSelection) return;
  globalThis.__xmatrixSelection = true;

  const host = document.createElement("div");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; display: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      .bar { display: flex; gap: 2px; padding: 3px; border-radius: 999px; background: oklch(0.976 0.005 85);
        box-shadow: 0 6px 18px -6px oklch(0.18 0.04 55 / 0.45), 0 0 0 1px oklch(0.46 0.05 60 / 18%);
        font: 600 12.5px/1 Inter, system-ui, sans-serif; }
      button { display: flex; align-items: center; gap: 6px; height: 26px; border: 0; border-radius: 999px; padding: 0 10px;
        background: transparent; color: oklch(0.255 0.025 58); font: inherit; cursor: pointer; }
      button:hover, button:focus-visible { outline: 0; background: oklch(0.255 0.025 58 / 7%); }
      svg { width: 14px; height: 14px; fill: oklch(0.75 0.09 70); }
    </style>
    <div class="bar" role="toolbar" aria-label="xMatrix">
      <button type="button" data-target="new"><svg viewBox="0 0 14 14" aria-hidden="true"><rect x="6" y="1" width="3.6" height="3.6" rx=".8"/><rect x="9.6" y="1" width="3.4" height="3.6" rx=".8"/><rect x="9.6" y="4.6" width="3.4" height="3.6" rx=".8"/><rect x="1" y="8.8" width="3.6" height="3.6" rx=".8"/></svg>Discuss</button>
      <button type="button" data-target="current">Quote</button>
    </div>`;
  document.documentElement.append(host);

  let text = "";

  function hide() {
    host.style.display = "none";
    text = "";
  }

  function place() {
    const selection = globalThis.getSelection();
    const selected = String(selection ?? "").trim();
    if (!selected || !selection.rangeCount) return hide();
    const rect = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
    if (!rect.width && !rect.height) return hide();
    text = selected;
    host.style.display = "block";
    const top = rect.bottom + 8 + 32 > innerHeight ? rect.top - 40 : rect.bottom + 8;
    host.style.top = `${Math.max(4, top)}px`;
    host.style.left = `${Math.min(Math.max(4, rect.right - 150), innerWidth - 160)}px`;
  }

  root.addEventListener("mousedown", (event) => event.preventDefault());
  root.addEventListener("click", (event) => {
    const button = event.target.closest?.("button");
    if (!button || !text) return;
    chrome.runtime.sendMessage({ type: "chip", target: button.dataset.target, text }).catch(() => undefined);
    hide();
  });
  document.addEventListener("mouseup", (event) => {
    if (event.composedPath().includes(host)) return;
    setTimeout(place, 0);
  });
  document.addEventListener("keyup", (event) => {
    if (event.key === "Escape") hide();
    else if (event.shiftKey) setTimeout(place, 0);
  });
  document.addEventListener("scroll", hide, { capture: true, passive: true });
  document.addEventListener("selectionchange", () => {
    if (!String(globalThis.getSelection() ?? "").trim()) hide();
  });
})();
