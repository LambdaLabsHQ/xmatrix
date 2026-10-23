import { AsyncLocalStorage } from "node:async_hooks";
import { isRelayRuntimeOwnerCell, RELAY_RUNTIME_SELECTED_CELL } from "./runtime-cell-locator";

type RuntimeDeliveryIngress = "socket_message" | "socket_close" | "socket_error" |
  "fetch_presence" | "fetch_message" | "fetch_observable" | "fetch_committed" | "fetch_other" | "fanout";
const ingress = new AsyncLocalStorage<RuntimeDeliveryIngress>();

/** Invocation-local provenance; concurrent sockets and RPCs must never share it. */
export function withRuntimeDeliveryIngress<T>(value: RuntimeDeliveryIngress, operation: () => T): T {
  return ingress.run(value, operation);
}

const FETCH_INGRESS: Readonly<Record<string, RuntimeDeliveryIngress>> = {
  "/internal/product/channel-agent-presence": "fetch_presence",
  "/internal/product/channel-message": "fetch_message",
  "/internal/product/channel-observable-event": "fetch_observable",
  "/internal/committed-event": "fetch_committed",
};

export function runtimeDeliveryFetchIngress(request: Request): RuntimeDeliveryIngress {
  return FETCH_INGRESS[new URL(request.url).pathname] ?? "fetch_other";
}

export type RuntimeDeliveryRoute = "directory" | "fanout" | "legacy";
export type RuntimePresenceReason = "connect" | "update" | "disconnect";

/** Only fixed labels and bounded retry counts enter exception messages. */
export function runtimeDeliveryFailureDiagnostic(input: {
  url: string;
  route: RuntimeDeliveryRoute;
  sourceCell?: string;
  targetCell?: string;
  reason?: RuntimePresenceReason;
  phase: "fetch" | "response";
  attempts: number;
}): string {
  const delivery = runtimeDeliveryFetchIngress(new Request(input.url)).replace(/^fetch_/u, "");
  return `ingress=${ingress.getStore() ?? "unknown"} delivery=${delivery} route=${input.route} ` +
    `source=${cellRole(input.sourceCell)} target=${cellRole(input.targetCell)} ` +
    `reason=${input.reason ?? "unknown"} phase=${input.phase} attempts=${input.attempts}`;
}

function cellRole(cell: string | undefined): "legacy" | "owner" | "partition" | "unknown" {
  if (cell === undefined) return "unknown";
  if (cell === RELAY_RUNTIME_SELECTED_CELL) return "legacy";
  if (isRelayRuntimeOwnerCell(cell)) return "owner";
  return "partition";
}
