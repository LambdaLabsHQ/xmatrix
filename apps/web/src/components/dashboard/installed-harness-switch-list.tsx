"use client";

import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { harnessSpaceSwitch } from "./harness-space-switch";
import type { useInstalledHarnesses } from "./use-installed-harnesses";

/** Installed candidates which have no active registration yet. Existing
 * registrations keep their activity and configuration rows in Agents. */
export function InstalledHarnessSwitchList({ fleet, onlyNew = false }: {
  fleet: ReturnType<typeof useInstalledHarnesses>; onlyNew?: boolean;
}) {
  const candidates = fleet.candidates.filter((candidate) => !onlyNew || !candidate.registration);
  return <div className="space-y-3" data-testid="installed-harness-switches">
    {fleet.error && <div className="space-y-2">
      <p role="alert" className="text-sm text-destructive">{fleet.error}</p>
      <Button size="sm" variant="outline" onClick={() => {
        void fleet.daemons.refetch(); void fleet.catalog.refetch();
      }}>Try again</Button>
    </div>}
    {fleet.ready && candidates.map((candidate) => {
      const toggle = harnessSpaceSwitch(candidate.registration);
      const pending = fleet.pending && fleet.pending.key.machineId === candidate.key.machineId &&
        fleet.pending.key.harness === candidate.key.harness ? fleet.pending : null;
      return <div key={candidate.id} className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-0">
        <div className="min-w-0 text-sm">
          <p className="font-semibold">{candidate.preset.displayName}</p>
          <p className="text-xs text-muted-foreground">{candidate.machineName} · {candidate.daemon.status === "online" ? "Installed" : "Offline · last reported installed"}</p>
        </div>
        {toggle ? <Switch checked={pending ? pending.on : toggle.on} disabled={Boolean(fleet.pending) || fleet.enablingAll}
          label={`Enabled: ${candidate.preset.displayName} on ${candidate.machineName}`}
          onChange={(on) => void fleet.set(candidate.key, candidate.preset, on)} />
          : <span className="text-xs text-muted-foreground">Sharing request pending</span>}
      </div>;
    })}
  </div>;
}
