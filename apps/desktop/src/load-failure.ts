/** Chromium's code for a navigation the shell itself replaced or cancelled. */
const NAVIGATION_ABORTED = -3;

/** How often the failure page tries the app again on its own. */
export const LOAD_RETRY_INTERVAL_MS = 15_000;

/** A failed main-frame load the person must see; cancelled navigations are not failures. */
export function isVisibleLoadFailure(errorCode: number, isMainFrame: boolean, url: string): boolean {
  return isMainFrame && errorCode !== NAVIGATION_ABORTED && !url.startsWith("data:");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The page a window shows when the app itself could not load: what happened,
 * in the app's paper, with a retry in place. It tries again when the network
 * returns and every LOAD_RETRY_INTERVAL_MS, so it never strands the window.
 */
export function loadFailurePage(targetUrl: string, offline: boolean, backgroundColor: string): string {
  const message = offline
    ? "You’re offline. xMatrix will open when the network is back."
    : "xMatrix can’t be reached right now. Still trying to connect…";
  const target = JSON.stringify(targetUrl);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>xMatrix</title>
<style>
html,body{margin:0;height:100%;background:${backgroundColor};-webkit-app-region:drag}
body{display:grid;place-items:center;font:600 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif;color:rgba(40,32,24,.72)}
.tile{display:inline-flex;align-items:center;gap:10px;padding:8px 14px;border-radius:10px;background:rgba(40,32,24,.05)}
button{-webkit-app-region:no-drag;font:inherit;color:rgba(40,32,24,.95);background:rgba(40,32,24,.06);border:0;border-radius:8px;padding:4px 10px;cursor:pointer}
button:hover{background:rgba(40,32,24,.1)}
</style></head><body><p class="tile" role="status"><span>${escapeHtml(message)}</span><button type="button" id="retry">Try again</button></p>
<script>
const target=${target};
const retry=()=>location.replace(target);
document.getElementById("retry").addEventListener("click",retry);
window.addEventListener("online",retry);
setInterval(()=>{if(navigator.onLine)retry();},${LOAD_RETRY_INTERVAL_MS});
</script></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}
