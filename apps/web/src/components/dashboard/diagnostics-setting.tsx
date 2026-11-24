"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { Switch } from "@/components/ui/switch";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabled,
  subscribeDiagnosticsPreference,
} from "@/lib/diagnostics-preference";
import { ToolDetailSection, ToolSettingRow } from "./tool-split";

/** Settings toggles for opt-in client diagnostics and (on Desktop) local provider quota probes. */
export function DiagnosticsSetting() {
  const enabled = useSyncExternalStore(
    subscribeDiagnosticsPreference,
    () => isDiagnosticsEnabled(),
    () => false,
  );
  const [localPrivacy, setLocalPrivacy] = useState<{ telemetry: boolean; quotaProbes: boolean } | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.getLocalPrivacySettings) return;
    let cancelled = false;
    void bridge.getLocalPrivacySettings().then((settings) => {
      if (!cancelled && settings) setLocalPrivacy(settings);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  function handleDiagnosticsChange(next: boolean) {
    setDiagnosticsEnabled(next);
    const bridge = getDesktopBridge();
    if (!bridge?.setLocalPrivacySetting) return;
    void bridge.setLocalPrivacySetting("telemetry", next).then((settings) => {
      if (settings) setLocalPrivacy(settings);
    }).catch(() => undefined);
  }

  function handleQuotaProbesChange(next: boolean) {
    setLocalPrivacy((current) => (current ? { ...current, quotaProbes: next } : current));
    const bridge = getDesktopBridge();
    if (!bridge?.setLocalPrivacySetting) return;
    void bridge.setLocalPrivacySetting("quotaProbes", next).then((settings) => {
      if (settings) setLocalPrivacy(settings);
    }).catch(() => undefined);
  }

  return (
    <ToolDetailSection title="Diagnostics and local privacy">
      <ToolSettingRow
        title="Send diagnostics and crash reports"
        description="Off by default. Opt in to share keyed-HMAC pseudonymized startup timing, onboarding progress, CLI reconnect samples, and scrubbed error reports so we can fix bugs. Never includes messages, code, or credentials."
        control={(
          <Switch
            checked={enabled}
            onChange={handleDiagnosticsChange}
            label="Send diagnostics and crash reports"
          />
        )}
      />
      {localPrivacy && (
        <ToolSettingRow
          title="Local provider quota probes"
          description="Read local login stores of registered agent tools in memory to query each provider's usage endpoint directly from this computer. Credentials never leave this machine; only normalized remaining quota is sent to xMatrix."
          control={(
            <Switch
              checked={localPrivacy.quotaProbes}
              onChange={handleQuotaProbesChange}
              label="Local provider quota probes"
            />
          )}
        />
      )}
    </ToolDetailSection>
  );
}
