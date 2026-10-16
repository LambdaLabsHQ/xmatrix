import { agentRegistrationOf } from "./agent-caller";
import { teamsActionCapability } from "./teams-native";
import { dingtalkActionCapability } from "./dingtalk-native";
import { telegramActionCapability } from "./telegram-native";
import { wecomActionCapability } from "./wecom-native";
import { connectorActionPolicy, sha256Hex, type ConnectorActionPolicy, type AppConnectorProviderManifest } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "../app-connectors";
import { parseActionCommand, parsePolicyCommand } from "./action-parse";
import { connectorActionCatalog } from "./action-catalog";
import { commandResult, commandScope, publishCommandStatus, withExecution } from "./command-support";
import { connectionCredentials } from "./connection-credentials";
import { discordActionCapability } from "./discord-native";
import { feishuActionCapability } from "./feishu-native";
import { googleChatActionCapability } from "./googlechat-native";
import { connectorActionPolicyRepository, connectorActionRequestRepository, connectorCredentialRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import { notifyWorkspaceResource } from "../workspace-resource-notification";
import type { Env } from "../types";
import type { ConnectorAction, ConnectorActionContext, ConnectorCommandHandler, ConnectorCommandInput, ConnectorSubscriptionSync } from "./provider";
import { runSubscriptionStatement } from "./subscription-command";
import { xActionCapability } from "./x-api";
import { upstreamMeter } from "../usage-cost-metering";
import { createXMediaCapability } from "./x-media";
import { postgresMessageAttachmentAuthorityRequest } from "../postgres-message-attachment-authority";
import { connectorSubscriptionStatements, isConnectorSubscriptionCommand } from "./subscription-parse";
import { enqueueXUpload } from "./x-upload-executor-do";
import { X_ACTIONS } from "./actions/x";
import type { XExecutingUpload, XUploadOutcome } from "@xmatrix/db";

/*
 * A provider's Channel commands (docs/design/connector-platform.md §3.3, §3.5):
 * subscriptions for event providers, one outbound action per message, and the
 * per-Channel action policy for Space admins. Policy is read at execution
 * time: allow executes, ask stages an immutable request for a Human admin,
 * and disallow refuses. Gmail send/reply default to ask.
 */

/** Effective policy is read from the owning uncached authority on every execution. */
export async function channelActionPolicy(env: Env, input: { connectionId: string; channelId: string;
  actionId: string; defaultPolicy?: ConnectorActionPolicy }): Promise<ConnectorActionPolicy> {
  return await connectorActionPolicyRepository(env).mode({ requestId: crypto.randomUUID(),
    connectionId: input.connectionId, channelId: input.channelId, actionId: input.actionId }) ?? input.defaultPolicy ?? "allow";
}

/** Legacy callers that cannot ask must refuse ask as well as disallow. */
export function actionRefusal(input: { actionId: string; mode: ConnectorActionPolicy | "deny" | null;
  defaultPolicy?: ConnectorActionPolicy }): string | undefined {
  const mode = input.mode === null ? input.defaultPolicy ?? "allow" : connectorActionPolicy(input.mode) ?? "disallow";
  return mode === "disallow" ? `${input.actionId} is denied in this channel`
    : mode === "ask" ? `${input.actionId} needs approval of this request by a Space admin` : undefined;
}

export async function channelActionRefusal(env: Env, input: { connectionId: string; channelId: string;
  actionId: string; defaultPolicy?: ConnectorActionPolicy }): Promise<string | undefined> {
  return actionRefusal({ actionId: input.actionId, mode: await channelActionPolicy(env, input) });
}

/** Whether a Channel policy can name this action: one that acts on the provider. */
export function isPolicyAction(manifest: AppConnectorProviderManifest, actionId: string): boolean {
  return manifest.actions.some((action) => action.id === actionId && action.effect);
}

export function connectorCommands(providerId: string,
  actions: Readonly<Record<string, ConnectorAction>> = {}, subscriptions?: ConnectorSubscriptionSync): ConnectorCommandHandler {
  const catalog = connectorActionCatalog(providerId, actions);
  const accepts = (body: string) => {
    if (isConnectorSubscriptionCommand(providerId, body)) return true;
    const parsed = parseActionCommand(providerId, body);
    return Boolean(parsed && (parsed.actionId === "policy" || catalog.has(parsed.actionId)));
  };
  return {
    accepts,
    run: async (input) => {
      const manifest = getAppConnectorProvider(providerId);
      if (!manifest) return;
      const lines: string[] = [];
      if (manifest.events && isConnectorSubscriptionCommand(providerId, input.body)) {
        for (const [index, statement] of connectorSubscriptionStatements(manifest, input.body).entries()) {
          lines.push(await runSubscriptionStatement(manifest, input, statement, index === 0 ? "" : `:s${index}`, subscriptions));
        }
      } else {
        const parsed = parseActionCommand(providerId, input.body);
        const action = parsed ? catalog.get(parsed.actionId)?.executor : undefined;
        if (parsed?.actionId === "policy") lines.push(await runPolicy(providerId, input, parsed.statement, actions));
        else if (parsed && action) {
          lines.push(await runAction(providerId, input, parsed.actionId, action, parsed.statement));
        }
      }
      await publishCommandStatus(manifest, input, lines);
    },
  };
}

export async function runPolicy(providerId: string, input: ConnectorCommandInput,
  statement: Parameters<typeof parsePolicyCommand>[0], actions: Readonly<Record<string, ConnectorAction>> = {}): Promise<string> {
  const manifest = getAppConnectorProvider(providerId)!;
  if (input.senderKind !== "user") return `${manifest.name} policy: blocked; only a Space admin sets action policy.`;
  const parsed = parsePolicyCommand(statement);
  if ("error" in parsed) return `${manifest.name} policy: failed; ${parsed.error}.`;
  if (!isPolicyAction(manifest, parsed.actionId)) {
    return `${manifest.name} policy: failed; ${parsed.actionId} is not a ${manifest.name} action.`;
  }
  if (parsed.mode === "ask" && !connectorActionCatalog(providerId, actions).get(parsed.actionId)?.executor) {
    return `${manifest.name} policy: failed; this action does not support per-request approval.`;
  }
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") return `${manifest.name} policy: blocked; ${scope}.`;
  try {
    await connectorActionPolicyRepository(input.env).set({ requestId: crypto.randomUUID(), spaceId: scope.spaceId,
      providerId, channelId: input.channelId, actionId: parsed.actionId, mode: parsed.mode,
      actorUserId: input.actorUserId, at: new Date().toISOString() });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 404) return `${manifest.name} policy: blocked; only a Space owner or admin sets action policy.`;
    throw error;
  }
  return `${manifest.name} policy: completed; ${parsed.actionId} is ${parsed.mode ?? "default"} in this channel.`;
}

