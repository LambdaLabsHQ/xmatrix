"use client";

import { useQuery } from "@tanstack/react-query";
import { MACHINE_RESOURCE_HISTORY_RANGES, WEB_PROXY_ROUTES, type MachineResourceHistory,
  type MachineResourceHistoryRange } from "@xmatrix/protocol";
import { useState, type PointerEvent } from "react";

import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { useAuth } from "@/lib/auth-context";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

import {
  MACHINE_LOAD_SERIES, formatLoadValue, formatPointTime,
  machineLoadSegments, machineLoadSummary, segmentPath,
  type MachineLoadSeries,
} from "./machine-load-history";

const WIDTH = 600;
const HEIGHT = 56;
/** Short ranges move while the panel is open; long ones change once an hour. */
const REFRESH_MS: Record<MachineResourceHistoryRange, number | false> = {
  "1h": 60_000, "24h": 60_000, "7d": false, "30d": false, "90d": false,
};

function fetchMachineResourceHistory(token: string, machineId: string, range: MachineResourceHistoryRange,
  signal?: AbortSignal): Promise<MachineResourceHistory> {
  return xmatrixApiRequest<MachineResourceHistory>({
    url: `${WEB_PROXY_ROUTES.machine_resource_history(machineId)}?range=${range}`, token, signal });
}

/** The owner's view of how one Machine's load changed: a small chart per measure, sharing one time axis. */
export function MachineLoadHistoryChart({ machineId, token }: { machineId: string; token: string }) {
  const userId = useAuth().user?.id ?? "anonymous";
  const [range, setRange] = useState<MachineResourceHistoryRange>("24h");
  const [hover, setHover] = useState<number | null>(null);
  const history = useQuery({
    queryKey: xmatrixQueryKeys.domain({ userId }, "machine-load-history", [machineId, range]),
    queryFn: ({ signal }) => fetchMachineResourceHistory(token, machineId, range, signal),
    staleTime: 30_000,
    refetchInterval: () => typeof document !== "undefined" && document.hidden ? false : REFRESH_MS[range],
    refetchIntervalInBackground: false,
  });
  const data = history.data?.range === range ? history.data : undefined;
  const series = data ? MACHINE_LOAD_SERIES.filter((item) => machineLoadSummary(data, item)) : [];

  return (
    <div className="mt-4 space-y-3 border-t border-border/70 pt-3" data-testid="machine-load-history">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">Load history</span>
        <SegmentedTabs label="Load history range" value={range} onChange={(key) => { setRange(key); setHover(null); }}
          items={MACHINE_RESOURCE_HISTORY_RANGES.map((key) => ({ key, label: key }))} />
      </div>
      {history.isError ? (
        <p className="text-sm text-muted-foreground">Load history is unavailable right now.</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Loading load history…</p>
      ) : series.length === 0 ? (
        <p className="text-sm text-muted-foreground">No load samples in this range yet.</p>
      ) : (
        <div className="space-y-3" onPointerLeave={() => setHover(null)}>
          {series.map((item) => (
            <MeasureChart key={item.key} history={data} series={item} hover={hover} onHover={setHover} />
          ))}
          <div className="flex justify-between text-xs text-muted-foreground tabular-nums" aria-hidden="true">
            <span>{formatPointTime(data.from, data.resolution)}</span>
            <span>{data.resolution === "hour" ? "Hourly average" : "Per minute"}</span>
            <span>{formatPointTime(data.to, data.resolution)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function MeasureChart({ history, series, hover, onHover }: {
  history: MachineResourceHistory; series: MachineLoadSeries; hover: number | null; onHover: (index: number | null) => void;
}) {
  const { segments, max } = machineLoadSegments(history, series, WIDTH, HEIGHT);
  const summary = machineLoadSummary(history, series)!;
  const points = segments.flat();
  const hovered = hover === null ? undefined : points.find((point) => point.index === hover);
  const sample = hover === null ? undefined : history.points[hover];
  const peak = series.peak && history.resolution === "hour" ? sample?.[series.peak] : undefined;

  // The nearest sample in time to the pointer, across every chart of this Machine.
  const track = (event: PointerEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const box = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - box.left) / Math.max(box.width, 1)) * WIDTH;
    const nearest = points.reduce((best, point) => Math.abs(point.x - x) < Math.abs(best.x - x) ? point : best);
    onHover(nearest.index);
  };

  return (
    <figure className="m-0 space-y-1">
      <figcaption className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{series.label}</span>
        <span className="tabular-nums">
          {sample ? (
            <>
              <span className="mr-2 text-xs text-muted-foreground">{formatPointTime(sample.at, history.resolution)}</span>
              <span className="font-bold">{formatLoadValue(series, sample[series.key])}</span>
              {typeof peak === "number" && <span className="ml-1 text-xs text-muted-foreground">peak {formatLoadValue(series, peak)}</span>}
            </>
          ) : (
            <>
              <span className="mr-2 text-xs text-muted-foreground">
                {formatLoadValue(series, summary.min)}–{formatLoadValue(series, summary.max)}
              </span>
              <span className="font-bold">{formatLoadValue(series, summary.latest)}</span>
            </>
          )}
        </span>
      </figcaption>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="block h-14 w-full touch-none overflow-visible"
        role="img" onPointerMove={track} onPointerDown={track}
        aria-label={`${series.label}: latest ${formatLoadValue(series, summary.latest)}, lowest ${formatLoadValue(series, summary.min)}, highest ${formatLoadValue(series, summary.max)}${series.percent ? "" : `, scale 0 to ${max}`}`}>
        {/* Recessive frame: the baseline and the top of the scale. */}
        <line x1={0} x2={WIDTH} y1={HEIGHT} y2={HEIGHT} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        <line x1={0} x2={WIDTH} y1={0} y2={0} stroke="var(--border)" strokeWidth={1} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
        {segments.map((segment) => segment.length === 1 ? (
          <line key={segment[0]!.index} x1={segment[0]!.x} x2={segment[0]!.x + 0.01} y1={segment[0]!.y} y2={segment[0]!.y}
            stroke="var(--chart-1)" strokeWidth={4} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ) : (
          <path key={segment[0]!.index} d={segmentPath(segment)} fill="none" stroke="var(--chart-1)" strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        ))}
        {hovered && (
          <>
            <line x1={hovered.x} x2={hovered.x} y1={0} y2={HEIGHT} stroke="var(--muted-foreground)" strokeWidth={1}
              vectorEffect="non-scaling-stroke" />
            <line x1={hovered.x} x2={hovered.x + 0.01} y1={hovered.y} y2={hovered.y} stroke="var(--chart-1)" strokeWidth={8}
              strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
      {!series.percent && (
        <span className="block text-right text-xs text-muted-foreground tabular-nums" aria-hidden="true">scale 0–{max}</span>
      )}
    </figure>
  );
}
