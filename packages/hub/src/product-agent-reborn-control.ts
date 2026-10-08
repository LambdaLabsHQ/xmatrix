import { ControlError } from "@xmatrix/db";
import { hasControlCharacter, parseNaturalRunId } from "@xmatrix/protocol";
import type { ProductAgentMentionPort } from "./product-agent-mention";

export class AgentRebornControlError extends ControlError {
  constructor(code: string, status: 400 | 403 | 404 | 409 | 503, message: string) {
    super(code, status, message, status === 503);
  }
}

export function parseAgentRebornControlBody(body: unknown): { requestId: string; expectedRunId: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AgentRebornControlError(
    "invalid_request", 400, "An exact Run and request id are required");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["requestId", "expectedRunId"].includes(key)) ||
      typeof value.requestId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.requestId) ||
      typeof value.expectedRunId !== "string" ||
      (!value.expectedRunId.startsWith("run:") && !parseNaturalRunId(value.expectedRunId)) ||
      value.expectedRunId.length > 200 || /\s/u.test(value.expectedRunId) || hasControlCharacter(value.expectedRunId)) {
    throw new AgentRebornControlError("invalid_request", 400, "Invalid reborn request");
  }
  return { requestId: value.requestId, expectedRunId: value.expectedRunId };
}

/** Human-owned Instance control: the Instance was read as its owner (`get-instance`
 * answers only the Run's owner), and the durable registration reborn owns every mutation. */
export async function requestOwnedInstanceReborn(input: {
  actorUserId: string; channelId: string; instanceId: string; requestId: string; expectedRunId: string; sourceMessageId: string;
  instance: Record<string, unknown>; port: ProductAgentMentionPort;
}): Promise<{ requestId: string; instanceId: string; state: "queued" }> {
  const instance = input.instance;
  if (instance.channelId !== input.channelId || instance.instanceId !== input.instanceId ||
      instance.runId !== input.expectedRunId) throw new AgentRebornControlError(
    "reborn_source_changed", 409, "The Instance no longer belongs to the expected Run");
  try {
    await input.port.prepareRegisteredReborn({ channelId: input.channelId, sourceInstanceId: input.instanceId,
      sourceMessageId: input.sourceMessageId, sourceMention: "", prompt: "" });
  } catch (error) {
    const code = error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code : "reborn_not_queued";
    throw new AgentRebornControlError(code, 409, "Instance recovery was not queued");
  }
  return { requestId: input.requestId, instanceId: input.instanceId, state: "queued" };
}
