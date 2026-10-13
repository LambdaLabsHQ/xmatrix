import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { WORKSPACE_RESOURCE_KINDS, type WorkspaceResourceKind } from "@xmatrix/protocol";

export interface WorkspaceResourceChange {
  spaceId?: string;
  resource?: WorkspaceResourceKind;
  channelId?: string;
}

let connected = false;

/**
 * Records the socket. Unchanged values do nothing, so effect cleanup does not
 * refetch when the flag was already false.
 */
export function setHumanPushConnected(next: boolean): void {
  if (connected === next) return;
  connected = next;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("xmatrix:human-push", { detail: { connected: next } }));
}

/**
 * Poll only while the Human socket is down and the tab is visible. A connected
 * socket is woken by `workspace_resource_changed` instead.
 */
export function refetchUnlessHumanPush(intervalMs: number): number | false {
  if (typeof document === "undefined" || document.hidden) return false;
  if (connected) return false;
  return intervalMs;
}

/**
 * Which cached queries hold each announced list, within the Space and Channel
 * a change names. A list the Hub announces has its row here, so its query
 * reads `refetchUnlessHumanPush` instead of a fixed timer.
 */
const HOLDS_RESOURCE: Record<WorkspaceResourceKind, (key: QueryKey, change: WorkspaceResourceChange) => boolean> = {
  automations: (key, { spaceId }) => key[0] === "xmatrix" &&
    (key[3] === "automations" || key[3] === "page-automations") && (!spaceId || key[4] === spaceId),
  // A space-wide queue (empty channel slot) still includes this channel.
  channel_transfers: (key, { spaceId, channelId }) => key[0] === "channel-transfers" &&
    (!spaceId || key[2] === spaceId) && (!channelId || !key[3] || key[3] === channelId),
  cross_space_reads: (key, { spaceId, channelId }) =>
    key[0] === "channel-pending-cross-space-reads" ? !channelId || key[2] === channelId
      : key[0] === "cross-space-read-grant" && (!spaceId || key[2] === spaceId),
  connector_action_requests: (key, { channelId }) => key[0] === "connector-action-approvals" &&
    (!channelId || key[2] === channelId),
};

/** Re-read the lists whose fixed polls stop while the Human socket is up: the named one, or all of them. */
export function invalidateWorkspaceResources(client: QueryClient, change: WorkspaceResourceChange = {}): void {
  const kinds: readonly WorkspaceResourceKind[] = change.resource ? [change.resource] : WORKSPACE_RESOURCE_KINDS;
  void client.invalidateQueries({
    predicate: (query) => kinds.some((kind) => HOLDS_RESOURCE[kind](query.queryKey, change)),
  });
}
