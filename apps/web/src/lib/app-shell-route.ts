/**
 * The addresses the workspace shell answers itself. The shell reads its Space,
 * view and channel from `location`, so every one of them is served the same
 * prerendered `/workspace` page (middleware.ts) instead of a per-request render.
 * A reload or a link into a channel then waits for a static file, not a cold
 * isolate rendering the same startup frame.
 *
 * Legacy addresses (`direct`, `roles`, `analytics`, `/app/<space>/<channel>`)
 * are left to their redirect routes under `app/(en)/app/[spaceId]`.
 */
const SHELL_SEGMENTS = new Set([
  "activity", "admin", "agents", "apps", "automation", "channels", "local", "machines",
  "more", "pages", "profile", "projects", "search", "security", "settings", "status", "team",
]);

export function isAppShellPath(pathname: string): boolean {
  const [empty, app, space, segment, channel, ...rest] = pathname.split("/");
  if (empty !== "" || app !== "app" || rest.length > 0) return false;
  if (space === undefined) return true;
  if (!space) return false;
  if (segment === undefined) return true;
  if (channel === undefined) return SHELL_SEGMENTS.has(segment);
  return segment === "channels" && channel !== "";
}
