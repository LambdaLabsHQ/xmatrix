import type { QueryClient } from "@tanstack/react-query";

export type WorkspaceResourceKind = "automations" | "channel_transfers" | "cross_space_reads";

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

/** Re-read the lists whose fixed polls stop while the Human socket is up. */
export function invalidateWorkspaceResources(client: QueryClient, change?: WorkspaceResourceChange): void {
  const resource = change?.resource;
  const spaceId = change?.spaceId;
  const channelId = change?.channelId;
  if (!resource || resource === "automations") {
    void client.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[0] !== "xmatrix") return false;
        if (key[3] !== "automations" && key[3] !== "page-automations") return false;
        return !spaceId || key[4] === spaceId;
      },
    });
  }
  if (!resource || resource === "channel_transfers") {
    void client.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[0] !== "channel-transfers") return false;
        if (spaceId && key[2] !== spaceId) return false;
        // A space-wide queue (empty channel slot) still includes this channel.
        if (channelId && key[3] && key[3] !== channelId) return false;
        return true;
      },
    });
  }
  if (!resource || resource === "cross_space_reads") {
    void client.invalidateQueries({
      predicate: (query) => {
        const key = query.queryKey;
        if (key[0] === "channel-pending-cross-space-reads") return !channelId || key[2] === channelId;
        if (key[0] === "cross-space-read-grant") return !spaceId || key[2] === spaceId;
        return false;
      },
    });
  }
}
