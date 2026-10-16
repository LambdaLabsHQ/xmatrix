import type { AgentRegistrationIdentity } from "./agent-caller";
import type { Env } from "../types";
import type { XActionCapability } from "./x-accounts";
import type { XMediaCapability } from "./x-media";
import type { UpstreamMeter } from "../usage-cost-metering";

/**
 * One provider's Hub-side behavior (docs/design/connector-platform.md §3.1).
 * The shared manifest in `@xmatrix/protocol` stays the data contract; this is
 * what the Hub runs for it. Generic code dispatches through the registry and
 * never branches on a provider id.
 */
export interface ConnectorProvider {
  /** The manifest id this module implements. */
  id: string;
  /** Channel commands (`@<id>:<action> …`), if the provider takes any. */
  commands?: ConnectorCommandHandler;
  /** Inbound deliveries through the per-connection ingress, if any. */
  events?: ConnectorEventSource;
  /** Outbound actions (§3.5), keyed by manifest action id. */
  actions?: Readonly<Record<string, ConnectorAction>>;
  /** Provider-side configuration that follows the Space's subscriptions, if the provider keeps any. */
  subscriptions?: ConnectorSubscriptionSync;
  /** One cheap authenticated provider call proving the stored credentials work; throws when they do not. */
  verify?: (credentials: Readonly<Record<string, string>>, meter?: UpstreamMeter) => Promise<void>;
}

/**
 * Makes the provider's own configuration match whether any Channel in the
 * Space subscribes to a source: before a subscribe is recorded, and after the
 * last Channel unsubscribes. A returned string refuses the subscription.
 */
export interface ConnectorSubscriptionSync {
  sync(input: { env: Env; spaceId: string; credentials: Readonly<Record<string, string>>; source: string; subscribed: boolean }):
    Promise<string | undefined>;
}

/** `@<provider>:<action>:<target> <text…>` after the mention is stripped. */
export interface ConnectorActionStatement {
  target: string;
  /** Everything after the target: the rest of the first line and every later line. */
  text: string;
}

export interface ConnectorActionContext {
  /** X accounts scoped to this caller; grants remain inside the Hub. */
  x?: XActionCapability;
  /** Channel attachment access and account-bound X video upload receipts. */
  xMedia?: XMediaCapability;
  /** Revalidates current Channel policy immediately before an outbound write. */
  authorizeWrite?: () => Promise<void>;
  /** The connection's decrypted credential values. */
  credentials: Readonly<Record<string, string>>;
  /** Meters the operator-paid upstream calls (Composio) this action makes, to its Space. */
  usage?: UpstreamMeter;
  /**
   * Stores values the provider itself renewed during the call (a web session's rotated cookies) in the same
   * encrypted connection credentials, as the Hub's own write. Only fields the manifest declares are accepted.
   */
  saveCredentials?: (fields: Readonly<Record<string, string>>) => Promise<void>;
  /**
   * Who runs the action: the Human, or an Agent and the user whose Run it is.
   * `agent` resolves the Agent's registration only when an action needs it.
   */
  caller?: { userId: string; agent?: () => Promise<AgentRegistrationIdentity | undefined> };
  /** Hub-authorized native app capability, scoped to one confirmed Google Chat room. */
  teams?: { postMessage(text: string): Promise<void> };
  googleChat?: { postMessage(text: string): Promise<void> };
  /** Shared Discord bot constrained by the current encrypted installation grant and live policy. */
  discord?: { postMessage(channel: string, text: string): Promise<void> };
  /** Company app constrained by current tenant lifecycle and explicitly confirmed group grants. */
  feishu?: { sendMessage(chat: string, text: string): Promise<void> };
  /** Shared company bot constrained to currently confirmed Telegram groups. */
  telegram?: { sendMessage(chat: string, text: string): Promise<void> };
  /** Direct member recipient selected by a Human admin; native tokens never enter action credentials. */
  wecom?: { sendMessage(recipient: string, text: string): Promise<void> };
  dingtalk?: {
    readMember(recipient: string): Promise<{ memberId: string; name: string; active: true }>;
    sendMessage(recipient: string, text: string): Promise<{ taskId: number; summary: string }>;
  };
}

export interface ConnectorActionResult {
  summary: string;
  url?: string;
}

export interface ConnectorAction {
  effect: "read" | "write";
  /** Credential fields the action cannot run without. */
  requires: readonly string[];
  /** Validates the statement before any provider call; a string is the reason it is invalid. */
  parse(statement: ConnectorActionStatement): Record<string, string> | string;
  /** Freeze the provider destination and preview before asking a Human. */
  prepare?: (context: ConnectorActionContext, input: Record<string, string>) => Promise<Record<string, string>>;
  execute(context: ConnectorActionContext, input: Record<string, string>): Promise<ConnectorActionResult>;
}

/** A Human-authored message, after its Authority commit, that may be a command. */
export interface ConnectorCommandInput {
  env: Env;
  channelId: string;
  messageId: string;
  /** The original command for a later attempt; null publishes an unthreaded decision with no retained message reference. */
  commandMessageId?: string | null;
  body: string;
  actorUserId: string;
  /** Who wrote the message; an Agent runs write actions only where the Channel allows it. */
  senderKind?: "user" | "agent";
  /** The Agent Instance when an Agent wrote it. */
  senderId?: string;
}

export interface ConnectorCommandHandler {
  /**
   * Whether the message's leading statement is a command this provider runs.
   * Cheap and pure: it decides whether the post-commit hook schedules any work.
   */
  accepts(body: string): boolean;
  run(input: ConnectorCommandInput): Promise<void>;
}

/** One delivery as the ingress received it, after the ingress key matched. */
export interface ConnectorDelivery {
  rawBody: string;
  headers: Headers;
  url: URL;
  /** The connection's decrypted credential values. */
  credentials: Readonly<Record<string, string>>;
}

/** A provider event in the one shape routing, messages and Automations read. */
export interface ConnectorEvent {
  /** Stable per delivery: message ids and Automation events dedupe on it. */
  eventId: string;
  /** Lower-case source ref a Channel subscribes to, e.g. `webhook:deploys`. */
  sourceRef: string;
  /** One of the manifest's `events.features` ids. */
  feature: string;
  /** One line, used by Automation occurrences. */
  summary: string;
  /** Bounded markdown posted to subscribed Channels. Untrusted content. */
  body: string;
  url?: string;
}

export type ConnectorDeliveryResult =
  | { ok: true; events: ConnectorEvent[] }
  /** The delivery is not this provider's to accept; nothing is written. */
  | { ok: false; status: 400 | 401; error: string }
  /** A provider handshake the ingress answers directly (e.g. URL verification). */
  | { ok: "respond"; response: Response };

export interface ConnectorEventSource {
  /**
   * Authenticates and normalizes one delivery. Pure apart from Web Crypto:
   * it never reads Hub state, so fixture tests drive it directly.
   */
  receive(delivery: ConnectorDelivery): Promise<ConnectorDeliveryResult>;
}