/** Runs one action a Human admin approved and posts its receipt in the Channel. */
export async function runConnectorAction(providerId: string, input: ConnectorCommandInput, actionId: string,
  action: ConnectorAction, statement: Parameters<ConnectorAction["parse"]>[0],
  approved?: { requestId: string; prepared: Record<string, string> }): Promise<string> {
  const manifest = getAppConnectorProvider(providerId);
  if (!manifest) return `${providerId} ${actionId}: failed; unknown connector.`;
  const receipt = await runAction(providerId, input, actionId, action, statement, approved);
  await publishCommandStatus(manifest, input, [receipt]);
  return receipt;
}

/** Only the durable executor dispatches a consumed X video request. */
export async function executeDurableXUpload(env: Env, job: XExecutingUpload): Promise<{
  status: "completed" | "failed" | "blocked"; receipt: string;
}> {
  const { request, payload } = job;
  const receipt = await runAction("x", { env, channelId: request.channelId,
    actorUserId: request.requestedBy, messageId: `${payload.messageId}:upload-result`,
    commandMessageId: payload.messageId, body: "", senderKind: payload.senderKind, senderId: payload.senderId },
  "upload_video", X_ACTIONS.upload_video!, payload.statement,
  { requestId: request.requestId, prepared: payload.prepared });
  return { status: /: completed;/u.test(receipt) ? "completed" : /: blocked;/u.test(receipt) ? "blocked" : "failed", receipt };
}

/** The persisted outcome is retried with one canonical append identity. */
export async function publishDurableXUploadReceipt(env: Env, outcome: XUploadOutcome): Promise<void> {
  const { request, payload } = outcome;
  await publishCommandStatus(getAppConnectorProvider("x")!, { env, channelId: request.channelId,
    actorUserId: request.requestedBy, messageId: `${payload.messageId}:upload-result`,
    commandMessageId: payload.messageId, body: "", senderKind: payload.senderKind, senderId: payload.senderId },
  [outcome.receipt]);
}

