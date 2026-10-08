import { subscribeResume } from "../../lib/connectivity/connectivity";

/** Refresh promptly after suspension without multiplying focus/visibility events. */
export function listenForForegroundRefresh(refresh: () => void): () => void {
  let lastRefresh = -Infinity;
  return subscribeResume(() => {
    const now = performance.now();
    if (now - lastRefresh < 1_000) return;
    lastRefresh = now;
    refresh();
  });
}
