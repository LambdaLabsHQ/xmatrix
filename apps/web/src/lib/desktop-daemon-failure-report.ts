"use client";

import { WEB_PROXY_ROUTES, type DesktopDaemonFailure } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";

const reported = new Set<string>();

/**
 * Tells the Hub that the desktop App could not start its background service:
 * where, the exit code and the CLI's last lines, which the App already
 * redacted on the machine (docs/architecture/first-space.md). The same failure
 * is reported once per page; nothing waits on it.
 */
export function reportDesktopDaemonFailure(
  token: string | null | undefined,
  failure: DesktopDaemonFailure,
  app: { platform: string; version: string },
): void {
  const key = `${failure.stage}\n${failure.exitCode ?? ""}\n${failure.detail}`;
  if (!token || reported.has(key)) return;
  reported.add(key);
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.observable_desktop_daemon_failure, token, method: "POST",
    body: { ...failure, platform: app.platform, appVersion: app.version } })
    .catch((error: unknown) => console.warn("[xmatrix] daemon start failure not reported", error));
}
