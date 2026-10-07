import type { MachineResourceHistory } from "@xmatrix/protocol";

/** One small chart per measure; percentages share a 0–100 scale, load scales to its own peak. */
export type MachineLoadSeries = {
  key: "cpuPercent" | "memoryPercent" | "diskPercent" | "loadAverage1m";
  label: string;
  percent: boolean;
  /** The hourly peak shown beside the average, where the Hub keeps one. */
  peak?: "cpuPercentMax" | "memoryPercentMax";
};

export const MACHINE_LOAD_SERIES: readonly MachineLoadSeries[] = [
  { key: "cpuPercent", label: "CPU", percent: true, peak: "cpuPercentMax" },
  { key: "memoryPercent", label: "Memory", percent: true, peak: "memoryPercentMax" },
  { key: "diskPercent", label: "Disk", percent: true },
  { key: "loadAverage1m", label: "Load (1 min)", percent: false },
];

const STEP_MS = { minute: 60_000, hour: 3_600_000 } as const;
/** A gap longer than this many steps is shown as a break, never bridged. */
const GAP_STEPS = 3;

export type ChartPoint = { x: number; y: number; index: number };

/**
 * The measure's points placed in a `width`×`height` box, split into runs where
 * samples are missing (the Machine was offline or the measure absent), so the
 * line breaks there instead of inventing values.
 */
export function machineLoadSegments(history: MachineResourceHistory, series: MachineLoadSeries,
  width: number, height: number): { segments: ChartPoint[][]; max: number } {
  const from = Date.parse(history.from), to = Date.parse(history.to);
  const span = Math.max(to - from, 1);
  const values = history.points.map((point) => point[series.key]);
  const max = series.percent ? 100 : niceCeiling(Math.max(0, ...values.filter((value): value is number => value !== null)));
  const gap = STEP_MS[history.resolution] * GAP_STEPS;
  const segments: ChartPoint[][] = [];
  let current: ChartPoint[] = [];
  let previousAt: number | undefined;
  history.points.forEach((point, index) => {
    const value = point[series.key];
    const at = Date.parse(point.at);
    if (value === null || !Number.isFinite(at) || (previousAt !== undefined && at - previousAt > gap)) {
      if (current.length) segments.push(current);
      current = [];
    }
    if (value !== null && Number.isFinite(at)) {
      current.push({
        x: ((at - from) / span) * width,
        y: height - (Math.min(Math.max(value, 0), max) / max) * height,
        index,
      });
      previousAt = at;
    } else if (value === null) {
      previousAt = undefined;
    }
  });
  if (current.length) segments.push(current);
  return { segments, max };
}

/** A load scale's top: the next of 1, 2, 5 × 10ⁿ at or above the peak. */
export function niceCeiling(value: number): number {
  if (!(value > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 5, 10].find((step) => step * magnitude >= value) ?? 10) * magnitude;
}

export function segmentPath(segment: readonly ChartPoint[]): string {
  return segment.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join("");
}

export function formatLoadValue(series: MachineLoadSeries, value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return series.percent ? `${Math.round(value)}%` : value.toFixed(2);
}

/** The latest, lowest and highest value of a measure, for its heading and screen readers. */
export function machineLoadSummary(history: MachineResourceHistory, series: MachineLoadSeries) {
  const values = history.points.map((point) => point[series.key]).filter((value): value is number => value !== null);
  if (!values.length) return undefined;
  const peaks = series.peak && history.resolution === "hour"
    ? history.points.map((point) => point[series.peak!]).filter((value): value is number => typeof value === "number")
    : [];
  return { latest: values.at(-1)!, min: Math.min(...values), max: Math.max(...values, ...peaks) };
}

export function formatPointTime(at: string, resolution: MachineResourceHistory["resolution"]): string {
  return new Date(at).toLocaleString(undefined, resolution === "minute"
    ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
    : { month: "short", day: "numeric", hour: "2-digit" });
}