async function runAction(providerId: string, input: ConnectorCommandInput, actionId: string,
  action: ConnectorAction, statement: Parameters<ConnectorAction["parse"]>[0],
  approved?: { requestId: string; prepared: Record<string, string> }): Promise<string> {
  const manifest = getAppConnectorProvider(providerId)!;
  const result = (status: "completed" | "failed" | "blocked", summary: string) =>
    commandResult(manifest.name, actionId, { status, summary });
  const entry = manifest.actions.find((candidate) => candidate.id === actionId);
  const label = entry?.label ?? actionId;
  const defaultPolicy = entry?.defaultPolicy;
  const parsed = approved?.prepared ?? action.parse(statement);
  if (typeof parsed === "string") return result("failed", parsed);
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") return result("blocked", scope);
  const policyInput = { connectionId: scope.connectionId, channelId: input.channelId, actionId, defaultPolicy };
  const mode = await channelActionPolicy(input.env, policyInput);
  const requestId = `action-request:${await sha256Hex(JSON.stringify([scope.connectionId, input.channelId, input.messageId, actionId]))}`;
  const durableUpload = providerId === "x" && actionId === "upload_video";
  if (!approved && action.effect === "write") {
    const staged = await connectorActionRequestRepository(input.env).find(requestId, scope.connectionId, input.channelId, input.actorUserId);
    if (staged) {
      if (durableUpload && staged.status === "executing") {
        await enqueueXUpload(input.env, { requestId, spaceId: scope.spaceId, channelId: input.channelId });
        return `${manifest.name} ${actionId}: queued; request ${requestId}; its result will reply in this Channel.`;
      }
      return approvalReceipt(manifest.name, actionId, staged);
    }
  }
  const authorizeWrite = async () => {
    const liveScope = await commandScope(manifest, input);
    if (typeof liveScope === "string" || liveScope.spaceId !== scope.spaceId || liveScope.connectionId !== scope.connectionId) {
      throw new ProviderRequestError(409, `${manifest.name} Channel access changed before posting`);
    }
    if (approved) await connectorActionRequestRepository(input.env).authorize(approved.requestId, scope.connectionId, input.channelId);
    const changed = await channelActionPolicy(input.env, policyInput);
    if (changed === "disallow" || (changed === "ask" && !approved)) {
      throw new ProviderRequestError(403, actionRefusal({ actionId, mode: changed })!);
    }
  };
  if (!approved && (mode === "ask" || (durableUpload && mode === "allow"))) {
    try {
      const context = await actionContext(providerId, input, scope.spaceId, actionId, action, authorizeWrite);
      if (typeof context === "string") return result("blocked", context);
      const prepared = action.prepare ? await action.prepare(context, parsed) : parsed;
      const preview = providerId === "gmail"
        ? Object.fromEntries(["from", "to", "subject", "body"].map(key => [key, prepared[key] ?? ""]))
        : providerId === "x" && actionId === "accounts" ? { account: "Connected X accounts owned by the requesting member", text: "List handles and account IDs" }
        : providerId === "x" ? { account: `@${prepared.accountUsername} (X account ${prepared.accountId})`,
          text: prepared.text ?? "", ...(prepared.postId ? { quotedPost: prepared.postId } : {}),
          ...(prepared.mediaReceipt ? { video: "Video from this account and Channel's approved upload receipt" } : {}),
          ...(prepared.sourceName ? { filename: prepared.sourceName, bytes: prepared.sourceSize!,
            sha256: prepared.sourceHash!, attachment: `${prepared.messageId}/${prepared.attachmentId}` } : {}) }
        : { target: statement.target, text: statement.text };
      const request = await connectorActionRequestRepository(input.env).create({ requestId,
        connectionId: scope.connectionId, channelId: input.channelId, providerId, actionId, requestedBy: input.actorUserId,
        payload: { messageId: input.messageId, senderKind: input.senderKind ?? "user", senderId: input.senderId,
          statement, prepared, preview } });
      if (durableUpload && mode === "allow") {
        const ref = { requestId, spaceId: scope.spaceId, channelId: input.channelId };
        await connectorActionRequestRepository(input.env).startAllowed({ ...ref, actorUserId: input.actorUserId });
        await enqueueXUpload(input.env, ref);
        return `${manifest.name} ${actionId}: queued; request ${requestId}; its result will reply in this Channel.`;
      }
      await announceActionRequests(input.env, scope.spaceId, input.channelId);
      return approvalReceipt(manifest.name, actionId, request);
    } catch (error) {
      return result("failed", error instanceof ProviderRequestError ? error.message : "could not create an approval request");
    }
  }
  return withExecution(manifest, input, scope, { id: actionId, label, key: "" }, async () => {
    if (mode === "disallow") return { status: "blocked", summary: actionRefusal({ actionId, mode })! };
    try {
      const context = await actionContext(providerId, input, scope.spaceId, actionId, action, authorizeWrite);
      if (typeof context === "string") return { status: "blocked", summary: context };
      await authorizeWrite();
      const result = await action.execute(context, parsed);
      return { status: "completed", summary: result.url ? `${result.summary} — ${result.url}` : result.summary };
    } catch (error) {
      if (error instanceof ProviderRequestError) return { status: "failed", summary: error.message };
      return { status: "failed", summary: error instanceof DOMException && error.name === "TimeoutError"
        ? "the provider did not answer in time" : "the provider call failed" };
    }
  });
}

