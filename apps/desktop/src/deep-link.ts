/*
 * Where an `xmatrix://` link lands inside the app. A connect that the app
 * started returns here from the browser (`xmatrix://connect/oauth?state=…`):
 * the app, not the browser, then finishes it with its own sign-in.
 */

const CONNECT_KEYS = ["state", "code", "configurationId", "teamId", "next"];

/** The app path for a deep link; anything unknown opens the app itself. */
export function deepLinkAppPath(value: string, protocol = "xmatrix"): string {
  let url: URL;
  try { url = new URL(value); } catch { return "/app"; }
  if (url.protocol !== `${protocol}:`) return "/app";
  if (url.hostname === "channel") {
    const channelId = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (channelId) return `/app?channel=${encodeURIComponent(channelId)}`;
  }
  if (url.hostname === "login") return `/login${url.search}`;
  if (url.hostname === "connect" && url.pathname === "/oauth") {
    const query = new URLSearchParams();
    for (const key of CONNECT_KEYS) {
      const values = url.searchParams.getAll(key);
      if (values.length === 1 && values[0]!.length <= 4_096) query.set(key, values[0]!);
    }
    if (query.has("state")) return `/connect/oauth?${query.toString()}`;
  }
  return "/app";
}
