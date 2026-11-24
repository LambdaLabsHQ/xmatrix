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
import { cn } from "@/lib/utils";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { hubReadResponse } from "@/lib/query/hub-read";

/**
 * Connects the diagnostics gate to this session's Hub, re-reads it whenever
 * the live connection comes back, and renders the beta's one-time in-flow
 * footer bar: a calm disclosure that beta diagnostics are active (where they
 * may be on by default), or an unticked opt-in checkbox (where prior consent
 * is required). Sits in normal flex flow at the bottom of `<main>` so it never
 * overlaps channels, messages, or navigation. The stable build shows nothing;
 * its switch is in Settings → Legal and privacy.
 */
export function DiagnosticsConsentPrompt({
  token,
  onOpenSettings,
  mobileDockVisible = false,
  mobileFabVisible = false,
}: {
  token: string | null | undefined;
  onOpenSettings: () => void;
  mobileDockVisible?: boolean;
  mobileFabVisible?: boolean;
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

  const barClass = cn(
    "flex w-full shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground",
    mobileDockVisible
      ? "mb-[var(--app-mobile-dock-band,0px)] md:mb-0"
      : "pb-[max(0.5rem,env(safe-area-inset-bottom,0px))] md:pb-2",
    mobileFabVisible && "pr-[calc(var(--mobile-horizontal-padding,1rem)+4.75rem)] md:pr-4",
  );

  if (prompt === "notice") {
    return (
      <div className={barClass} role="status" data-testid="diagnostics-notice">
        <span className="min-w-0 leading-snug">
          This beta shares diagnostics to help improve xMatrix.
        </span>
        <span className="inline-flex shrink-0 items-center gap-3">
          <button
            type="button"
            className="underline underline-offset-2 transition-colors hover:text-foreground"
            onClick={onOpenSettings}
          >
            Privacy settings
          </button>
          <button
            type="button"
            className="font-semibold text-foreground transition-opacity hover:opacity-80"
            onClick={() => dismissDiagnosticsPrompt("notice")}
          >
            Got it
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
    <div className={barClass} data-testid="diagnostics-opt-in">
      <label className="inline-flex min-w-0 items-center gap-2 leading-snug text-foreground">
        <input type="checkbox" checked={ticked} onChange={(event) => setTicked(event.target.checked)} />
        Send diagnostics to help improve the beta
      </label>
      <span className="inline-flex shrink-0 items-center gap-2.5">
        <button
          type="button"
          className="font-semibold text-foreground underline underline-offset-2 disabled:opacity-50"
          disabled={saving}
          onClick={() => void save()}
        >
          Done
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          className="opacity-60 transition-opacity hover:opacity-100"
          onClick={() => dismissDiagnosticsPrompt("opt-in")}
        >
          <X className="size-3.5" aria-hidden />
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
