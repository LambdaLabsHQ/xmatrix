"use client";

import { useSyncExternalStore } from "react";
import { WEB_PROXY_ROUTES, type DesktopDaemonFailure } from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";

const reported = new Set<string>();
/** Failures the Hub accepted: only these may say they were sent. */
const delivered = new Set<string>();
const listeners = new Set<() => void>();

const failureKey = (failure: DesktopDaemonFailure) => `${failure.stage}\n${failure.exitCode ?? ""}\n${failure.detail}`;

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
  const key = failureKey(failure);
  if (!token || reported.has(key)) return;
  reported.add(key);
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.observable_desktop_daemon_failure, token, method: "POST",
    body: { ...failure, platform: app.platform, appVersion: app.version } })
    .then(() => {
      delivered.add(key);
      for (const listener of listeners) listener();
    }, (error: unknown) => {
      // Not sent: a later showing of the same failure may try again.
      reported.delete(key);
      console.warn("[xmatrix] daemon start failure not reported", error);
    });
}

/** Whether the Hub has this failure, so the App may say it was sent. */
export function useDesktopDaemonFailureDelivered(failure: DesktopDaemonFailure): boolean {
  const key = failureKey(failure);
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, () => delivered.has(key), () => false);
}
