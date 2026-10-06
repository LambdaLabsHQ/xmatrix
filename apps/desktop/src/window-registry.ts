/**
 * Multi-window support for the desktop shell.
 *
 * The main process has no notion of a Space: a Space is a web route
 * (`/app/<spaceId>/...`), so "two Spaces open at once" is just two windows
 * loading two URLs in the same Electron session. Everything here is the pure
 * part of that — window selection, placement, and validating a path the
 * renderer asked to open — so it can be tested without Electron.
 */

export type WindowSnapshot = {
  id: number;
  destroyed: boolean;
  focused: boolean;
};

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Which window a window-less action (a menu dialog, a deep link, a tray click)
 * should land in. The focused window wins; otherwise the most recently focused
 * one that is still alive; otherwise the oldest surviving window. Returns null
 * only when every window is gone.
 */
export function pickPrimaryWindowId(
  windows: readonly WindowSnapshot[],
  lastFocusedId: number | null
): number | null {
  const alive = windows.filter((window) => !window.destroyed);
  if (alive.length === 0) return null;
  const focused = alive.find((window) => window.focused);
  if (focused) return focused.id;
  const lastFocused = alive.find((window) => window.id === lastFocusedId);
  if (lastFocused) return lastFocused.id;
  return alive[0].id;
}

const CASCADE_STEP = 32;

/**
 * Where to put a new window. Electron centers an unpositioned window, so a
 * second window would land exactly on top of the first. Step down-right from
 * the window being opened from, and start over from the work-area origin once
 * the cascade would push the title bar off-screen — an unreachable title bar
 * is worse than an overlap.
 */
export function cascadeBounds(
  from: WindowBounds | null,
  workArea: WindowBounds,
  size: { width: number; height: number }
): { x: number; y: number } {
  const origin = {
    x: workArea.x + Math.max(0, Math.round((workArea.width - size.width) / 2)),
    y: workArea.y + Math.max(0, Math.round((workArea.height - size.height) / 2)),
  };
  if (!from) return origin;

  const next = { x: from.x + CASCADE_STEP, y: from.y + CASCADE_STEP };
  const fitsHorizontally = next.x + size.width <= workArea.x + workArea.width;
  const fitsVertically = next.y + size.height <= workArea.y + workArea.height;
  if (fitsHorizontally && fitsVertically) return next;
  return { x: workArea.x + CASCADE_STEP, y: workArea.y + CASCADE_STEP };
}

/**
 * Turn a renderer-supplied path into an absolute URL on the app's own origin,
 * or null when it is not a plain in-app path. The renderer is trusted to name
 * a route, never an origin: anything with a scheme, an authority, or a
 * backslash (which some URL parsers fold into `/`) is refused rather than
 * normalized, so this cannot become a way to load a foreign page inside the
 * shell's privileged window.
 */
export function resolveInternalAppUrl(
  startUrl: string,
  requestedPath: string
): string | null {
  const trimmed = requestedPath.trim();
  if (!trimmed.startsWith("/")) return null;
  if (trimmed.startsWith("//")) return null;
  if (trimmed.includes("\\")) return null;

  try {
    const base = new URL(startUrl);
    const resolved = new URL(trimmed, base);
    if (resolved.origin !== base.origin) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * The Space a window is showing, as the `/app/<spaceId>` segment of its URL, or
 * null for a page that is not Space-scoped (`/app` itself, `/docs`, sign-in).
 * Used to focus the window that already holds a Space instead of opening a
 * second window onto it.
 */
export function appSpaceKey(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    if (segments[0] !== "app") return null;
    return segments[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The window to reuse for a target URL: one already showing the same Space.
 * A target with no Space always opens a new window — `/app` resolves to
 * whatever the working Space is, so reusing on it would silently swallow the
 * request to get a second window.
 */
export function findWindowForTarget(
  windows: readonly (WindowSnapshot & { url: string })[],
  targetUrl: string
): number | null {
  const target = appSpaceKey(targetUrl);
  if (!target) return null;
  const match = windows.find(
    (window) => !window.destroyed && appSpaceKey(window.url) === target
  );
  return match ? match.id : null;
}

export type WindowBadgeReport = {
  /**
   * What the count is counted over — the window's Space. Two windows left on
   * the same Space each report that Space's whole count, so they must collapse
   * to one entry instead of doubling the dock badge.
   */
  key: string;
  mentionCount: number;
  hasUnread: boolean;
};

/**
 * The one dock badge for every window. Each window reports the unread state of
 * the Space it is showing, so the badge is the sum across distinct Spaces —
 * anything less would hide a mention waiting in the other window.
 */
export function aggregateBadge(
  reports: readonly WindowBadgeReport[]
): { mentionCount: number; hasUnread: boolean } {
  const bySpace = new Map<string, WindowBadgeReport>();
  for (const report of reports) bySpace.set(report.key, report);
  let mentionCount = 0;
  let hasUnread = false;
  for (const report of bySpace.values()) {
    mentionCount += Number.isFinite(report.mentionCount)
      ? Math.max(0, Math.floor(report.mentionCount))
      : 0;
    hasUnread = hasUnread || report.hasUnread;
  }
  return { mentionCount, hasUnread };
}
