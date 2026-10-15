"use client";

import type { MachineNetworkObservation } from "@xmatrix/protocol";
import { statusInkClass } from "@/components/ui/status-tone";
import { MeterReadingList, type MeterReading } from "./meter-reading-list";
import { formatRelativeAge, formatZonedDateTime } from "./time-display";

type Network = MachineNetworkObservation;
const milliseconds = (value: number | undefined) => value === undefined ? "Unknown" : `${value.toFixed(0)} ms`;

/** Percentages have measured denominators. RTT and goodput have no known
 * capacity, so they remain readings rather than invented utilisation bars. */
function readings(network: Network): MeterReading[] {
  const successes = network.attempts - network.failures;
  const loss = network.packetLoss;
  return [
    { key: "availability", label: "HTTPS success", value: `${(successes / network.attempts * 100).toFixed(0)}%`,
      detail: `${successes} of ${network.attempts} requests`, fraction: successes / network.attempts, high: network.failures > 0 },
    { key: "latency", label: "Latency (p50)", value: milliseconds(network.latencyMedianMs),
      ...(network.latencyP95Ms !== undefined ? { detail: `p95 ${milliseconds(network.latencyP95Ms)}` } : {}), high: false },
    { key: "jitter", label: "Jitter", value: milliseconds(network.jitterMs), high: false },
    { key: "loss", label: "Packet loss (ICMP)", value: loss ? `${((1 - loss.received / loss.sent) * 100).toFixed(1)}%` : "Unknown",
      ...(loss ? { detail: `${loss.received}/${loss.sent} replies`, fraction: 1 - loss.received / loss.sent } : {}),
      high: !!loss && loss.received < loss.sent },
    ...(["download", "upload"] as const).map(direction => {
      const sample = network[direction];
      return { key: direction, label: direction === "download" ? "Download" : "Upload",
        value: sample ? `${sample.mbps.toFixed(1)} Mbps` : "Unknown",
        ...(sample?.shortSample ? { detail: "Short sample" } : {}), high: false };
    }),
  ];
}

function SampleTime({ at, now, label }: { at: string; now: number; label: string }) {
  return <span>{label} <time dateTime={at} title={formatZonedDateTime(at)}>{formatRelativeAge(at, now)}</time></span>;
}

/** Machine-level probe results, using the resource panel's own reading rows. */
export function MachineNetworkPanel({ network, now }: { network?: Network; now: number }) {
  const failed = network && network.failures === network.attempts;
  const partial = network && network.failures > 0;
  const status = !network ? "Not measured" : failed ? "HTTPS probe failed" : partial ? "Some HTTPS requests failed" : "HTTPS reachable";
  return <section aria-label="Machine network quality" className="mt-5 border-t border-border/70 pt-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h3 className="font-semibold">Network</h3>
      <span aria-label="Network status" className={`inline-flex items-center gap-1.5 text-xs ${statusInkClass(
        !network ? "secondary" : failed ? "alert" : partial ? "attention" : "settled")}`}>
        <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />{status}
      </span>
    </div>
    <p className="mt-1 text-xs text-muted-foreground">HTTPS to Cloudflare Speed · ICMP to 1.1.1.1</p>
    {network ? <>
      <div className="mt-3"><MeterReadingList label="Network measurements" readings={readings(network)} /></div>
      <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <SampleTime label="Updated" at={network.observedAt} now={now} />
        <details className="min-w-0 max-w-full">
          <summary className="cursor-pointer">Measurement details</summary>
          <div className="mt-2 space-y-2 text-left">
            <p>Measured {formatZonedDateTime(network.observedAt)}.</p>
            {(["download", "upload"] as const).map(direction => {
              const sample = network[direction];
              if (!sample) return null;
              const label = direction === "download" ? "Download" : "Upload";
              return <div key={direction}>
                <p><SampleTime label={label} at={sample.observedAt} now={now} /></p>
                {sample.loadedLatencyMs !== undefined && <p>Latency during {direction}: {milliseconds(sample.loadedLatencyMs)}</p>}
                {sample.shortSample && <p>Short sample: transfer finished in under 250 ms; not a line-capacity measurement.</p>}
              </div>;
            })}
          </div>
        </details>
      </div>
    </> : <p className="mt-3 text-sm text-muted-foreground">No recent network measurement from this daemon.</p>}
  </section>;
}
