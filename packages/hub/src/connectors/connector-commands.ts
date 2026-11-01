import { AppControlError, SLACK_WORKSPACE_TAKEN } from "@xmatrix/db";
import { agentRegistrationOf } from "./agent-caller";
import { teamsActionCapability } from "./teams-native";
import { dingtalkActionCapability } from "./dingtalk-native";
import { telegramActionCapability } from "./telegram-native";
import { wecomActionCapability } from "./wecom-native";
import { connectorActionPolicy, PRIVATE_CONNECTOR_RESULT, sha256Hex, utf8ByteLength, type ConnectorResultVisibility,
  type ConnectorActionPolicy } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "../app-connectors";
import { parseActionCommand } from "./action-parse";
import { connectorActionCatalog } from "./action-catalog";
import { commandResult, commandScope, publishCommandStatus, withExecution } from "./command-support";
import { connectionCredentialGrant, credentialRenewal } from "./connection-credentials";
import { discordActionCapability } from "./discord-native";
import { feishuActionCapability } from "./feishu-native";
import { googleChatActionCapability } from "./googlechat-native";
import { connectorPermissionRepository, connectorActionRequestRepository } from "./credentials";
import { ConnectorRemedy, ProviderRequestError } from "./http";
import { notifyWorkspaceResource } from "../workspace-resource-notification";
import type { Env } from "../types";
import type { ConnectorAction, ConnectorActionContext, ConnectorActionResult, ConnectorCommandHandler, ConnectorCommandInput, ConnectorSubscriptionSync } from "./provider";
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
 * connection permission. Every read runs; writes follow read/ask/write.
 * The uncached mode is checked at execution and immediately before mutation.
 */

/** One connection mode, read uncached for every execution and immediately before writes. */
export async function connectionActionPolicy(env: Env, input: { connectionId: string; providerId: string; actionId: string }): Promise<ConnectorActionPolicy> {
  const manifest = getAppConnectorProvider(input.providerId);
  const action = manifest?.actions.find(action => action.id === input.actionId);
  if (!manifest || !action?.effect) return "disallow";
  if (action.effect === "read") return "allow";
  const mode = await connectorPermissionRepository(env).mode({ requestId: crypto.randomUUID(), connectionId: input.connectionId })
    ?? manifest.defaultPermission ?? "write";
  return mode === "read" ? "disallow" : mode === "ask" ? "ask" : "allow";
}

/** Legacy callers that cannot ask must refuse ask as well as disallow. */
export function actionRefusal(input: { actionId: string; mode: ConnectorActionPolicy | "deny" | null;
  }): string | undefined {
  const mode = input.mode === null ? "allow" : connectorActionPolicy(input.mode) ?? "disallow";
  return mode === "disallow" ? `${input.actionId} is denied by this app permission`
    : mode === "ask" ? `${input.actionId} needs approval of this request by a Space admin` : undefined;
}

export async function connectionActionRefusal(env: Env, input: { connectionId: string; providerId: string; actionId: string }): Promise<string | undefined> {
  return actionRefusal({ actionId: input.actionId, mode: await connectionActionPolicy(env, input) });
}

export function connectorCommands(providerId: string,
  actions: Readonly<Record<string, ConnectorAction>> = {}, subscriptions?: ConnectorSubscriptionSync): ConnectorCommandHandler {
  const catalog = connectorActionCatalog(providerId, actions);
  const accepts = (body: string) => {
    if (isConnectorSubscriptionCommand(providerId, body)) return true;
    const parsed = parseActionCommand(providerId, body);
    return Boolean(parsed && catalog.has(parsed.actionId));
  };
  return {
    accepts,
    run: async (input) => {
      const manifest = getAppConnectorProvider(providerId);
      if (!manifest) return;
      input = { ...input, fixes: [] };
      const lines: string[] = [];
      if (manifest.events && isConnectorSubscriptionCommand(providerId, input.body)) {
        for (const [index, statement] of connectorSubscriptionStatements(manifest, input.body).entries()) {
          lines.push(await runSubscriptionStatement(manifest, input, statement, index === 0 ? "" : `:s${index}`, subscriptions));
        }
      } else {
        const parsed = parseActionCommand(providerId, input.body);
        const action = parsed ? catalog.get(parsed.actionId)?.executor : undefined;
        if (parsed && action) {
          lines.push(await runAction(providerId, input, parsed.actionId, action, parsed.statement));
        }
      }
      await publishCommandStatus(manifest, input, lines);
    },
  };
}

/** The fix a failure names, when the Hub worded it. */
function remedyOf(error: unknown) {
  return error instanceof ConnectorRemedy ? error.fix : undefined;
}

/** What a private call's failure records: the Hub's own next step, or the mask
 * when the failure may carry what the provider returned. */
