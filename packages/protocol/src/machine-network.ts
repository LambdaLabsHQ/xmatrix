/** Bounded active network measurements, never Agent/model throughput. */
export interface NetworkTransferObservation {
  observedAt: string;
  bytes: number;
  durationMs: number;
  mbps: number;
  /** The byte budget was reached before a 250 ms transfer: not line capacity. */
  shortSample: boolean;
  loadedLatencyMs?: number;
}

export interface MachineNetworkObservation {
  observedAt: string;
  target: "cloudflare-speed";
  protocol: "https";
  attempts: number;
  failures: number;
  latencyMedianMs?: number;
  latencyP95Ms?: number;
  /** Mean absolute difference between consecutive successful RTTs. */
  jitterMs?: number;
  download?: NetworkTransferObservation;
  upload?: NetworkTransferObservation;
  /** ICMP round-trip probe loss to a fixed target, separate from HTTPS failures. */
  packetLoss?: { target: "1.1.1.1"; protocol: "icmp"; sent: number; received: number };
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const integer = (value: unknown, min: number, max: number): value is number =>
  number(value, min, max) && Number.isSafeInteger(value);
function timestamp(value: unknown, now: number, age: number): string | undefined {
  const at = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at <= now && now - at <= age ? new Date(at).toISOString() : undefined;
}

function transfer(value: unknown, now: number): NetworkTransferObservation | undefined {
  if (!record(value)) return undefined;
  const observedAt = timestamp(value.observedAt, now, 2 * 60 * 60_000);
  if (!observedAt || !integer(value.bytes, 1, 4 * 1024 * 1024) ||
    !number(value.durationMs, 1, 20_000) || !number(value.mbps, 0, 1_000_000) ||
    value.shortSample !== (value.durationMs < 250) ||
    Math.abs(value.mbps - value.bytes * 8 / value.durationMs / 1000) > 0.001) return undefined;
  return { observedAt, bytes: value.bytes, durationMs: value.durationMs,
    mbps: value.mbps, shortSample: value.shortSample,
    ...(number(value.loadedLatencyMs, 0, 20_000) ? { loadedLatencyMs: value.loadedLatencyMs } : {}) };
}

export function machineNetworkObservation(value: unknown, now: number): MachineNetworkObservation | undefined {
  if (!record(value)) return undefined;
  const observedAt = timestamp(value.observedAt, now, 15 * 60_000);
  if (!observedAt || value.target !== "cloudflare-speed" || value.protocol !== "https" ||
    !integer(value.attempts, 1, 100) || !integer(value.failures, 0, value.attempts)) return undefined;
  const result: MachineNetworkObservation = { observedAt, target: "cloudflare-speed", protocol: "https",
    attempts: value.attempts, failures: value.failures };
  if (value.failures < value.attempts) {
    for (const key of ["latencyMedianMs", "latencyP95Ms", "jitterMs"] as const) {
      if (number(value[key], 0, 20_000)) result[key] = value[key];
    }
    if (result.latencyMedianMs !== undefined && result.latencyP95Ms !== undefined &&
      result.latencyMedianMs > result.latencyP95Ms) return undefined;
  }
  for (const key of ["download", "upload"] as const) {
    const measured = transfer(value[key], now);
    if (measured) result[key] = measured;
  }
  const loss = value.packetLoss;
  if (record(loss) && loss.target === "1.1.1.1" && loss.protocol === "icmp" &&
    integer(loss.sent, 20, 100) && integer(loss.received, 1, loss.sent)) {
    result.packetLoss = { target: "1.1.1.1", protocol: "icmp", sent: loss.sent, received: loss.received };
  }
  return result;
}
