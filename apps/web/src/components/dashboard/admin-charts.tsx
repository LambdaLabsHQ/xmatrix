"use client";

/**
 * The platform-admin charts: ink on the paper, one axis each, and a readout
 * above the plot that names every series at the hovered day (or the latest
 * one) — the legend and the tooltip in one line, so nothing floats over the
 * data. Each chart's numbers are also in a table, so the readout never gates.
 */

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { formatAdminCount } from "./platform-admin-overview";
import { adminNiceCeiling, formatAdminDay } from "./platform-admin-analytics";

/** Ink steps on the paper, darkest first: the darkest carries the story, lighter ones what surrounds it. */
export const ADMIN_INK = ["var(--chart-1)", "var(--chart-3)", "var(--chart-4)"] as const;

export interface AdminChartSeries {
  key: string;
  label: string;
  color: string;
  values: readonly number[];
}

const AXIS_GUTTER = 32;
const PLOT_TOP = 6;

function useMeasuredWidth<Element extends HTMLElement>() {
  const ref = useRef<Element>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(Math.floor(element.getBoundingClientRect().width));
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Arrow keys walk the days the pointer would; Escape returns to the latest. */
function useChartCursor(length: number) {
  const [hover, setHover] = useState<number | null>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") return setHover(null);
    const step = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!step || length === 0) return;
    event.preventDefault();
    setHover((current) => Math.min(length - 1, Math.max(0, (current ?? length - 1) + step)));
  };
  return { hover, setHover, onKeyDown };
}

function Readout({ title, series, index, shape, format, extra }: {
  title: string;
  series: readonly AdminChartSeries[];
  index: number;
  shape: "line" | "rect";
  format: (value: number) => string;
  extra?: ReactNode;
}) {
  return (
    <figcaption className="mb-2 flex min-h-5 flex-wrap items-baseline gap-x-4 gap-y-1 text-xs" aria-live="polite">
      <span className="text-muted-foreground tabular-nums">{title}</span>
      {series.map((item) => (
        <span key={item.key} className="inline-flex items-baseline gap-1.5">
          <span aria-hidden="true" className={cn("inline-block self-center", shape === "line" ? "h-0.5 w-3 rounded-full" : "size-2 rounded-[2px]")}
            style={{ background: item.color }} />
          <span className="font-semibold tabular-nums text-foreground">{format(item.values[index] ?? 0)}</span>
          <span className="text-muted-foreground">{item.label}</span>
        </span>
      ))}
      {extra}
    </figcaption>
  );
}

function ticks(max: number): number[] {
  return [0, max / 2, max];
}

function YAxis({ max, y, width, format }: { max: number; y: (value: number) => number; width: number; format: (value: number) => string }) {
  return (
    <>
      {ticks(max).map((tick) => (
        <g key={tick}>
          <line x1={AXIS_GUTTER} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeWidth={1} />
          <text x={AXIS_GUTTER - 6} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted-foreground text-[10px] tabular-nums">
            {format(tick)}
          </text>
        </g>
      ))}
    </>
  );
}

function XLabels({ dates, x }: { dates: readonly string[]; x: (index: number) => number }) {
  if (dates.length === 0) return null;
  const picks = dates.length > 2 ? [0, Math.floor((dates.length - 1) / 2), dates.length - 1] : dates.map((_, index) => index);
  return (
    <>
      {[...new Set(picks)].map((index, position, all) => (
        <text key={index} x={x(index)} dy="1em" className="fill-muted-foreground text-[10px] tabular-nums"
          textAnchor={position === 0 && all.length > 1 ? "start" : position === all.length - 1 && all.length > 1 ? "end" : "middle"}>
          {formatAdminDay(dates[index]!)}
        </text>
      ))}
    </>
  );
}

