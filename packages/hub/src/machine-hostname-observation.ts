/** Bounded mutable observations. None of these fields establishes Machine scope. */
export function machineHostnameObservation(input: {
  hostname?: unknown; hostId?: unknown; hostName?: unknown;
}): { hostname?: string; hostId: string; hostName?: string } {
  const observation = (value: unknown, field: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !value.trim() || value.trim().length > 160 ||
        Array.from(value).some(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
      throw new Error(`${field} must be a bounded observation`);
    }
    return value.trim();
  };
  const hostname = observation(input.hostname, "hostname");
  const legacyHostId = observation(input.hostId, "hostId");
  const legacyHostName = input.hostName === null || input.hostName === ""
    ? undefined : observation(input.hostName, "hostName");
  const current = hostname ?? legacyHostName ?? legacyHostId;
  return { hostname: current, hostId: current ?? "", hostName: current };
}
