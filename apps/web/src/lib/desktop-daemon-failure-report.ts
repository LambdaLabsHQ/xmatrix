"use client";

import { useSyncExternalStore } from "react";
import { WEB_PROXY_ROUTES, type DesktopDaemonFailure, type DesktopDaemonFailureReport } from "@xmatrix/protocol";
import { isDiagnosticsEnabled } from "@/lib/diagnostics-preference";
import { xmatrixApiRequest } from "@/lib/query/api-client";

/** Per failure and per kind: the automatic report never stands in for the person's own. */
const reported = new Set<string>();
/** Failures the person sent and the Hub accepted: only these may say they were sent. */
const delivered = new Set<string>();
const listeners = new Set<() => void>();

const failureKey = (failure: DesktopDaemonFailure) => `${failure.stage}\n${failure.exitCode ?? ""}\n${failure.detail}`;

/**
 * Tells the Hub that the desktop App could not start its background service:
 * where, the exit code, the platform and the App version
 * (docs/architecture/first-space.md). The CLI's last lines, which the App
 * already redacted on the machine, go only when the person presses Send on the
 * failure card (`explicit`); the opted-in automatic report never carries them.
 * The same failure is reported once per page; nothing waits on it.
 */
export function reportDesktopDaemonFailure(
  token: string | null | undefined,
  failure: DesktopDaemonFailure,
  app: { platform: string; version: string },
  options?: { explicit?: boolean },
): void {
  const key = failureKey(failure);
  const explicit = options?.explicit === true;
  const attempt = `${explicit ? "sent" : "automatic"}\n${key}`;
  if (!token || (!explicit && !isDiagnosticsEnabled()) || reported.has(attempt)) return;
  reported.add(attempt);
  const report: DesktopDaemonFailureReport = {
    stage: failure.stage,
    ...(failure.exitCode !== undefined ? { exitCode: failure.exitCode } : {}),
    platform: app.platform as DesktopDaemonFailureReport["platform"],
    appVersion: app.version,
    ...(explicit ? { detail: failure.detail } : {}),
  };
  void xmatrixApiRequest({ url: WEB_PROXY_ROUTES.observable_desktop_daemon_failure, token, method: "POST", body: report })
    .then(() => {
      if (!explicit) return;
      delivered.add(key);
      for (const listener of listeners) listener();
    }, (error: unknown) => {
      // Not sent: a later showing of the same failure may try again.
      reported.delete(attempt);
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
