/**
 * Marks the one entry a phone browser keeps above the page, so its Back
 * button lands in the page's own Back instead of leaving.
 */
export const BROWSER_BACK_ENTRY_STATE_KEY = "__xmatrixBackEntry";

/**
 * Runs from the document head, before any other popstate listener exists. A
 * phone browser keeps one marked entry above the app (use-system-back.ts); Back
 * off it lands on the entry under it, whose address is the one it had when
 * the mark was pushed. The router and the shell would show that address at
 * once, so this puts back the address the marked entry had last, hands Back to
 * the page (`window.__xmatrixNativeBack`), and puts the mark back. With nothing
 * to go Back from, Back carries on out of the app.
 */
export const browserBackEntryScript = `(() => {
  const key = ${JSON.stringify(BROWSER_BACK_ENTRY_STATE_KEY)};
  const history = window.history;
  const pushState = history.pushState, replaceState = history.replaceState;
  const href = () => location.pathname + location.search + location.hash;
  const marked = () => Boolean(history.state && history.state[key]);
  let shown = href();
  history.pushState = function () { pushState.apply(history, arguments); shown = href(); };
  history.replaceState = function () { replaceState.apply(history, arguments); shown = href(); };
  window.addEventListener("popstate", () => {
    if (!window.__xmatrixBackEntryActive || marked()) { shown = href(); return; }
    replaceState.call(history, history.state, "", shown);
    let handled = false;
    try { handled = window.__xmatrixNativeBack?.() === true; } catch (error) { console.error(error); }
    if (handled) history.pushState({ ...history.state, [key]: true }, "", href());
    else history.back();
  });
})();`;