export function privateFailure(error: unknown): string {
  return error instanceof ConnectorRemedy ? error.message : PRIVATE_CONNECTOR_RESULT;
}

/** A synchronous read returns the original result to its caller. Recorded
 * private calls give execution history a fixed mask rather than an excerpt. */
export async function callConnectorRead(providerId: string, input: ConnectorCommandInput, actionId: string,
  action: ConnectorAction, statement: Parameters<ConnectorAction["parse"]>[0],
  authorizeCaller: () => Promise<void>, resultVisibility: ConnectorResultVisibility): Promise<ConnectorActionResult> {
  const manifest = getAppConnectorProvider(providerId);
  const entry = connectorActionCatalog(providerId, { [actionId]: action }).get(actionId);
  if (!manifest || !entry || action.effect !== "read") {
    throw new ConnectorRemedy(403, "Private calls support declared read actions only; use a Channel command for writes");
  }
  const parsed = action.parse(statement);
  if (typeof parsed === "string") throw new ConnectorRemedy(400, parsed);
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") throw new ConnectorRemedy(403, scope);
  const authorize = async () => {
    await authorizeCaller();
    const live = await commandScope(manifest, input);
    if (typeof live === "string" || live.spaceId !== scope.spaceId || live.connectionId !== scope.connectionId) {
      throw new ConnectorRemedy(403, "Connector access changed during the private call");
    }
    const refusal = actionRefusal({ actionId, mode: await connectionActionPolicy(input.env, {
      providerId, connectionId: scope.connectionId, actionId }) });
    if (refusal) throw new ConnectorRemedy(403, refusal);
  };
  const execute = async () => {
    await authorize();
    const context = await actionContext(providerId, input, scope.spaceId, actionId, action, authorize,
      `call:${input.messageId}`);
    if (typeof context === "string") throw new ConnectorRemedy(403, context);
    let result: ConnectorActionResult;
    try { result = await action.execute(context, parsed); }
    // Provider errors can contain the same private values as successes.
    // Recheck the Run, connection and policy before either leaves the executor.
    finally { await authorize(); }
    if (utf8ByteLength(JSON.stringify(result)) > 256 * 1024) {
      throw new ProviderRequestError(413, "Connector result is too large; narrow the request");
    }
    return result;
  };
  let result: ConnectorActionResult | undefined, failure: unknown;
  await withExecution(manifest, input, scope, { id: actionId, label: entry.definition.label, key: "", retry: resultVisibility }, async () => {
    try {
      result = await execute();
      return { status: "completed", summary: resultVisibility === "private" ? PRIVATE_CONNECTOR_RESULT
        : `${result.summary}${result.url ? ` — ${result.url}` : ""}` };
    } catch (error) {
      failure = error;
      return { status: error instanceof ProviderRequestError && error.status === 403 ? "blocked" : "failed",
        summary: resultVisibility === "private" ? privateFailure(error)
          : error instanceof ProviderRequestError ? error.message : "The connector call failed", remedy: remedyOf(error) };
    }
  });
  if (!result) throw failure;
  return result;
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
  const parsed = approved?.prepared ?? action.parse(statement);
  if (typeof parsed === "string") return result("failed", parsed);
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") return result("blocked", scope);
  const policyInput = { providerId, connectionId: scope.connectionId, actionId };
  const mode = await connectionActionPolicy(input.env, policyInput);
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
    const changed = await connectionActionPolicy(input.env, policyInput);
    if (changed === "disallow" || (changed === "ask" && !approved)) {
      throw new ProviderRequestError(403, actionRefusal({ actionId, mode: changed })!);
    }
  };
  if (!approved && (mode === "ask" || (durableUpload && mode === "allow"))) {
    try {
      const context = await actionContext(providerId, input, scope.spaceId, actionId, action, authorizeWrite);
      if (typeof context === "string") return result("blocked", context);
      const prepared = action.prepare ? await action.prepare(context, parsed) : parsed;
      const preview = providerId === "googlecalendar" ? JSON.parse(prepared.preview!) as Record<string, string>
        : providerId === "gmail"
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
      const shared = actionAuthorityFailure(error);
      if (shared) return result("blocked", shared);
      if (error instanceof ConnectorRemedy && error.status === 403) return result("blocked", error.message);
      return result("failed", error instanceof ProviderRequestError ? error.message : "could not create an approval request");
    }
  }
  return withExecution(manifest, input, scope, { id: actionId, label, key: "",
    ...(action.effect === "read" && !approved ? { retry: "public" as const } : {}) }, async () => {
    if (mode === "disallow") return { status: "blocked", summary: actionRefusal({ actionId, mode })! };
    try {
      const context = await actionContext(providerId, input, scope.spaceId, actionId, action, authorizeWrite,
        approved?.requestId ?? input.commandMessageId ?? input.messageId);
      if (typeof context === "string") return { status: "blocked", summary: context };
      await authorizeWrite();
      try {
        const result = await action.execute(context, parsed);
        const summary = result.url ? `${result.summary} — ${result.url}` : result.summary;
        return { status: "completed", summary: `${summary}${context.x?.billingSummary?.() ? `\n${context.x.billingSummary()}` : ""}` };
      } catch (error) {
        const authority = actionAuthorityFailure(error);
        if (authority) return { status: "blocked", summary: authority };
        const reason = error instanceof ProviderRequestError ? error.message
          : error instanceof DOMException && error.name === "TimeoutError"
            ? "the provider did not answer in time" : "the provider call failed";
        return { status: "failed", remedy: remedyOf(error), summary: reason +
          (context.x?.billingSummary?.() ? `\n${context.x.billingSummary()}` : "") };
      }
    } catch (error) {
      const shared = actionAuthorityFailure(error);
      if (shared) return { status: "blocked", summary: shared };
      if (error instanceof ProviderRequestError) return { status: error instanceof ConnectorRemedy && error.status === 403 ? "blocked" : "failed",
        summary: error.message, remedy: remedyOf(error) };
      return { status: "failed", summary: error instanceof DOMException && error.name === "TimeoutError"
        ? "the provider did not answer in time" : "the provider call failed" };
    }
  });
}