/** A Channel's pending requests changed: its admins' open Channels read the list again instead of polling it. */
export function announceActionRequests(env: Env, spaceId: string, channelId: string): Promise<void> {
  return notifyWorkspaceResource(env, { spaceId, resource: "connector_action_requests", channelId });
}

function approvalReceipt(name: string, actionId: string, request: { requestId: string; status: string }): string {
  return `${name} ${actionId}: ${request.status === "pending" ? "awaiting approval" : request.status}; ` +
    `request ${request.requestId}; a Space admin answers pending requests in this channel's Pending approvals. ` +
    "Approval covers this request only; repeating this command never sends it again.";
}

async function actionContext(providerId: string, input: ConnectorCommandInput, spaceId: string,
  actionId: string, action: ConnectorAction, authorizeWrite: () => Promise<void>): Promise<ConnectorActionContext | string> {
  const googleChat = providerId === "googlechat" && actionId === "post"
    ? await googleChatActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const discord = providerId === "discord" && actionId === "post"
    ? await discordActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const feishu = providerId === "feishu" && actionId === "send"
    ? await feishuActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const telegram = providerId === "telegram" && actionId === "send"
    ? await telegramActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const wecom = providerId === "wecom" && actionId === "send"
    ? await wecomActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const teams = providerId === "teams" && actionId === "post"
    ? await teamsActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const dingtalk = providerId === "dingtalk" && ["read", "send"].includes(actionId)
    ? await dingtalkActionCapability(input.env, spaceId, authorizeWrite) : undefined;
  const x = providerId === "x" ? xActionCapability(input.env, { spaceId, channelId: input.channelId,
    actorUserId: input.actorUserId, action: actionId, authorizeWrite }) : undefined;
  const xMedia = x && input.env.RELAY_PAYLOAD_BUCKET ? createXMediaCapability({ spaceId, channelId: input.channelId,
    actorUserId: input.actorUserId, x, authorizeWrite, bucket: input.env.RELAY_PAYLOAD_BUCKET,
    receiptSecret: input.env.RELAY_R2_CAPABILITY_HMAC_SECRET,
    attachmentAuthority: request => postgresMessageAttachmentAuthorityRequest(input.env, request) }) : undefined;
  const native = teams || googleChat || discord || feishu || telegram || wecom || dingtalk || x;
  const credentials = native ? {} : await connectionCredentials(input.env, spaceId, providerId);
  /* `a|b` requires either field: a pasted token or the one OAuth issued. */
  const missing = native ? [] : action.requires.filter((field) => !field.split("|").some((name) => credentials[name]));
  if (missing.length > 0) return `save ${missing.join(", ")} in Apps → ${getAppConnectorProvider(providerId)!.name} → Credentials`;
  const instanceId = input.senderKind === "agent" ? input.senderId : undefined;
  const caller = { userId: input.actorUserId,
    ...(instanceId ? { agent: () => agentRegistrationOf(input.env, { ownerUserId: input.actorUserId, instanceId }) } : {}) };
  const declared = (getAppConnectorProvider(providerId)!.credentials ?? []).map(field => field.id);
  const saveCredentials = async (fields: Readonly<Record<string, string>>) => {
    await connectorCredentialRepository(input.env).put({ requestId: crypto.randomUUID(), spaceId, providerId, actorUserId: "hub:provider-renewal",
      fields: { ...fields }, policy: { allowed: declared }, at: new Date().toISOString(), asHub: true });
  };
  const usage = upstreamMeter(input.env, { spaceId, connector: providerId, action: actionId });
  return { credentials, caller, authorizeWrite, usage, ...(native ? {} : { saveCredentials }), ...(teams ? { teams } : {}), ...(googleChat ? { googleChat } : {}),
    ...(discord ? { discord } : {}), ...(feishu ? { feishu } : {}), ...(telegram ? { telegram } : {}),
    ...(wecom ? { wecom } : {}), ...(dingtalk ? { dingtalk } : {}), ...(x ? { x } : {}), ...(xMedia ? { xMedia } : {}) };
}
