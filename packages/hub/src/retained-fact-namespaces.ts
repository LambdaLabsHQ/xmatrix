import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Historical class names preserve existing namespaces until separately proven
 * physical retirement. PostgreSQL owns their facts. These shells do not open,
 * migrate, clone, inspect, or delete the retained SQLite or KV data.
 *
 * The control-plane directory, scoped and global authorities, capacity and
 * Channel-family directories, rank directory and policy locator retired with
 * the Durable Object control plane; their namespaces stay bound as shells. The
 * Space projection lost its writers with them, so its rows are only history.
 * The Runtime route directory and its Channel fanout retired when live
 * delivery came to be addressed to each recipient's own cell
 * (runtime-principal-delivery.ts); their rows are expired routing leases.
 */
class RetainedFactNamespace extends DurableObject<Env> {
  async fetch(): Promise<Response> {
    return new Response("Durable Object fact authority is retired", { status: 410 });
  }

  async alarm(): Promise<void> {
    // A historical alarm must never materialize or mutate retired business facts.
  }
}

export class RelaySpaceRootAuthority extends RetainedFactNamespace {}
export class RelayUserPreferenceAuthority extends RetainedFactNamespace {}
export class RelaySchedulerAuthority extends RetainedFactNamespace {}
export class RelayProjectionAuthorizationAuthority extends RetainedFactNamespace {}
export class RelaySpaceMembershipAuthority extends RetainedFactNamespace {}
export class RelayChannelCatalogAuthority extends RetainedFactNamespace {}
export class RelayAgentAppPolicyAuthority extends RetainedFactNamespace {}
export class RelayTraceAccessAuthority extends RetainedFactNamespace {}
export class RelayTraceAccessLocator extends RetainedFactNamespace {}
export class RelayTraceAccessUserIndex extends RetainedFactNamespace {}
export class RelayScopedControlAuthority extends RetainedFactNamespace {}
export class RelayGlobalDirectoryAuthority extends RetainedFactNamespace {}
export class RelaySpaceCapacityAuthority extends RetainedFactNamespace {}
export class RelayControlPlaneDirectory extends RetainedFactNamespace {}
export class RelayChannelFamilyDirectory extends RetainedFactNamespace {}
export class RelayRankAuthorityDirectory extends RetainedFactNamespace {}
export class RelayAgentAppPolicyLocator extends RetainedFactNamespace {}
export class RelayChannelFamilyData extends RetainedFactNamespace {}
export class RelaySpaceProjection extends RetainedFactNamespace {}
export class RelayRuntimeRouteDirectory extends RetainedFactNamespace {}
export class RelayRuntimeChannelFanout extends RetainedFactNamespace {}
