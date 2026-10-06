/**
 * New daemons bind successful spawn results to the registry epoch that leased
 * the command. Results from older daemons omit both fields and remain valid
 * during the capability rollout.
 */
export function machineSpawnRegistryEvidenceMatches(
  body: Readonly<Record<string, unknown>>,
  connectionEpoch: number,
): boolean {
  if (body.type !== "machine_spawn_result" || body.ok !== true) return true;
  const epoch = body.registryConnectionEpoch;
  const sequence = body.registrySequence;
  if (epoch === undefined && sequence === undefined) return true;
  return Number.isSafeInteger(epoch) && Number(epoch) === connectionEpoch &&
    Number.isSafeInteger(sequence) && Number(sequence) >= 1;
}
