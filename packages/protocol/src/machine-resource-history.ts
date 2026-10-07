/** How far back a Machine's load history reaches. */
export const MACHINE_RESOURCE_HISTORY_RANGES = ["1h", "24h", "7d", "30d", "90d"] as const;
export type MachineResourceHistoryRange = typeof MACHINE_RESOURCE_HISTORY_RANGES[number];

/** One point of a Machine's load: percentages of capacity in use, and the
 * 1-minute load average where the OS has one. Hourly points also carry peaks. */
export interface MachineResourceHistoryPoint {
  at: string;
  cpuPercent: number | null;
  cpuPercentMax?: number | null;
  memoryPercent: number | null;
  memoryPercentMax?: number | null;
  diskPercent: number | null;
  loadAverage1m: number | null;
}

/** The owner's read of one Machine's load over a range: per-minute samples
 * for short ranges, hourly rollups for long ones. */
export interface MachineResourceHistory {
  machineId: string;
  range: MachineResourceHistoryRange;
  resolution: "minute" | "hour";
  from: string;
  to: string;
  points: MachineResourceHistoryPoint[];
}
