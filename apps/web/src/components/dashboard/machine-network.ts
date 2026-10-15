import type { MachineNetworkObservation } from "@xmatrix/protocol";

export function machineNetworkText(network: MachineNetworkObservation | undefined): string {
  if (!network) return "network unmeasured";
  const ms = (value: number | undefined) => value === undefined ? "unknown" : `${value.toFixed(0)} ms`;
  const speed = (value: MachineNetworkObservation["download"]) => value
    ? `${value.mbps.toFixed(1)} Mbps${value.shortSample ? " (short sample)" : ""}` : "unknown";
  const loss = network.packetLoss;
  const packetLoss = loss ? `${((1 - loss.received / loss.sent) * 100).toFixed(1)}% (${loss.sent} ICMP probes)` : "unknown (ICMP unavailable)";
  return [`HTTPS p50/p95 ${ms(network.latencyMedianMs)}/${ms(network.latencyP95Ms)}`,
    `jitter ${ms(network.jitterMs)}`, `requests failed ${network.failures}/${network.attempts}`,
    `ICMP loss ${packetLoss}`, `↓ ${speed(network.download)}`, `↑ ${speed(network.upload)}`,
    ...(network.download?.loadedLatencyMs !== undefined || network.upload?.loadedLatencyMs !== undefined
      ? [`loaded RTT ↓ ${ms(network.download?.loadedLatencyMs)} / ↑ ${ms(network.upload?.loadedLatencyMs)}`] : [])].join(" · ");
}
