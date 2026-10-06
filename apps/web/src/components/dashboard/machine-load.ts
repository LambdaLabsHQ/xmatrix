/**
 * Machine load presentation.
 *
 * The daemon reports numeric samples roughly every 30 seconds; the protocol
 * parser has already rejected stale, future and incoherent values, so this
 * module only turns what remains into display rows. A missing measurement is
 * omitted rather than shown as zero.
 */

import type { MachineResourceObservation } from "@xmatrix/protocol";

export type MachineLoadReading = {
  key: "cpu" | "load" | "memory" | "swap" | "disk";
  label: string;
  value: string;
  detail?: string;
  /** Share of capacity in use, 0..1; absent when there is no capacity to compare with. */
  fraction?: number;
  /** A person should look at this Machine. */
  high: boolean;
};

const HIGH_USE = 0.9;
const GIB = 1024 ** 3;

function share(used: number, total: number): number {
  return Math.min(Math.max(used / total, 0), 1);
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * GIB) return `${(bytes / (1024 * GIB)).toFixed(1)} TiB`;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1024 ** 2)} MiB`;
}

function capacityReading(
  key: "memory" | "swap" | "disk",
  label: string,
  total: number | undefined,
  free: number | undefined,
): MachineLoadReading | undefined {
  if (total === undefined || free === undefined || total <= 0) return undefined;
  const used = total - free;
  const fraction = share(used, total);
  return {
    key,
    label,
    value: `${Math.round(fraction * 100)}%`,
    detail: `${formatBytes(used)} of ${formatBytes(total)}`,
    fraction,
    high: fraction >= HIGH_USE,
  };
}

export function machineLoadReadings(resources: MachineResourceObservation | undefined): MachineLoadReading[] {
  if (!resources) return [];
  const readings: MachineLoadReading[] = [];
  const cores = resources.cpuLogicalCount;
  if (resources.cpuUsagePercent !== undefined) {
    const fraction = share(resources.cpuUsagePercent, 100);
    readings.push({
      key: "cpu",
      label: "CPU",
      value: `${Math.round(resources.cpuUsagePercent)}%`,
      ...(cores ? { detail: `${cores} ${cores === 1 ? "core" : "cores"}` } : {}),
      fraction,
      high: fraction >= HIGH_USE,
    });
  }
  if (resources.loadAverage) {
    const [one, five, fifteen] = resources.loadAverage;
    // Run-queue length per core: 1.0 means every core has work waiting.
    const perCore = cores ? one / cores : undefined;
    readings.push({
      key: "load",
      label: "Load average",
      value: one.toFixed(2),
      detail: `${five.toFixed(2)} · ${fifteen.toFixed(2)} (5m · 15m)`,
      ...(perCore !== undefined ? { fraction: share(perCore, 1) } : {}),
      high: perCore !== undefined && perCore >= 1,
    });
  }
  for (const reading of [
    capacityReading("memory", "Memory", resources.memoryTotalBytes, resources.memoryAvailableBytes),
    capacityReading("swap", "Swap", resources.swapTotalBytes, resources.swapFreeBytes),
    capacityReading("disk", "Disk (home)", resources.diskTotalBytes, resources.diskAvailableBytes),
  ]) {
    if (reading) readings.push(reading);
  }
  return readings;
}

/** One colour scale for every usage meter, quota and machine load alike. */
export type MeterTone = "green" | "yellow" | "red";

export function meterTone(percent: number): MeterTone {
  return percent >= 90 ? "red" : percent >= 70 ? "yellow" : "green";
}

const GLANCE_LABEL: Partial<Record<MachineLoadReading["key"], string>> = { cpu: "CPU", load: "CPU", memory: "Mem", disk: "Disk" };

/** One bar of a Machine's load at a glance. */
export type MachineGlanceReading = { key: MachineLoadReading["key"]; label: string; percent: number };

/** The readings a list row has room for: processor (CPU, else run queue per core), memory and disk. */
export function machineGlanceReadings(readings: readonly MachineLoadReading[]): MachineGlanceReading[] {
  const processor = readings.find((reading) => reading.key === "cpu" && reading.fraction !== undefined)
    ?? readings.find((reading) => reading.key === "load" && reading.fraction !== undefined);
  return [processor, ...readings.filter((reading) => reading.key === "memory" || reading.key === "disk")]
    .filter((reading): reading is MachineLoadReading & { fraction: number } => reading?.fraction !== undefined)
    .map((reading) => ({ key: reading.key, label: GLANCE_LABEL[reading.key]!, percent: Math.round(reading.fraction * 100) }));
}

/**
 * How busy a Machine is for the work it is given, 0..100: the busier of its
 * processor and memory. Disk capacity does not contribute to the Machine
 * tag's load; it remains a separate reading in the Machine resource panel.
 */
export function machineBusyPercent(readings: readonly MachineLoadReading[]): number | undefined {
  const glance = machineGlanceReadings(readings);
  const counted = glance.filter((reading) => reading.key !== "disk");
  return counted.length ? Math.max(...counted.map((reading) => reading.percent)) : undefined;
}
