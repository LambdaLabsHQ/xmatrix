import { plainRecord } from "@xmatrix/protocol";

/** Metadata key on a message xMatrix itself writes for one exact Instance, such as a settings card's answer. */
export const REQUESTER_INSTANCE_KEY = "xmatrixRequesterInstanceId";

const instanceTarget = (target: unknown) =>
  typeof target === "string" && target.trim() === target && target.length > 0 && target.length <= 300
    ? { instanceId: target } : false;

/** Trusted App authors carry receipts to their caller; native events reach the
 * Channel's existing Instances. xMatrix's own answer to an Instance's card
 * wakes that Instance alone. Provider text never becomes routing syntax, and
 * only the Hub writes `xmatrix*` keys, so callers cannot aim a wake. */
export function connectorMessageWakeTarget(message: { from: { kind?: unknown }; metadata?: unknown }):
  false | { instanceId?: string } {
  const metadata = plainRecord(message.metadata);
  if (message.from.kind === "system") {
    return metadata?.xmatrixProvenance === "system_fact" ? instanceTarget(metadata[REQUESTER_INSTANCE_KEY]) : false;
  }
  if (message.from.kind !== "app") return false;
  const target = metadata?.xmatrixConnectorRequesterInstanceId;
  if (target !== undefined) return instanceTarget(target);
  return metadata?.xmatrixProvenance === "system_fact" ? false : {};
}
