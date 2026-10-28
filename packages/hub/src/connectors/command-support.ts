import { connectorReceiptBody, plainRecord, utf8ByteLength } from "@xmatrix/protocol";
import type { AppConnectorProviderManifest, AppConnectorRemedy, ConnectorResultVisibility } from "@xmatrix/protocol";
import { dispatchProductMessageAppend } from "../product-message-append";
import { appCommand, CONNECTED_APPS_NEED_MEMBER, usableAppConnections } from "../apps";
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
  const listed = await usableAppConnections(input.env, { spaceId, channelId: input.channelId, actorUserId: input.actorUserId });
  if (!listed) return CONNECTED_APPS_NEED_MEMBER;
  const connection = listed.map(record).find((candidate) => candidate.providerId === manifest.id);
  if (!connection || connection.status !== "configured" || typeof connection.id !== "string") {
    if (connection?.status === "disconnected") return `${manifest.name} is disconnected in this Space; reconnect it in Apps → ${manifest.name}`;
    if (connection?.status === "error") return `${manifest.name} needs attention in this Space; check it in Apps → ${manifest.name}`;
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

/** How a command ended; a fixable failure names its fix. */
export interface CommandOutcome {
  status: "completed" | "failed" | "blocked";
  summary: string;
  remedy?: AppConnectorRemedy;
}

/** A remedy as its execution stores it: `reconnect` or `credential:<field>`. */
function remedyCode(remedy: AppConnectorRemedy): string {
  return remedy.kind === "reconnect" ? "reconnect" : `credential:${remedy.field}`;
}

/** The Channel's receipt for one command: the action, its outcome and what it returned. */
export function commandResult(name: string, actionId: string, outcome: CommandOutcome): string {
  return `${name} ${actionId}: ${outcome.status}; ${outcome.summary}${/[.!?。`]$/u.test(outcome.summary.trimEnd()) ? "" : "."}`;
}

/** Records one execution, runs it, and finalizes it with its receipt. A read
 * keeps its command and result visibility so the person can run it again. */
export async function withExecution(
  manifest: AppConnectorProviderManifest,
  input: ConnectorCommandInput,
  scope: CommandScope,
  action: { id: string; label: string; key: string; retry?: ConnectorResultVisibility },
  run: () => Promise<CommandOutcome>,
): Promise<string> {
  const retryCommand = action.retry && input.body.trim() && utf8ByteLength(input.body.trim()) <= 4_000 ? input.body.trim() : undefined;
  const executionId = `app-execution:${input.messageId}${action.key}:${manifest.id}:${action.id}`.slice(0, 240);
  await appCommand(input.env, "record-execution", {
    commandId: `product:${manifest.id}-record:${input.messageId}${action.key}`.slice(0, 200),
    executionId, connectionId: scope.connectionId, channelId: input.channelId, messageId: input.messageId,
    actionId: action.id, actionLabel: action.label.slice(0, 120), requestedByLabel: input.actorUserId,
    ...(retryCommand ? { retryCommand, resultVisibility: action.retry } : {}),
    principal: scope.principal,
  });
  const outcome = await run();
  await appCommand(input.env, "finalize-execution", {
    commandId: `product:${manifest.id}-finalize:${input.messageId}${action.key}`.slice(0, 200),
    executionId, expectedVersion: 1, status: outcome.status,
    ...(outcome.status === "completed"
      ? { resultSummary: executionExcerpt(outcome.summary, 1_000), resultChannelId: input.channelId }
      : { reason: executionExcerpt(outcome.summary, 500), ...(outcome.remedy ? { remedy: remedyCode(outcome.remedy) } : {}) }),
    principal: scope.principal,
  });
  return commandResult(manifest.name, action.id, outcome);
}

/* Receipts resume the exact calling Instance after its current turn. The
   trusted caller identity survives approvals and durable execution; provider
   text and mutable names never decide who receives the result as work. */
export async function publishCommandStatus(manifest: AppConnectorProviderManifest, input: ConnectorCommandInput,
  lines: readonly string[], options: { resumeRequester?: boolean; privateResultOwnerUserId?: string } = {}): Promise<void> {
  if (lines.length === 0) return;
  const response = await dispatchProductMessageAppend(input.env, input.channelId, {
    commandId: `product:${manifest.id}-status:${input.messageId}`.slice(0, 200),
    messageId: `system:${input.messageId}:${manifest.id}`.slice(0, 200),
    channelId: input.channelId,
    body: connectorReceiptBody(lines),
    // Paid X work is already charged before I/O. Its receipt must remain
    // publishable when that call used the final credit or was refused.
    ...(manifest.id === "x" ? { messageKind: "xmatrix.system.x_receipt" } : {}),
    principal: { kind: "user", id: input.actorUserId },
    appAuthorId: manifest.id,
    residual: { appMetadata: { xmatrixProvenance: "system_fact",
      ...(options.privateResultOwnerUserId ? { xmatrixPrivateConnectorResultOwner: options.privateResultOwnerUserId } : {}),
      ...(options.resumeRequester !== false && input.senderKind === "agent" && input.senderId && input.commandMessageId !== null
        ? { xmatrixConnectorRequesterInstanceId: input.senderId } : {}) },
      ...(input.commandMessageId === null ? {} : { replyToMessageId: input.commandMessageId ?? input.messageId }) },
  });
  if (!response.ok) throw await failure(`${manifest.name} connector status`, response);
}