/** Local authority refusals use fixed recovery copy, never arbitrary exception text. */
function actionAuthorityFailure(error: unknown): string | undefined {
  if (!(error instanceof AppControlError)) return undefined;
  if (error.code === SLACK_WORKSPACE_TAKEN) return error.message;
  if (["action_request_scope_changed", "credential_changed"].includes(error.code)) {
    return "The connected account or credentials changed; review the current connection and request a new approval.";
  }
  if (["action_request_not_executing", "action_request_expired"].includes(error.code)) {
    return "This approval is no longer executable; review the current connection and request a new approval.";
  }
  if (error.code === "action_request_forbidden") {
    return "Current access no longer permits this approval; a Space admin must review it.";
  }
  return undefined;
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
  actionId: string, action: ConnectorAction, authorizeWrite: () => Promise<void>,
  billingKey = `prepare:${input.messageId}`): Promise<ConnectorActionContext | string> {
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
    actorUserId: input.actorUserId, action: actionId, billingKey, authorizeWrite }) : undefined;
  const xMedia = x && input.env.RELAY_PAYLOAD_BUCKET ? createXMediaCapability({ spaceId, channelId: input.channelId,
    actorUserId: input.actorUserId, x, authorizeWrite, bucket: input.env.RELAY_PAYLOAD_BUCKET,
    receiptSecret: input.env.RELAY_R2_CAPABILITY_HMAC_SECRET,
    attachmentAuthority: request => postgresMessageAttachmentAuthorityRequest(input.env, request) }) : undefined;
  const native = teams || googleChat || discord || feishu || telegram || wecom || dingtalk || x;
  const grant = native ? undefined : await connectionCredentialGrant(input.env, spaceId, providerId);
  const credentials = grant?.values ?? {};
  /* `a|b` requires either field: a pasted token or the one OAuth issued. */
  const missing = native ? [] : action.requires.filter((field) => !field.split("|").some((name) => credentials[name]));
  if (missing.length > 0) {
    // One field a person types is replaced where the failure shows; anything else comes from connecting again.
    const typed = (getAppConnectorProvider(providerId)!.credentials ?? []).find((field) =>
      field.id === missing[0] && !field.generated && !field.managed);
    throw new ConnectorRemedy(403, `save ${missing.join(", ")} in Apps → ${getAppConnectorProvider(providerId)!.name} → Credentials`,
      missing.length === 1 && typed ? { kind: "credential", field: typed.id } : { kind: "reconnect" });
  }
  const instanceId = input.senderKind === "agent" ? input.senderId : undefined;
  const caller = { userId: input.actorUserId,
    ...(instanceId ? { agent: () => agentRegistrationOf(input.env, { ownerUserId: input.actorUserId, instanceId }) } : {}) };
  const saveCredentials = grant ? credentialRenewal(input.env, spaceId, providerId, grant.version) : undefined;
  const usage = upstreamMeter(input.env, { spaceId, connector: providerId, action: actionId });
  return { credentials, caller, authorizeWrite, usage, ...(saveCredentials ? { saveCredentials } : {}), ...(teams ? { teams } : {}), ...(googleChat ? { googleChat } : {}),
    ...(discord ? { discord } : {}), ...(feishu ? { feishu } : {}), ...(telegram ? { telegram } : {}),
    ...(wecom ? { wecom } : {}), ...(dingtalk ? { dingtalk } : {}), ...(x ? { x } : {}), ...(xMedia ? { xMedia } : {}) };
}
