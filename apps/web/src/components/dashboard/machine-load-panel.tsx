"use client";

import { machineResourceObservation } from "@xmatrix/protocol";

import { statusInkClass } from "@/components/ui/status-tone";
import { cn } from "@/lib/utils";

import { MachineLoadHistoryChart } from "./machine-load-history-chart";
import { machineGlanceReadings, machineLoadReadings, meterTone, type MachineGlanceReading } from "./machine-load";
import type { MachineSummary } from "./workspace-shell-helpers";

/** One measured share, shown as a labelled value over a bar. */
export type MeterReading = {
  key: string;
  label: string;
  value: string;
  detail?: string;
  /** Share in use, 0..1; absent when there is nothing to compare with. */
  fraction?: number;
  /** A person should look at this. */
  high: boolean;
};

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
export function MachineLoadGlanceBars({ glance }: { glance: readonly MachineGlanceReading[] }) {
  if (!glance.length) return null;
  return (
    <span role="img" className="app-machine-load-glance" data-testid="machine-load-glance"
      aria-label={glance.map((reading) => `${reading.label} ${reading.percent}%`).join(", ")}>
      {glance.map((reading) => (
        <span key={reading.key} className="app-machine-load-glance-item" aria-hidden="true">
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

/** Labelled readings, each over its bar; machine load and agent usage share it. */
export function MeterReadingList({ label, readings, empty }: {
  label: string; readings: readonly MeterReading[]; empty?: string;
}) {
  return (
    <div className="space-y-2.5 text-sm" aria-label={label}>
      {readings.length === 0 ? (
        empty ? <p className="text-muted-foreground">{empty}</p> : null
      ) : (
        readings.map((reading) => (
          <div key={reading.key} className="space-y-1">
            <div className="flex min-w-0 items-baseline justify-between gap-3">
              <span className="shrink-0 text-muted-foreground">{reading.label}</span>
              <span className="min-w-0 text-right [overflow-wrap:anywhere]">
                {reading.detail && <span className="mr-2 text-xs text-muted-foreground">{reading.detail}</span>}
                <span className={cn("font-bold tabular-nums", reading.high && statusInkClass("attention"))}>{reading.value}</span>
              </span>
            </div>
            {reading.fraction !== undefined && (
              <div
                role="meter"
                aria-label={reading.label}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(reading.fraction * 100)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10"
              >
                <div
                  className={cn("h-full rounded-full transition-[width] duration-500 ease-out",
                    reading.high ? "bg-[var(--m-ink-attention,var(--accent))]" : "bg-foreground/60")}
                  style={{ width: `${reading.fraction * 100}%` }}
                />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
