"use client";

import { useEffect, useState, useSyncExternalStore } from "react";

import { Switch } from "@/components/ui/switch";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import {
  DIAGNOSTICS_BUILD,
  diagnosticsPreferenceVersion,
  isDiagnosticsEnabled,
  subscribeDiagnosticsPreference,
} from "@/lib/diagnostics-preference";
import { recordChoice } from "./diagnostics-consent-prompt";
import { ToolDetailSection, ToolSettingRow } from "./tool-split";

const DIAGNOSTICS_DESCRIPTION = DIAGNOSTICS_BUILD === "beta"
  ? "In this beta, on by default outside the EU, EEA, UK and Switzerland; there, only if you turn it on. "
  : "Off by default. ";

/** Settings toggles for client diagnostics and (on Desktop) local provider quota probes. */
export function DiagnosticsSetting() {
  useSyncExternalStore(subscribeDiagnosticsPreference, diagnosticsPreferenceVersion, () => 0);
  const enabled = isDiagnosticsEnabled();
  const [choiceError, setChoiceError] = useState<string | null>(null);
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
    setChoiceError(null);
    void recordChoice(next ? "opted-in" : "opted-out").then(async () => {
      const settings = await getDesktopBridge()?.getLocalPrivacySettings?.().catch(() => null);
      if (settings) setLocalPrivacy(settings);
    }, () => setChoiceError("Couldn't save your choice. Try again."));
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
        description={`${DIAGNOSTICS_DESCRIPTION}Shares keyed-HMAC pseudonymized startup timing, onboarding progress, CLI reconnect samples, and scrubbed error reports so we can fix bugs. Never includes messages, code, or credentials.${choiceError ? ` ${choiceError}` : ""}`}
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
          description="Ask Codex, Claude Code and OpenCode for their remaining quota, and read other registered agent tools' local login stores in memory to query each provider's usage endpoint directly from this computer. Credentials never leave this machine; only normalized remaining quota is sent to xMatrix."
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
