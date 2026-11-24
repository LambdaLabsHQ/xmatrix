"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { HUB_ROUTES, WEB_PROXY_ROUTES, type DiagnosticsChoice } from "@xmatrix/protocol";
import { X } from "lucide-react";

import {
  chooseDiagnostics,
  configureDiagnosticsConsent,
  currentDiagnosticsDecision,
  diagnosticsPreferenceVersion,
  diagnosticsPromptDismissed,
  dismissDiagnosticsPrompt,
  refreshDiagnosticsConsent,
  subscribeDiagnosticsPreference,
} from "@/lib/diagnostics-preference";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { hubReadResponse } from "@/lib/query/hub-read";

/**
 * Connects the diagnostics gate to this session's Hub, re-reads it whenever
 * the live connection comes back, and shows the beta's one-time prompt: a
 * notice that diagnostics are on (where they may be on by default), or an
 * unticked opt-in checkbox (where they need consent). The stable build shows
 * nothing; its switch is in Settings → Legal and privacy.
 */
export function DiagnosticsConsentPrompt({ token, onOpenSettings }: {
  token: string | null | undefined;
  onOpenSettings: () => void;
}) {
  useEffect(() => {
    if (!token) return;
    configureDiagnosticsConsent({
      async read(build, signal) {
        const query = `?build=${build}`;
        const response = await hubReadResponse({
          hubPath: `${HUB_ROUTES.me_diagnostics}${query}`,
          webUrl: `${WEB_PROXY_ROUTES.me_diagnostics}${query}`,
          token,
          signal,
        });
        if (!response.ok) throw new Error(`Diagnostics consent read failed (${response.status})`);
        return response.json();
      },
      async write(choice) {
        await xmatrixApiRequest({ url: WEB_PROXY_ROUTES.me_diagnostics, token, method: "PUT", body: { choice } });
      },
    });
    void refreshDiagnosticsConsent();
    // Reconnecting can mean a new network, and so a new country: ask again.
    const onPush = (event: Event) => {
      if ((event as CustomEvent<{ connected?: boolean }>).detail?.connected === true) void refreshDiagnosticsConsent();
    };
    window.addEventListener("xmatrix:human-push", onPush);
    window.addEventListener("online", onPush as EventListener);
    return () => {
      window.removeEventListener("xmatrix:human-push", onPush);
      window.removeEventListener("online", onPush as EventListener);
      configureDiagnosticsConsent(null);
    };
  }, [token]);

  useSyncExternalStore(subscribeDiagnosticsPreference, diagnosticsPreferenceVersion, () => 0);
  const { prompt } = currentDiagnosticsDecision();
  const [ticked, setTicked] = useState(false);
  const [saving, setSaving] = useState(false);
  if (prompt === "none" || diagnosticsPromptDismissed(prompt)) return null;

  if (prompt === "notice") {
    return (
      <div className="pointer-events-none absolute left-1/2 top-[calc(52px+env(safe-area-inset-top,0px)+48px)] z-[60] w-max max-w-[calc(100%-2rem)] -translate-x-1/2"
        role="status" data-testid="diagnostics-notice">
        <span className="app-paper-tile pointer-events-auto inline-flex items-center gap-2 px-3 py-1.5 text-[0.8125rem]">
          <span>
            This beta sends diagnostics to help fix bugs.{" "}
            <button type="button" className="underline underline-offset-2" onClick={onOpenSettings}>Turn off</button>
          </span>
          <button type="button" aria-label="Dismiss" className="opacity-60 hover:opacity-100"
            onClick={() => dismissDiagnosticsPrompt("notice")}>
            <X className="size-3.5" aria-hidden />
          </button>
        </span>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    try {
      // Only a ticked box is consent; leaving it unticked records nothing.
      if (ticked) await recordChoice("opted-in");
      dismissDiagnosticsPrompt("opt-in");
    } catch {
      setSaving(false);
    }
  }

  return (
    <div className="pointer-events-none absolute left-1/2 top-[calc(52px+env(safe-area-inset-top,0px)+48px)] z-[60] w-max max-w-[calc(100%-2rem)] -translate-x-1/2"
      data-testid="diagnostics-opt-in">
      <span className="app-paper-tile pointer-events-auto inline-flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[0.8125rem]">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
          Send diagnostics to help improve the beta
        </label>
        <button type="button" className="font-semibold underline underline-offset-2" disabled={saving}
          onClick={() => void save()}>
          Done
        </button>
      </span>
    </div>
  );
}

/**
 * Records an explicit choice on the Hub and, on Desktop, the local daemon's
 * matching setting, so its network diagnostics follow the same choice.
 */
export async function recordChoice(choice: DiagnosticsChoice): Promise<void> {
  await chooseDiagnostics(choice);
  const bridge = getDesktopBridge();
  if (bridge?.setLocalPrivacySetting) {
    await bridge.setLocalPrivacySetting("telemetry", choice === "opted-in").catch(() => undefined);
  }
}