/** Lines over UTC days on one axis, with a crosshair that snaps to the nearest day. */
export function AdminLineChart({ dates, series, label, height = 168, format = formatAdminCount, extra }: {
  dates: readonly string[];
  series: readonly AdminChartSeries[];
  label: string;
  height?: number;
  format?: (value: number) => string;
  extra?: ReactNode;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const { hover, setHover, onKeyDown } = useChartCursor(dates.length);
  const max = adminNiceCeiling(Math.max(0, ...series.flatMap((item) => item.values)));
  const plotBottom = height - 18;
  const inset = 5;
  const x = (index: number) => dates.length <= 1
    ? (AXIS_GUTTER + width) / 2
    : AXIS_GUTTER + inset + (index / (dates.length - 1)) * (width - AXIS_GUTTER - 2 * inset);
  const y = (value: number) => PLOT_TOP + (1 - value / max) * (plotBottom - PLOT_TOP);
  const shown = hover ?? dates.length - 1;
  const track = (event: PointerEvent<SVGSVGElement>) => {
    if (dates.length === 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    const position = event.clientX - box.left;
    const index = dates.length <= 1 ? 0 : Math.round(((position - AXIS_GUTTER - inset) / (width - AXIS_GUTTER - 2 * inset)) * (dates.length - 1));
    setHover(Math.min(dates.length - 1, Math.max(0, index)));
  };
  return (
    <figure className="m-0" tabIndex={0} onKeyDown={onKeyDown} aria-label={label}
      onBlur={() => setHover(null)}>
      <Readout title={dates[shown] ? formatAdminDay(dates[shown]!) : ""} series={series} index={shown}
        shape="line" format={format} extra={extra} />
      <div ref={ref} className="w-full" style={{ height }}>
        {width > AXIS_GUTTER && (
          <svg width={width} height={height} className="block touch-none overflow-visible" role="img"
            aria-label={`${label}: ${series.map((item) => `${item.label} ${format(item.values.at(-1) ?? 0)}`).join(", ")}`}
            onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHover(null)}>
            <YAxis max={max} y={y} width={width} format={format} />
            {series.map((item) => (
              <path key={item.key} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"
                d={item.values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join("")} />
            ))}
            {hover !== null && (
              <line x1={x(hover)} x2={x(hover)} y1={PLOT_TOP} y2={plotBottom} stroke="var(--muted-foreground)" strokeWidth={1} />
            )}
            {series.map((item) => (
              <circle key={item.key} cx={x(shown)} cy={y(item.values[shown] ?? 0)} r={4} fill={item.color}
                stroke="var(--app-panel-paper, var(--background))" strokeWidth={2} />
            ))}
            <g transform={`translate(0 ${plotBottom + 4})`}><XLabels dates={dates} x={x} /></g>
          </svg>
        )}
      </div>
    </figure>
  );
}

/** A path for a bar whose data end is rounded and whose baseline end is square. */
function barPath(left: number, top: number, width: number, height: number, round: boolean): string {
  const radius = round ? Math.min(4, width / 2, height) : 0;
  return `M${left},${top + height}V${top + radius}Q${left},${top} ${left + radius},${top}`
    + `H${left + width - radius}Q${left + width},${top} ${left + width},${top + radius}V${top + height}Z`;
}

/**
 * Stacked columns over UTC days (or weeks, when `days` says a bar sums
 * several), first series at the baseline. A 2px gap of paper separates the
 * segments of a column and neighbouring columns.
 */
export function AdminBarChart({ dates, series, label, days, height = 148, format = formatAdminCount }: {
  dates: readonly string[];
  series: readonly AdminChartSeries[];
  label: string;
  /** Days each bar sums; a bar over several days is read as the week starting on its date. */
  days?: readonly number[];
  height?: number;
  format?: (value: number) => string;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const { hover, setHover, onKeyDown } = useChartCursor(dates.length);
  const totals = dates.map((_, index) => series.reduce((total, item) => total + (item.values[index] ?? 0), 0));
  const max = adminNiceCeiling(Math.max(0, ...totals));
  const plotBottom = height - 18;
  const plotWidth = Math.max(0, width - AXIS_GUTTER);
  const slot = dates.length ? plotWidth / dates.length : plotWidth;
  const gap = slot >= 6 ? 2 : slot >= 3 ? 1 : 0;
  const barWidth = Math.max(1, Math.min(24, slot - gap));
  const x = (index: number) => AXIS_GUTTER + index * slot + slot / 2;
  const y = (value: number) => PLOT_TOP + (1 - value / max) * (plotBottom - PLOT_TOP);
  const shown = hover ?? dates.length - 1;
  const bucket = (days?.[shown] ?? 1) > 1;
  const title = dates[shown] ? `${bucket ? "Week of " : ""}${formatAdminDay(dates[shown]!)}` : "";
  const track = (event: PointerEvent<SVGSVGElement>) => {
    if (dates.length === 0 || slot <= 0) return;
    const box = event.currentTarget.getBoundingClientRect();
    setHover(Math.min(dates.length - 1, Math.max(0, Math.floor((event.clientX - box.left - AXIS_GUTTER) / slot))));
  };
  return (
    <figure className="m-0" tabIndex={0} onKeyDown={onKeyDown} aria-label={label} onBlur={() => setHover(null)}>
      <Readout title={title} series={series} index={shown} shape="rect" format={format}
        extra={series.length > 1 ? <span className="tabular-nums text-muted-foreground">{format(totals[shown] ?? 0)} in all</span> : undefined} />
      <div ref={ref} className="w-full" style={{ height }}>
        {width > AXIS_GUTTER && (
          <svg width={width} height={height} className="block touch-none" role="img"
            aria-label={`${label}, peaking at ${format(Math.max(0, ...totals))}`}
            onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHover(null)}>
            <YAxis max={max} y={y} width={width} format={format} />
            {dates.map((date, index) => {
              let base = plotBottom;
              const visible = series.map((item) => item.values[index] ?? 0);
              const topmost = visible.reduce((last, value, position) => value > 0 ? position : last, -1);
              return (
                <g key={date} opacity={hover === null || hover === index ? 1 : 0.55}>
                  {series.map((item, position) => {
                    const value = visible[position]!;
                    if (value <= 0) return null;
                    const full = plotBottom - y(value);
                    // The paper gap sits under every segment but the first.
                    const lifted = base < plotBottom ? 2 : 0;
                    const segment = Math.max(1, full - lifted);
                    const top = base - lifted - segment;
                    base = top;
                    return <path key={item.key} fill={item.color}
                      d={barPath(x(index) - barWidth / 2, top, barWidth, segment, position === topmost)} />;
                  })}
                </g>
              );
            })}
            <g transform={`translate(0 ${plotBottom + 4})`}><XLabels dates={dates} x={x} /></g>
          </svg>
        )}
      </div>
    </figure>
  );
}

/** A small trend under a figure: the lighter ink, the latest day marked in the darkest. */
export function AdminSparkline({ values, label }: { values: readonly number[]; label: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const width = 100;
  const height = 24;
  const x = (index: number) => (index / (values.length - 1)) * width;
  const y = (value: number) => max > 0 ? height - 2 - (value / max) * (height - 4) : height - 2;
  const last = values.length - 1;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="mt-1.5 block h-6 w-full overflow-visible"
      role="img" aria-label={label}>
      <path d={values.map((value, index) => `${index === 0 ? "M" : "L"}${x(index)},${y(value)}`).join("")}
        fill="none" stroke="var(--chart-4)" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round"
        vectorEffect="non-scaling-stroke" />
      <line x1={x(last)} x2={x(last) + 0.01} y1={y(values[last]!)} y2={y(values[last]!)} stroke="var(--chart-1)"
        strokeWidth={5} strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
