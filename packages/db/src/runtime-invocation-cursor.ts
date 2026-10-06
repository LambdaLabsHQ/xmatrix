/** A pagination position is never an access grant; every page rechecks Channel access. */
export type InvocationLaunchPosition = [string, string];
export type InvocationRejectionPosition = [string, string, number];
export interface InvocationPagePosition {
  launch: InvocationLaunchPosition | null | undefined;
  rejection: InvocationRejectionPosition | null | undefined;
  continuation?: InvocationLaunchPosition | null;
  execution?: InvocationLaunchPosition | null;
  target?: InvocationLaunchPosition | null;
}
export function decodeInvocationPageCursor(value: unknown, scope: string): InvocationPagePosition {
  if (value === undefined || value === null) return { launch: undefined, rejection: undefined };
  if (typeof value !== "string" || value.length > 2_000) throw new Error("Invalid invocation cursor");
  const parsed = JSON.parse(value) as Record<string, unknown>;
  const position = (value: unknown, size: 2 | 3): boolean => value === null ||
    Array.isArray(value) && value.length === size && typeof value[0] === "string" &&
    value[0].length <= 100 && Number.isFinite(Date.parse(value[0])) &&
    typeof value[1] === "string" && value[1].length > 0 && value[1].length <= 300 &&
    (size === 2 || Number.isSafeInteger(value[2]) && Number(value[2]) >= 1 && Number(value[2]) <= 50);
  if (!parsed || parsed.version !== 1 || parsed.scope !== scope ||
      !position(parsed.launch, 2) || !position(parsed.rejection, 3) ||
      (parsed.continuation !== undefined && !position(parsed.continuation, 2)) ||
      (parsed.execution !== undefined && !position(parsed.execution, 2)) ||
      (parsed.target !== undefined && !position(parsed.target, 2)) ||
      parsed.launch === null && parsed.rejection === null && !parsed.continuation && !parsed.execution && !parsed.target) throw new Error("Invalid invocation cursor");
  return { launch: parsed.launch as InvocationLaunchPosition | null,
    rejection: parsed.rejection as InvocationRejectionPosition | null,
    continuation: parsed.continuation === undefined ? null : parsed.continuation as InvocationLaunchPosition | null,
    execution: parsed.execution === undefined ? null : parsed.execution as InvocationLaunchPosition | null,
    target: parsed.target === undefined ? null : parsed.target as InvocationLaunchPosition | null };
}
export function encodeInvocationPageCursor(position: InvocationPagePosition, scope: string): string | null {
  if (!position.launch && !position.rejection && !position.continuation && !position.execution && !position.target) return null;
  return JSON.stringify({ version: 1, scope, launch: position.launch ?? null, rejection: position.rejection ?? null,
    continuation: position.continuation ?? null, execution: position.execution ?? null, target: position.target ?? null });
}
