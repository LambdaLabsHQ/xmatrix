"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, Check, CircleDashed, CircleHelp, Info, Minus, Timer, TriangleAlert, type LucideIcon } from "lucide-react";
import type { MachineNetworkObservation } from "@xmatrix/protocol";
import { statusInkClass } from "@/components/ui/status-tone";
import { formatRelativeAge, formatZonedDateTime } from "./time-display";

type Network = MachineNetworkObservation;
const milliseconds = (value: number | undefined) => value === undefined ? "Unknown" : `${value.toFixed(0)} ms`;

type Quality = "Good" | "Fair" | "Poor" | "Unrated";
type Unit = "ms" | "%" | "Mbps";
const qualities: readonly Quality[] = ["Good", "Fair", "Poor", "Unrated"];

// Three display bands adapted from Cloudflare AIM's metric breakpoints, not
// its experience score. Grade shown values so rounding cannot contradict the
// visible threshold. ICMP loss remains separate from HTTPS responsiveness.
// https://github.com/cloudflare/speedtest/blob/40dd87a4cc144cedaf5f3d4ffe88077d5e092bae/src/config/internalConfig.ts
function quality(value: number | undefined, unit: Unit, approximate: boolean): Quality {
  if (value === undefined || approximate) return "Unrated";
  if (unit === "ms") return value < 50 ? "Good" : value < 100 ? "Fair" : "Poor";
  if (unit === "%") return value < 1 ? "Good" : value < 5 ? "Fair" : "Poor";
  return value >= 10 ? "Good" : value >= 1 ? "Fair" : "Poor";
}

const qualityInk = (grade: Quality) => statusInkClass(grade === "Poor" ? "alert" :
  grade === "Fair" ? "attention" : grade === "Unrated" ? "secondary" : "settled");

function QualityMark({ grade }: { grade: Quality }) {
  const Icon = { Good: Check, Fair: Minus, Poor: TriangleAlert, Unrated: CircleHelp }[grade];
  return <Icon role="img" aria-label={grade} className={`size-3 shrink-0 ${qualityInk(grade)}`} strokeWidth={1.75} />;
}

function Reading({ icon: Icon, label, value, unit, hint, approximate = false }: {
  icon: LucideIcon; label: string; value?: number; unit: Unit; hint: string; approximate?: boolean;
}) {
  const shown = value?.toFixed(unit === "ms" ? 0 : 1);
  const grade = quality(shown === undefined ? undefined : Number(shown), unit, approximate);
  return <div role="group" aria-label={label} title={`${grade} · ${hint}`} className="flex min-w-0 items-center gap-2">
    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
    <span className={`flex min-w-0 items-center gap-1 tabular-nums ${qualityInk(grade)}`}>
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-bold">{shown === undefined ? "—" : `${approximate ? "≈" : ""}${shown}`}</span>
        {shown !== undefined && <span className="text-xs text-muted-foreground">{unit === "%" ? "" : " "}{unit}</span>}
      </span>
      <QualityMark grade={grade} />
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
      <Reading icon={Timer} label="Latency" value={network?.latencyMedianMs} unit="ms"
        hint={`HTTPS latency (p50) to Cloudflare Speed: ${milliseconds(network?.latencyMedianMs)}`} />
      <Reading icon={CircleDashed} label="Packet loss" value={loss ? (loss.sent - loss.received) / loss.sent * 100 : undefined}
        unit="%" hint={loss ? `ICMP packet loss to 1.1.1.1: ${loss.received}/${loss.sent} replies` : "ICMP packet loss: unknown"} />
      {(["download", "upload"] as const).map(direction => {
        const sample = network?.[direction];
        const label = direction === "download" ? "Download" : "Upload";
        return <Reading key={direction} icon={direction === "download" ? ArrowDown : ArrowUp} label={label}
          value={sample?.mbps} unit="Mbps" approximate={sample?.shortSample}
          hint={`${label} to Cloudflare Speed${sample?.shortSample ? ": short sample, not line capacity" : sample ? "" : ": unknown"}`} />;
      })}
    </div>
    {expanded && <div className="mt-4 space-y-2 border-t border-border/70 pt-3 text-xs text-muted-foreground" aria-label="Network measurement details">
      <div className="flex flex-wrap gap-x-3 gap-y-1">{qualities.map(grade =>
        <span key={grade} className="inline-flex items-center gap-1"><QualityMark grade={grade} />{grade}</span>)}</div>
      <p>Display bands: latency &lt;50 / &lt;100 / ≥100 ms; loss &lt;1 / &lt;5 / ≥5%; speed ≥10 / ≥1 / &lt;1 Mbps.</p>
      <p>Quality describes the probe target. ≈ Short samples are unrated.</p>
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
