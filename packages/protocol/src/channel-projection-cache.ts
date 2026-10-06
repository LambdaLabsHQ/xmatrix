/**
 * Channel catalog restart-cache verification material (protocol types only).
 * Peeled from authority.ts by semantic domain; authority.ts re-exports these names.
 */

/**
 * Current Authority authority needed to decide whether a bounded, previously
 * verified Channel tail may be presented after a client restart. This is
 * catalog metadata only: it grants no access and carries no capability.
 */
export interface ChannelProjectionCacheAuthority {
  authorizationEpoch: number;
  entitlementDigest: string;
}

/**
 * One de-duplicated projection scope in a Channel catalog cache manifest.
 * Open Channels in the same Space intentionally reference the same scope.
 */
export interface ChannelProjectionCacheScope {
  scopeId: string;
  grantVersion: number;
  snapshotEpoch: number;
  segmentManifestRoot?: string;
  historyFloor: number;
  historyTail: number;
  purgeEpoch: number;
  redactionEpoch: number;
  changeHead: number;
  redactionHead: number;
}

/**
 * Fail-closed restart-cache verification material returned with a complete
 * authenticated Channel catalog. Missing scopes are cache misses, never zero
 * watermarks or inferred authority.
 */
export interface ChannelProjectionCacheManifest {
  protocolVersion: 1;
  authority: ChannelProjectionCacheAuthority;
  scopes: ChannelProjectionCacheScope[];
}
