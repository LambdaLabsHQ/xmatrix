"use client";

import { machineResourceObservation } from "@xmatrix/protocol";

import { MachineLoadHistoryChart } from "./machine-load-history-chart";
import { machineLoadReadings } from "./machine-load";
import { MeterReadingList } from "./machine-load-panel";
import { MachineNetworkPanel } from "./machine-network-panel";
import type { MachineSummary } from "./workspace-shell-helpers";

// A Machine's detail; its list row and tag show only the glance in machine-load-panel.

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
