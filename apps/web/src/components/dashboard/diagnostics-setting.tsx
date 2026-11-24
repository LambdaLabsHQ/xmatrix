"use client";

import { useSyncExternalStore } from "react";

import { Switch } from "@/components/ui/switch";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabled,
  subscribeDiagnosticsPreference,
} from "@/lib/diagnostics-preference";
import { ToolDetailSection, ToolSettingRow } from "./tool-split";

/** Settings toggle for optional client diagnostics, onboarding counts, and crash reporting. */
export function DiagnosticsSetting() {
  const enabled = useSyncExternalStore(
    subscribeDiagnosticsPreference,
    () => isDiagnosticsEnabled(),
    () => true,
  );

  return (
    <ToolDetailSection title="Diagnostics">
      <ToolSettingRow
        title="Send diagnostics and crash reports"
        description="Share anonymized startup timing, onboarding progress, and error reports so we can fix bugs. Never includes messages, code, or credentials. Respects Do Not Track and Global Privacy Control."
        control={(
          <Switch
            checked={enabled}
            onChange={setDiagnosticsEnabled}
            label="Send diagnostics and crash reports"
          />
        )}
      />
    </ToolDetailSection>
  );
}
