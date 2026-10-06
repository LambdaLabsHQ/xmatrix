/** Refresh promptly after suspension without multiplying focus/visibility events. */
export function listenForForegroundRefresh(refresh: () => void): () => void {
  let lastRefresh = -Infinity;
  const resume = () => {
    if (document.hidden || navigator.onLine === false) return;
    const now = performance.now();
    if (now - lastRefresh < 1_000) return;
    lastRefresh = now;
    refresh();
  };
  window.addEventListener("focus", resume);
  window.addEventListener("online", resume);
  window.addEventListener("pageshow", resume);
  document.addEventListener("visibilitychange", resume);
  return () => {
    window.removeEventListener("focus", resume);
    window.removeEventListener("online", resume);
    window.removeEventListener("pageshow", resume);
    document.removeEventListener("visibilitychange", resume);
  };
}
