import { AGENT_PRESETS, sha256HexSync } from "@xmatrix/protocol";

/**
 * The harness registry (`agent-presets.json`) as this Hub release carries it, for a daemon that
 * reads its registry from the Hub instead of the copy compiled into its CLI: launcher names,
 * install, update and login recipes, minimum versions. A harness added or a recipe changed in
 * the registry then reaches every capable Machine with a Hub deploy.
 */
export const HUB_HARNESS_REGISTRY_CAPABILITY = "hub_harness_registry_v1";

const REGISTRY_TEXT = JSON.stringify(AGENT_PRESETS);
const REGISTRY_SHA256 = sha256HexSync(REGISTRY_TEXT);

/** The registry for the connected frame, or nothing when the daemon cannot read it or already holds
 * these exact bytes (it reports the digest of what it holds). */
export function harnessRegistryForConnect(message: { capabilities?: readonly string[]; harnessRegistrySha256?: unknown }):
  { harnessRegistry: string } | Record<string, never> {
  if (!message.capabilities?.includes(HUB_HARNESS_REGISTRY_CAPABILITY)) return {};
  if (message.harnessRegistrySha256 === REGISTRY_SHA256) return {};
  return { harnessRegistry: REGISTRY_TEXT };
}
