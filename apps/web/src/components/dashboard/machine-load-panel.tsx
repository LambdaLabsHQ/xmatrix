"use client";

import { machineResourceObservation } from "@xmatrix/protocol";

import { MachineLoadHistoryChart } from "./machine-load-history-chart";
import { machineGlanceReadings, machineLoadReadings, meterTone } from "./machine-load";
import { MachineNetworkPanel } from "./machine-network-panel";
import { MeterReadingList } from "./meter-reading-list";
import type { MachineSummary } from "./workspace-shell-helpers";

/** Live load of an online Machine, and for its owner how that load changed;
 * an offline Machine has no current load but keeps its history. */
export function MachineLoadPanel({ machine, now, token }: { machine: MachineSummary; now: number; token?: string | null }) {
  const online = machine.status === "online" && machine.daemon;
  const history = token && machine.machineId
    ? <MachineLoadHistoryChart key={machine.machineId} machineId={machine.machineId} token={token} /> : null;
  if (!online) return history;
  const resources = machineResourceObservation(machine.daemon!.metadata?.machineResources, now);
  const readings = machineLoadReadings(resources);
  return (
    <>
      <div className="mt-4 border-t border-border/70 pt-3">
        <MeterReadingList label="Machine load" readings={readings}
          empty="No recent load sample from this daemon." />
        <MachineNetworkPanel network={resources?.network} now={now} />
      </div>
      {history}
    </>
  );
}

/** A Machine's load at a glance in its list row: processor, memory and disk, each a toned bar. */
export function MachineLoadGlance({ machine, now }: { machine: MachineSummary; now: number }) {
  if (machine.status !== "online" || !machine.daemon) return null;
  return <MachineLoadGlanceBars glance={machineGlanceReadings(machineLoadReadings(
    machineResourceObservation(machine.daemon.metadata?.machineResources, now)))} />;
}

/** The glance bars themselves; the Machine tag's hover card shows the same ones. */
export function MachineLoadGlanceBars({ glance, label, testId = "machine-load-glance" }: {
  glance: readonly { key: string; label: string; percent: number; detail?: string }[];
  label?: string; testId?: string;
}) {
  if (!glance.length) return null;
  return (
    <span role="img" className="app-machine-load-glance" data-testid={testId}
      aria-label={label ?? glance.map((reading) => `${reading.label} ${reading.percent}%`).join(", ")}>
      {glance.map((reading) => (
        <span key={reading.key} className="app-machine-load-glance-item" title={reading.detail} aria-hidden="true">
          <span className="app-machine-load-glance-label">
            <span>{reading.label}</span>
            <span className="app-machine-load-glance-value font-semibold tabular-nums">{reading.percent}%</span>
          </span>
          <span className="app-machine-load-glance-track">
            <span className="app-usage-meter-fill app-machine-load-glance-fill" data-tone={meterTone(reading.percent)}
              style={{ width: `${Math.max(reading.percent, 4)}%` }} />
          </span>
        </span>
      ))}
    </span>
  );
}
