import { plainRecord } from "@xmatrix/protocol";

/** Trusted App authors carry receipts to their caller; native events reach the
 * Channel's existing Instances. Provider text never becomes routing syntax. */
export function connectorMessageWakeTarget(message: { from: { kind?: unknown }; metadata?: unknown }):
  false | { instanceId?: string } {
  if (message.from.kind !== "app") return false;
  const metadata = plainRecord(message.metadata);
  const target = metadata?.xmatrixConnectorRequesterInstanceId;
  if (target !== undefined) {
    return typeof target === "string" && target.trim() === target && target.length > 0 && target.length <= 300
      ? { instanceId: target } : false;
  }
  return metadata?.xmatrixProvenance === "system_fact" ? false : {};
}
