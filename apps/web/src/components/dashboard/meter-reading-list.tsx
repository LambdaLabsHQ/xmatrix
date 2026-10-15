"use client";

import { statusInkClass } from "@/components/ui/status-tone";
import { cn } from "@/lib/utils";

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
