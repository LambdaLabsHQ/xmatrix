/** Normalize observation terminology at persistence boundaries. Identity and
 * execution fields pass through unchanged; legacy values never select a Machine. */
export function hostnameMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result = { ...metadata };
  if (result.hostname === undefined) {
    const observation = typeof result.hostName === "string" && result.hostName
      ? result.hostName : result.hostId;
    if (typeof observation === "string") result.hostname = observation;
  }
  delete result.hostId;
  delete result.hostName;
  return result;
}
