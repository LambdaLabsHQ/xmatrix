import { teamsActionCapability } from "./teams-native";
import { dingtalkActionCapability } from "./dingtalk-native";
import { telegramActionCapability } from "./telegram-native";
import { wecomActionCapability } from "./wecom-native";
import type { AppConnectorProviderManifest } from "@xmatrix/protocol";
import { getAppConnectorProvider } from "../app-connectors";
import { parseActionCommand, parsePolicyCommand } from "./action-parse";
import { commandScope, publishCommandStatus, withExecution } from "./command-support";
import { connectionCredentials } from "./connection-credentials";
import { discordActionCapability } from "./discord-native";
import { feishuActionCapability } from "./feishu-native";
import { googleChatActionCapability } from "./googlechat-native";
import { connectorActionPolicyRepository } from "./credentials";
import { ProviderRequestError } from "./http";
import type { Env } from "../types";
import type { ConnectorAction, ConnectorCommandHandler, ConnectorCommandInput, ConnectorSubscriptionSync } from "./provider";
import { runSubscriptionStatement } from "./subscription-command";
import { connectorSubscriptionStatements, isConnectorSubscriptionCommand } from "./subscription-parse";

/*
 * A provider's Channel commands (docs/design/connector-platform.md §3.3, §3.5):
 * subscriptions for event providers, one outbound action per message, and the
 * per-Channel action policy for Space admins. Policy is read at execution
 * time: `deny` blocks everyone; a write action from an Agent needs `allow`
 * unless its manifest marks it default-allow.
 */

/**
 * Why the Channel's policy refuses an action, if it does (§3.5): `deny` blocks
 * everyone; a write action defaults to allow for a Human's own command, and for
 * an Agent when the manifest marks it default-allow, otherwise it needs `allow`;
 * a read otherwise runs.
 */
export function actionRefusal(input: { providerId: string; actionId: string; effect: "read" | "write";
  mode: "allow" | "deny" | null; senderKind?: "user" | "agent"; defaultPolicy?: "allow" | "deny" }): string | undefined {
  if (input.mode === "deny") return `${input.actionId} is denied in this channel`;
  if (input.defaultPolicy === "deny" && input.mode !== "allow") {
    return `${input.actionId} is off in this channel until a Space admin sends @${input.providerId}:policy:${input.actionId} allow here`;
  }
  /* Only a message known to be a Human's counts as the Human's approval. */
  if (input.senderKind !== "user" && input.effect === "write" && input.mode !== "allow" && input.defaultPolicy !== "allow") {
    return `an Agent runs ${input.actionId} only after a Space admin sends @${input.providerId}:policy:${input.actionId} allow here`;
  }
  return undefined;
}

/**
 * Why the Channel's policy refuses an action as it stands now, read from the
 * Channel's mode and the action's manifest; an effect the manifest does not
 * name counts as a write, so an unknown action fails closed.
 */
export async function channelActionRefusal(env: Env, input: { providerId: string; connectionId: string;
  channelId: string; actionId: string; senderKind?: "user" | "agent"; effect?: "read" | "write" }):
  Promise<string | undefined> {
  const declared = getAppConnectorProvider(input.providerId)?.actions.find((action) => action.id === input.actionId);
  const mode = await connectorActionPolicyRepository(env).mode({ requestId: crypto.randomUUID(),
    connectionId: input.connectionId, channelId: input.channelId, actionId: input.actionId });
  return actionRefusal({ providerId: input.providerId, actionId: input.actionId,
    effect: input.effect ?? declared?.effect ?? "write", mode, senderKind: input.senderKind,
    defaultPolicy: declared?.defaultPolicy });
}

/** Whether a Channel policy can name this action: one that acts on the provider. */
export function isPolicyAction(manifest: AppConnectorProviderManifest, actionId: string): boolean {
  return manifest.actions.some((action) => action.id === actionId && action.effect);
}

export function connectorCommands(providerId: string,
  actions: Readonly<Record<string, ConnectorAction>> = {}, subscriptions?: ConnectorSubscriptionSync): ConnectorCommandHandler {
  const accepts = (body: string) => {
    if (isConnectorSubscriptionCommand(providerId, body)) return true;
    const parsed = parseActionCommand(providerId, body);
    return Boolean(parsed && (parsed.actionId === "policy" || actions[parsed.actionId]));
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
        if (parsed?.actionId === "policy") lines.push(await runPolicy(providerId, input, parsed.statement));
        else if (parsed && actions[parsed.actionId]) {
          lines.push(await runAction(providerId, input, parsed.actionId, actions[parsed.actionId]!, parsed.statement));
        }
      }
      await publishCommandStatus(manifest, input, lines);
    },
  };
}

