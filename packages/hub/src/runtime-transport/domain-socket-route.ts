import {
  RELAY_RUNTIME_AGENT_INSTANCE_CONNECT_PATH,
  RELAY_RUNTIME_HUMAN_CONNECT_PATH,
  RELAY_RUNTIME_MACHINE_DAEMON_CONNECT_PATH,
} from "./relay-runtime-product-adapter";

export const PUBLIC_DOMAIN_SOCKET_PATHS = [
  "/ws/humans",
  "/ws/agent-instances",
  "/ws/machine-daemons",
] as const;

export type PublicDomainSocketPath = typeof PUBLIC_DOMAIN_SOCKET_PATHS[number];

export const RELAY_RUNTIME_DOMAIN_SOCKET_PATHS: Readonly<Record<PublicDomainSocketPath, string>> =
  Object.freeze({
    "/ws/humans": RELAY_RUNTIME_HUMAN_CONNECT_PATH,
    "/ws/agent-instances": RELAY_RUNTIME_AGENT_INSTANCE_CONNECT_PATH,
    "/ws/machine-daemons": RELAY_RUNTIME_MACHINE_DAEMON_CONNECT_PATH,
  });

export interface DomainSocketTarget {
  fetch(request: Request): Promise<Response>;
}

/** Public WebSocket router: every product socket targets Relay Runtime. */
export function routeDomainSocket(
  request: Request,
  path: PublicDomainSocketPath,
  runtime: DomainSocketTarget,
): Promise<Response> {
  if (new URL(request.url).pathname !== path) {
    return Promise.resolve(Response.json({ error: "Domain socket route/path mismatch" }, { status: 400 }));
  }
  const runtimeUrl = new URL(request.url);
  runtimeUrl.pathname = RELAY_RUNTIME_DOMAIN_SOCKET_PATHS[path];
  return runtime.fetch(new Request(runtimeUrl, request));
}
