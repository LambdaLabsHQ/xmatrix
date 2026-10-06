import { utf8ByteLength } from "@xmatrix/protocol";
import type { AuthUser } from "./auth";

/** Translate only a verified HTTP principal; request JSON never supplies proof. */
export function messageReceiptSelection(channelId: string, body: unknown, user: AuthUser) {
  const invalid = { ok: false as const, status: 400 as const, error: "Invalid message receipt selection" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid;
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "messageId" && key !== "expectedBodyHash") ||
      typeof value.messageId !== "string" || !value.messageId.trim() ||
      utf8ByteLength(value.messageId) > 160 ||
      (value.expectedBodyHash !== undefined && (typeof value.expectedBodyHash !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.expectedBodyHash)))) return invalid;
  const run = user.agentRun;
  // Not limited to the Run's birth Channel: an Agent may send to any Channel it
  // can write, and a send that timed out there must be recoverable there too.
  // The authority still requires this exact active Run, read access to the
  // Channel, and a receipt whose sender is this Instance.
  if (run && (!run.instanceId || run.runKind !== "channel-instance")) {
    return { ok: false as const, status: 403 as const,
      error: "An Agent can read receipts only for its own Instance" };
  }
  return { ok: true as const, input: { channelId, messageId: value.messageId,
    principal: run ? { kind: "agent" as const, id: run.agentId } : { kind: "user" as const, id: user.id },
    ...(run ? { runProof: { runId: run.runId, instanceId: run.instanceId!, executionKey: run.executionKey } } : {}),
    ...(typeof value.expectedBodyHash === "string" ? { expectedBodyHash: value.expectedBodyHash } : {}) } };
}