export async function runPolicy(providerId: string, input: ConnectorCommandInput,
  statement: Parameters<typeof parsePolicyCommand>[0]): Promise<string> {
  const manifest = getAppConnectorProvider(providerId)!;
  if (input.senderKind !== "user") return `${manifest.name} policy: blocked; only a Space admin sets action policy.`;
  const parsed = parsePolicyCommand(statement);
  if ("error" in parsed) return `${manifest.name} policy: failed; ${parsed.error}.`;
  if (!isPolicyAction(manifest, parsed.actionId)) {
    return `${manifest.name} policy: failed; ${parsed.actionId} is not a ${manifest.name} action.`;
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

/**
 * Runs one action for a Channel and posts its receipt there, whoever asked:
 * a message's command or an Agent's tool call (connectors MCP).
 */
export async function runConnectorAction(providerId: string, input: ConnectorCommandInput, actionId: string,
  action: ConnectorAction, statement: Parameters<ConnectorAction["parse"]>[0]): Promise<string> {
  const manifest = getAppConnectorProvider(providerId);
  if (!manifest) return `${providerId} ${actionId}: failed; unknown connector.`;
  const line = await runAction(providerId, input, actionId, action, statement);
  await publishCommandStatus(manifest, input, [line]);
  return line;
}

async function runAction(providerId: string, input: ConnectorCommandInput, actionId: string,
  action: ConnectorAction, statement: Parameters<ConnectorAction["parse"]>[0]): Promise<string> {
  const manifest = getAppConnectorProvider(providerId)!;
  const label = manifest.actions.find((candidate) => candidate.id === actionId)?.label ?? actionId;
  const parsed = action.parse(statement);
  if (typeof parsed === "string") return `${manifest.name} ${actionId}: failed; ${parsed}.`;
  const scope = await commandScope(manifest, input);
  if (typeof scope === "string") return `${manifest.name} ${actionId}: blocked; ${scope}.`;
  return withExecution(manifest, input, scope, { id: actionId, label, key: "" }, async () => {
    const refusal = await channelActionRefusal(input.env, { providerId, connectionId: scope.connectionId,
      channelId: input.channelId, actionId, senderKind: input.senderKind, effect: action.effect });
    if (refusal) return { status: "blocked", summary: refusal };
    try {
      const authorizeWrite = async () => {
        const liveScope = await commandScope(manifest, input);
        if (typeof liveScope === "string" || liveScope.spaceId !== scope.spaceId || liveScope.connectionId !== scope.connectionId) {
          throw new ProviderRequestError(409, `${manifest.name} Channel access changed before posting`);
        }
        const changed = await channelActionRefusal(input.env, { providerId, connectionId: scope.connectionId,
          channelId: input.channelId, actionId, senderKind: input.senderKind, effect: action.effect });
        if (changed) throw new ProviderRequestError(403, changed);
      };
      const googleChat = providerId === "googlechat" && actionId === "post"
        ? await googleChatActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const discord = providerId === "discord" && actionId === "post"
        ? await discordActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const feishu = providerId === "feishu" && actionId === "send"
        ? await feishuActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const telegram = providerId === "telegram" && actionId === "send"
        ? await telegramActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const wecom = providerId === "wecom" && actionId === "send"
        ? await wecomActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const teams = providerId === "teams" && actionId === "post"
        ? await teamsActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const dingtalk = providerId === "dingtalk" && ["read", "send"].includes(actionId)
        ? await dingtalkActionCapability(input.env, scope.spaceId, authorizeWrite) : undefined;
      const native = teams || googleChat || discord || feishu || telegram || wecom || dingtalk;
      const credentials = native ? {} : await connectionCredentials(input.env, scope.spaceId, providerId);
      /* `a|b` requires either field: a pasted token or the one OAuth issued. */
      const missing = native ? [] : action.requires.filter((field) => !field.split("|").some((name) => credentials[name]));
      if (missing.length > 0) return { status: "blocked", summary: `save ${missing.join(", ")} in Apps → ${manifest.name} → Credentials` };
      const result = await action.execute({ credentials, ...(teams ? { teams } : {}), ...(googleChat ? { googleChat } : {}), ...(discord ? { discord } : {}), ...(feishu ? { feishu } : {}), ...(telegram ? { telegram } : {}), ...(wecom ? { wecom } : {}), ...(dingtalk ? { dingtalk } : {}) }, parsed);
      return { status: "completed", summary: result.url ? `${result.summary} — ${result.url}` : result.summary };
    } catch (error) {
      if (error instanceof ProviderRequestError) return { status: "failed", summary: error.message };
      return { status: "failed", summary: error instanceof DOMException && error.name === "TimeoutError"
        ? "the provider did not answer in time" : "the provider call failed" };
    }
  });
}
