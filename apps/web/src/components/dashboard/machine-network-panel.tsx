"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, CircleDashed, Info, Timer, type LucideIcon } from "lucide-react";
import type { MachineNetworkObservation } from "@xmatrix/protocol";
import { statusInkClass } from "@/components/ui/status-tone";
import { formatRelativeAge, formatZonedDateTime } from "./time-display";

type Network = MachineNetworkObservation;
const milliseconds = (value: number | undefined) => value === undefined ? "Unknown" : `${value.toFixed(0)} ms`;

function Reading({ icon: Icon, label, value, unit, hint, approximate = false, high = false }: {
  icon: LucideIcon; label: string; value?: string; unit: string; hint: string; approximate?: boolean; high?: boolean;
}) {
  return <div role="group" aria-label={label} title={hint} className="flex min-w-0 items-center gap-2">
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
    <span className={`min-w-0 tabular-nums ${statusInkClass(high ? "attention" : value === undefined ? "secondary" : "settled")}`}>
      <span className="font-bold">{value === undefined ? "—" : `${approximate ? "≈" : ""}${value}`}</span>
      {value !== undefined && <span className="text-xs text-muted-foreground">{unit === "%" ? "" : " "}{unit}</span>}
    </span>
  </div>;
}

/** Four glanceable measurements; protocol and sampling evidence stay on demand. */
export function MachineNetworkPanel({ network, now }: { network?: Network; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const failed = network && network.failures === network.attempts;
  const partial = network && network.failures > 0;
  const status = !network ? "Not measured" : failed ? "HTTPS probe failed" : partial ? "Some HTTPS requests failed" : "HTTPS reachable";
  const loss = network?.packetLoss;
  return <section aria-label="Machine network quality" className="mt-5 border-t border-border/70 pt-4">
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2"><h3 className="font-semibold">Network</h3>
        <span role="img" aria-label={status} title={status}
          className={`size-1.5 rounded-full border border-current ${network ? "bg-current" : ""} ${statusInkClass(
            !network ? "secondary" : failed ? "alert" : partial ? "attention" : "settled")}`} />
      </div>
      <button type="button" aria-label="Network details" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}
        className="rounded p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        title="Network details"><Info aria-hidden="true" className="size-4" strokeWidth={1.5} /></button>
    </div>
    <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
      <Reading icon={Timer} label="Latency" value={network?.latencyMedianMs?.toFixed(0)} unit="ms"
        hint={`HTTPS latency (p50) to Cloudflare Speed: ${milliseconds(network?.latencyMedianMs)}`} />
      <Reading icon={CircleDashed} label="Packet loss" value={loss ? ((1 - loss.received / loss.sent) * 100).toFixed(1) : undefined}
        unit="%" hint={loss ? `ICMP packet loss to 1.1.1.1: ${loss.received}/${loss.sent} replies` : "ICMP packet loss: unknown"}
        high={!!loss && loss.received < loss.sent} />
      {(["download", "upload"] as const).map(direction => {
        const sample = network?.[direction];
        const label = direction === "download" ? "Download" : "Upload";
        return <Reading key={direction} icon={direction === "download" ? ArrowDown : ArrowUp} label={label}
          value={sample?.mbps.toFixed(1)} unit="Mbps" approximate={sample?.shortSample}
          hint={`${label} to Cloudflare Speed${sample?.shortSample ? ": short sample, not line capacity" : sample ? "" : ": unknown"}`} />;
      })}
    </div>
    {expanded && <div className="mt-4 space-y-2 border-t border-border/70 pt-3 text-xs text-muted-foreground" aria-label="Network measurement details">
      {network ? <>
        <p>HTTPS to Cloudflare Speed: {network.attempts - network.failures}/{network.attempts} requests succeeded.</p>
        <p>Latency p95: {milliseconds(network.latencyP95Ms)} · Jitter: {milliseconds(network.jitterMs)}</p>
        <p>ICMP directly to 1.1.1.1: {loss ? `${loss.received}/${loss.sent} replies` : "Unknown"}</p>
        <p>Updated <time dateTime={network.observedAt} title={formatZonedDateTime(network.observedAt)}>{formatRelativeAge(network.observedAt, now)}</time> · {formatZonedDateTime(network.observedAt)}</p>
        {(["download", "upload"] as const).map(direction => {
          const sample = network[direction];
          if (!sample) return null;
          return <div key={direction}>
            <p>{direction === "download" ? "Download" : "Upload"}: {formatZonedDateTime(sample.observedAt)}
              {sample.loadedLatencyMs !== undefined && ` · Loaded latency ${milliseconds(sample.loadedLatencyMs)}`}</p>
            {sample.shortSample && <p>≈ Short sample (under 250 ms), not a line-capacity measurement.</p>}
          </div>;
        })}
      </> : <p>No recent network measurement from this daemon.</p>}
    </div>}
  </section>;
}
