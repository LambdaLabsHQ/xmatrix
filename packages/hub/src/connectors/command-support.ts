import { plainRecord, utf8ByteLength } from "@xmatrix/protocol";
import type { AppConnectorProviderManifest } from "@xmatrix/protocol";
import { dispatchProductMessageAppend } from "../product-message-append";
import { appCommand, listAppConnections } from "../apps";
import { getChannel } from "../spaces";
import type { ConnectorCommandInput } from "./provider";

/* What every connector command needs around its own work: the Channel's
   Space connection, an execution record, and one receipt per message. */

export function record(value: unknown): Record<string, unknown> {
  return plainRecord(value) ?? {};
}

async function failure(operation: string, response: Response): Promise<Error> {
  const payload = record(await response.json().catch(() => ({})));
  const detail = typeof payload.error === "string" && payload.error.trim() ? `: ${payload.error.trim()}` : "";
  return new Error(`${operation} failed (${response.status})${detail}`);
}

export interface CommandScope {
  principal: { kind: "user"; id: string };
  spaceId: string;
  connectionId: string;
}

async function channelSpace(manifest: AppConnectorProviderManifest, env: ConnectorCommandInput["env"],
  channelId: string, principal: { kind: "user"; id: string }): Promise<string> {
  const { channel } = await getChannel(env, { channelId, principal });
  const spaceId = record(channel).spaceId;
  if (typeof spaceId !== "string" || !spaceId) throw new Error(`${manifest.name} connector Channel has no Space`);
  return spaceId;
}

/** The Channel's Space and configured connection, or why the command is blocked. */
export async function commandScope(manifest: AppConnectorProviderManifest, input: ConnectorCommandInput):
  Promise<CommandScope | string> {
  const principal = { kind: "user" as const, id: input.actorUserId };
  const spaceId = await channelSpace(manifest, input.env, input.channelId, principal);
  const listed = await listAppConnections(input.env, { spaceId, channelId: input.channelId, actorUserId: input.actorUserId });
  const connection = listed.map(record).find((candidate) => candidate.providerId === manifest.id);
  if (!connection || connection.status !== "configured" || typeof connection.id !== "string") {
    return `connect ${manifest.name} to this Space first`;
  }
  return { principal, spaceId, connectionId: connection.id };
}

/** App authority fields are bounded in UTF-8 bytes, not JavaScript characters. */
function executionExcerpt(value: string, maximum: number): string {
  let excerpt = "", bytes = 0;
  for (const character of value.trim()) {
    const size = utf8ByteLength(character);
    if (bytes + size > maximum) break;
    excerpt += character;
    bytes += size;
  }
  return excerpt.trimEnd();
}

/** Records one execution, runs it, and finalizes it with what happened. */
export async function withExecution(
  manifest: AppConnectorProviderManifest,
  input: ConnectorCommandInput,
  scope: CommandScope,
  action: { id: string; label: string; key: string },
  run: () => Promise<{ status: "completed" | "failed" | "blocked"; summary: string }>,
): Promise<string> {
  const executionId = `app-execution:${input.messageId}${action.key}:${manifest.id}:${action.id}`.slice(0, 240);
  await appCommand(input.env, "record-execution", {
    commandId: `product:${manifest.id}-record:${input.messageId}${action.key}`.slice(0, 200),
    executionId, connectionId: scope.connectionId, channelId: input.channelId, messageId: input.messageId,
    actionId: action.id, actionLabel: action.label.slice(0, 120), requestedByLabel: input.actorUserId,
    principal: scope.principal,
  });
  const outcome = await run();
  await appCommand(input.env, "finalize-execution", {
    commandId: `product:${manifest.id}-finalize:${input.messageId}${action.key}`.slice(0, 200),
    executionId, expectedVersion: 1, status: outcome.status,
    ...(outcome.status === "completed"
      ? { resultSummary: executionExcerpt(outcome.summary, 1_000), resultChannelId: input.channelId }
      : { reason: executionExcerpt(outcome.summary, 500) }),
    principal: scope.principal,
  });
  return `${manifest.name} ${action.id}: ${outcome.status}; ${outcome.summary}.`;
}

/* The receipt reports what the Hub already did, so it is a system fact:
   context for every Instance, never a turn. An Agent's tool call has its
   answer in the tool result; delivering the receipt as work made the caller's
   own receipt cancel the turn that was waiting on it. */
export async function publishCommandStatus(manifest: AppConnectorProviderManifest, input: ConnectorCommandInput,
  lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  const response = await dispatchProductMessageAppend(input.env, input.channelId, {
    commandId: `product:${manifest.id}-status:${input.messageId}`.slice(0, 200),
    messageId: `system:${input.messageId}:${manifest.id}`.slice(0, 200),
    channelId: input.channelId,
    body: `App connector command status:\n${lines.map((line) => `- ${line}`).join("\n")}`,
    principal: { kind: "user", id: input.actorUserId },
    appAuthorId: manifest.id,
    residual: { appMetadata: { xmatrixProvenance: "system_fact" } },
  });
  if (!response.ok) throw await failure(`${manifest.name} connector status`, response);
}
