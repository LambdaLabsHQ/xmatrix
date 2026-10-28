"use client";

import { useState, type ComponentType, type ReactNode } from "react";
import { ChevronLeft, Loader2, PlugZap, RefreshCw, Shield } from "lucide-react";
import type {
  SerializedAppConnectorConnection,
  SerializedAppConnectorExecution,
  SpaceMember,
} from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { noticeClass } from "@/components/ui/status-tone";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { cn } from "@/lib/utils";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CloudflareLogins } from "./cloudflare-logins";
import { ConnectorActivity } from "./connector-activity";
import {
  ConnectorCredentialForm, ConnectorCredentialRows, ConnectorEventDelivery, connectorGeneratesCredentials,
  connectorReconnectsWithSavedCredentials, connectorTakesCredentials, connectorWritableCredentials,
} from "./connector-credentials";
import {
  ConnectorAction, ConnectorBlock, ConnectorCopyLine, ConnectorField, ConnectorFold, ConnectorRow,
  ConnectorRows, ConnectorSection, ConnectorSheet,
} from "./connector-page";
import { ConnectorPolicy, connectorWriteActions } from "./connector-policy";
import { DingTalkCompanyConnection } from "./dingtalk-company-connection";
import { GitHubInstallationAccounts } from "./github-installation-accounts";
import { GmailMailboxes } from "./gmail-mailboxes";
import { GoogleChatRoomLink, chatLinkGuide } from "./googlechat-room-link";
import { GoogleDocFileSelection } from "./google-doc-file-selection";
import { ToolPaperScroll, ToolStateDot } from "./tool-split";
import { WeComCompanyConnection } from "./wecom-company-connection";
import { relativeTime } from "./workspace-shell-presence";
import { XAccounts } from "./x-accounts";

/*
 * An App's page. It reads top to bottom in the order the reader needs it:
 * what the app is and whether it works; the one thing to do now, when there
 * is one (connect, reconnect, fix), as the page's only sheet and only solid
 * action; then, once connected, what it reaches, how to use it in a channel,
 * what it did, what it may do, its settings; the command reference, folded;
 * and Disconnect last. A connected app that works shows no call to action.
 */

type ConnectOptions = { mode?: "add" | "manage" | "install" | "account"; installationId?: string; xAccountId?: string };

const NATIVE_CHATS = ["googlechat", "feishu", "telegram", "teams"] as const;
type NativeChat = (typeof NATIVE_CHATS)[number];
const isNativeChat = (id: string): id is NativeChat => (NATIVE_CHATS as readonly string[]).includes(id);

/** How this app connects on this Hub. */
type SetupKind = "github" | "chat" | "company" | "oauth" | "credentials" | "generated" | "unavailable";

function setupKind(connector: AppConnectorManifest, oauth: boolean, native: boolean): SetupKind {
  if (connector.id === "github") return "github";
  if (native && isNativeChat(connector.id)) return "chat";
  if (native && (connector.id === "dingtalk" || connector.id === "wecom")) return "company";
  if (oauth) return "oauth";
  if (connectorWritableCredentials(connector).length > 0) return "credentials";
  // Only a sign-in fills its credentials, and this Hub has none for it.
  if (!connectorGeneratesCredentials(connector) && connector.credentials?.some((field) => field.managed)) return "unavailable";
  return "generated";
}

/* What a connected app authorizes with, said once in its status line:
   "via GitHub App", "via Feishu company app", "via Integration token". */
function connectorAuthorizationLabel(connector: AppConnectorManifest, connection: SerializedAppConnectorConnection,
  oauth: boolean, native: boolean): string | null {
  if (connector.id === "github") return "GitHub App";
  if (native && isNativeChat(connector.id) && !connection.credentialFields?.length) {
    return connector.id === "googlechat" ? "Google Chat app" : `${connector.name} company app`;
  }
  const saved = (connection.credentialFields ?? []).map((id) => connector.credentials?.find((field) => field.id === id))
    .filter((field) => field && !field.generated);
  if (saved.some((field) => field!.managed) || (oauth && saved.length === 0)) return `${connector.name} sign-in`;
  return saved.length === 1 ? saved[0]!.label : saved.length > 1 ? "saved credentials" : null;
}

export function ConnectorDetailPage({
  connector, Icon, connection, spaceId, token, userId, members, oauth, native,
  executions, executionsLoading, executionsError, notice, error, connecting, checking, disconnecting,
  onBack, onConnect, onCheck, onDisconnect, onRefreshExecutions, onSaveMetadata, ensureConnectionRow, refreshConnections,
}: {
  connector: AppConnectorManifest;
  Icon: ComponentType<{ className?: string }>;
  connection?: SerializedAppConnectorConnection;
  spaceId: string;
  token: string;
  userId: string;
  members: SpaceMember[];
  /** One-click OAuth is configured for this app on the Hub. */
  oauth: boolean;
  /** The Hub's company app links this app's groups. */
  native: boolean;
  executions: SerializedAppConnectorExecution[];
  executionsLoading: boolean;
  executionsError: string | null;
  notice: { tone: "success" | "warning"; message: string } | null;
  error: string | null;
  connecting: boolean;
  checking: boolean;
  disconnecting: boolean;
  onBack: () => void;
  onConnect: (options?: ConnectOptions) => void;
  onCheck: () => Promise<void>;
  onDisconnect: () => void;
  onRefreshExecutions: () => void;
  onSaveMetadata: (metadata: Record<string, unknown>) => Promise<void>;
  /** Creates the unconnected row credentials and links are stored on. */
  ensureConnectionRow: () => Promise<void>;
  refreshConnections: () => Promise<void>;
}) {
  const available = connector.status === "available";
  const configured = connection?.status === "configured";
  const needsAttention = connection?.status === "error";
  const kind = setupKind(connector, oauth, native);
  const busy = connecting || checking || disconnecting;
  const credentials = { connector, connection, spaceId, token, userId, beforeSave: ensureConnectionRow, afterSave: onCheck };
  // A linked company app owns these apps' delivery; a manual webhook replaces it and takes no ingress of its own.
  const manualConnector = ["googlechat", "wecom", "teams"].includes(connector.id) ? { ...connector, events: undefined } : connector;
  const writableIds = new Set(connectorWritableCredentials(connector).map((field) => field.id));
  const hasTypedCredentials = Boolean(connection?.credentialFields?.some((id) => writableIds.has(id)));
  const hasConnection = Boolean(connection);

  return (
    <ToolPaperScroll>
      <button type="button" onClick={onBack}
        className="-ml-1 mb-2 flex items-center gap-0.5 text-sm font-medium text-muted-foreground hover:text-foreground md:hidden">
        <ChevronLeft className="size-4" /> Apps
      </button>
      <ConnectorHero connector={connector} Icon={Icon} connection={connection} oauth={oauth} native={native} checking={checking}
        onCheck={() => void onCheck()} />
      <div className="mt-8 space-y-10">
        {notice || error ? (
          <div className="space-y-2">
            {notice ? <p className={noticeClass(notice.tone === "success" ? "settled" : "attention", "font-medium")}>{notice.message}</p> : null}
            {error ? <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <ConnectorLead connector={connector} connection={connection} kind={kind} available={available} busy={busy}
          connecting={connecting} checking={checking} credentials={credentials} onConnect={onConnect} onCheck={onCheck} />

        {/* Linking a group or a company is the lead until it connects, and then the list of what is linked:
            one part in one place, so a confirmation in progress survives the change. */}
        {kind === "chat" && isNativeChat(connector.id) ? (
          <ConnectorBlock lead={!configured} tone={needsAttention ? "alert" : "plain"}
            title={configured ? chatLinkTitle(connector.id) : needsAttention ? `${connector.name} isn't working` : `Connect ${connector.name}`}
            note={configured ? undefined : needsAttention && connection?.error ? connection.error : chatLinkGuide(connector.id).lead}>
            <GoogleChatRoomLink key={`${spaceId}:${connector.id}`} provider={connector.id} spaceId={spaceId} token={token}
              lead={!configured} beforeLink={ensureConnectionRow} afterRefresh={refreshConnections} />
            <div className="mt-3"><ConnectorFold summary="Details">
              <p className="max-w-[62ch] pb-1 text-[13px] leading-[1.45] text-muted-foreground">{chatLinkGuide(connector.id).details}</p>
            </ConnectorFold></div>
          </ConnectorBlock>
        ) : null}
        {kind === "company" ? (
          <ConnectorBlock lead={!configured} tone={needsAttention ? "alert" : "plain"}
            title={configured ? "Company application" : `Connect ${connector.name}`}
            note={connector.id === "dingtalk"
              ? "Authorize one company and up to 20 members. Work notifications use the company's approved template and each channel's permissions."
              : "Authorize the company application and confirm up to 20 members to receive notifications and reply under each channel's permissions. Message contents stay in WeCom."}>
            {connector.id === "dingtalk"
              ? <DingTalkCompanyConnection key={spaceId} spaceId={spaceId} token={token} lead={!configured}
                beforeLink={ensureConnectionRow} afterRefresh={refreshConnections} />
              : <WeComCompanyConnection key={spaceId} spaceId={spaceId} token={token} lead={!configured}
                beforeLink={ensureConnectionRow} afterRefresh={refreshConnections} />}
          </ConnectorBlock>
        ) : null}

        {connector.id === "github" ? (
          <GitHubInstallationAccounts key={spaceId} spaceId={spaceId} token={token} hideWhenEmpty={!configured}
            onManage={(installationId) => onConnect({ mode: "manage", installationId })}
            onAuthorize={() => onConnect({ mode: "add" })}
            onInstall={() => onConnect({ mode: "account" })}
            onChanged={refreshConnections} />
        ) : null}
        {connector.id === "gmail" && configured ? (
          <GmailMailboxes key={spaceId} spaceId={spaceId} token={token} userId={userId} members={members}
            adding={connecting} onAdd={() => onConnect()} />
        ) : null}
        {connector.id === "cloudflare" && hasConnection ? (
          <CloudflareLogins key={spaceId} spaceId={spaceId} token={token} userId={userId} members={members}
            adding={connecting} canAdd={oauth} onAdd={() => onConnect()} onChanged={refreshConnections} />
        ) : null}
        {connector.id === "x" && hasConnection ? (
          <XAccounts key={spaceId} spaceId={spaceId} token={token} userId={userId} members={members}
            adding={connecting} canAdd={oauth} onAdd={() => onConnect()} onChanged={refreshConnections}
            onReconnect={(accountId) => onConnect({ xAccountId: accountId })} />
        ) : null}
        {connector.id === "google" && configured ? (
          <ConnectorSection title="Documents"
            note="Choose a Doc or Sheet with the Google account connected to this Space; xMatrix may then read it.">
            <GoogleDocFileSelection key={spaceId} spaceId={spaceId} token={token} />
          </ConnectorSection>
        ) : null}

        {configured ? <ConnectorUseInChannel connector={connector} /> : null}

        {configured || executions.length > 0 ? (
          <ConnectorActivity executions={executions} members={members} loading={executionsLoading} error={executionsError}
            credentials={credentials} onRefresh={onRefreshExecutions} onReconnect={() => onConnect()} />
        ) : null}

        {configured && connectorWriteActions(connector).length > 0 ? (
          <ConnectorPolicy connector={connector} spaceId={spaceId} token={token} userId={userId} />
        ) : null}

        {connector.id === "github" && configured && connection ? (
          <GitHubSettings key={connection.updatedAt} connection={connection} onSave={onSaveMetadata} />
        ) : null}
        {/* A company app can be replaced by the Space's own app or webhook; said where that is set up. */}
        {(kind === "chat" || kind === "company") && available && connectorTakesCredentials(connector) ? (
          <ConnectorSection title={manualTitle(connector.id)} note={manualNote(connector.id)}>
            <ConnectorFold summary="Set it up">
              <div className="space-y-8 pt-2">
                {connectorWritableCredentials(connector).length > 0 ? hasTypedCredentials
                  ? <ConnectorCredentialRows {...credentials} connector={manualConnector} />
                  : <ConnectorCredentialForm {...credentials} connector={manualConnector} submitLabel={configured ? "Save credentials" : "Save and connect"} /> : null}
                {connectorGeneratesCredentials(manualConnector) ? <ConnectorEventDelivery {...credentials} connector={manualConnector} /> : null}
              </div>
            </ConnectorFold>
          </ConnectorSection>
        ) : null}
        {kind !== "chat" && kind !== "company" && configured && connectorWritableCredentials(connector).length > 0 ? (
          // A sign-in needs none; typed credentials are then the exception, so they wait behind a fold.
          kind === "oauth" && !hasTypedCredentials ? (
            <ConnectorSection title="Credentials" note={`Not needed while the ${connector.name} sign-in works.`}>
              <ConnectorFold summary="Paste credentials instead">
                <div className="pt-2"><ConnectorCredentialForm {...credentials} submitLabel="Save credentials" /></div>
              </ConnectorFold>
            </ConnectorSection>
          ) : (
            <ConnectorSection title="Credentials" note={`Saved values are never shown again. Replace one when ${connector.name} issues a new one.`}>
              <ConnectorCredentialRows {...credentials} />
            </ConnectorSection>
          )
        ) : null}
        {kind !== "chat" && kind !== "company" && configured && connectorGeneratesCredentials(manualConnector)
          && !(connector.id === "stripe" && kind === "oauth" && !hasTypedCredentials)
          ? <ConnectorEventDelivery {...credentials} connector={manualConnector} /> : null}

        <ConnectorCommands connector={connector} />

        {configured ? (
          <section aria-label="Disconnect" className="pb-4">
            <button type="button" disabled={busy} onClick={onDisconnect} aria-label={`Disconnect ${connector.name}`}
              className={actionClass({ variant: "danger", size: "sm" })}>
              {disconnecting ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : null}
              {disconnecting ? "Disconnecting" : `Disconnect ${connector.name}`}
            </button>
            <p className="mt-2 max-w-[62ch] text-[12px] leading-[1.45] text-muted-foreground">
              Commands and channel delivery stop until it is connected again. Typed credentials stay saved; a sign-in is forgotten.
            </p>
          </section>
        ) : null}
      </div>
    </ToolPaperScroll>
  );
}

function ConnectorHero({ connector, Icon, connection, oauth, native, checking, onCheck }: {
  connector: AppConnectorManifest;
  Icon: ComponentType<{ className?: string }>;
  connection?: SerializedAppConnectorConnection;
  oauth: boolean;
  native: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  const configured = connection?.status === "configured";
  const needsAttention = connection?.status === "error";
  const label = configured ? "Connected" : needsAttention ? "Needs attention" : connection ? "Disconnected"
    : connector.status === "available" ? "Not connected" : "Coming soon";
  const via = configured && connection ? connectorAuthorizationLabel(connector, connection, oauth, native) : null;
  return (
    <header className="app-connector-hero">
      <div className="flex items-center gap-3 md:gap-4">
        <Icon className="size-10 shrink-0 md:size-12" />
        <h2 className="min-w-0 text-[22px] font-black leading-tight tracking-tight [overflow-wrap:anywhere] md:text-[26px]">{connector.name}</h2>
      </div>
      {/* Under the name, not beside the mark, so a phone gives the words the whole width. */}
      <div className="md:pl-16">
        <ClampedText text={connector.description} className="mt-2 max-w-[62ch] text-[14px] leading-[1.5] text-muted-foreground md:mt-1" />
        {/* One run of text, so it wraps between words and never starts a line with "·". */}
        <p className="mt-3 text-[13px] leading-7 text-muted-foreground" data-testid="connector-status">
          <ToolStateDot state={needsAttention ? "attention" : configured ? "running" : "offline"} />
          <span className={cn("ml-1.5 font-semibold text-foreground", needsAttention && "text-destructive")}>{label}</span>
          {via ? <> · via {via}</> : null}
          {configured && connection?.lastCheckedAt ? <> · checked {relativeTime(connection.lastCheckedAt)}</> : null}
          {configured ? (
            <ConnectorAction disabled={checking} onClick={onCheck} className="ml-1.5 align-middle"
              title={`Check ${connector.name} connection`} aria-label={`Check ${connector.name} connection`}>
              {checking ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Check
            </ConnectorAction>
          ) : null}
        </p>
      </div>
    </header>
  );
}

/** Long words about the app fold to three lines; More shows the rest. */
function ClampedText({ text, className }: { text: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 200;
  return (
    <div className={className}>
      <p className={cn(long && !open && "line-clamp-3")}>{text}</p>
      {long ? (
        <button type="button" onClick={() => setOpen((value) => !value)}
          className="mt-0.5 text-[13px] font-semibold text-muted-foreground hover:text-foreground">
          {open ? "Less" : "More"}
        </button>
      ) : null}
    </div>
  );
}

/** The one thing to do now, when there is one. Chat and company apps draw theirs where they link. */
function ConnectorLead({ connector, connection, kind, available, busy, connecting, checking, credentials, onConnect, onCheck }: {
  connector: AppConnectorManifest;
  connection?: SerializedAppConnectorConnection;
  kind: SetupKind;
  available: boolean;
  busy: boolean;
  connecting: boolean;
  checking: boolean;
  credentials: Parameters<typeof ConnectorCredentialForm>[0];
  onConnect: (options?: ConnectOptions) => void;
  onCheck: () => Promise<void>;
}) {
  const name = connector.name;
  if (!available) return <ConnectorSheet title={`${name} is coming soon`} body="It can't be connected yet." />;
  if (connection?.status === "configured" || kind === "chat" || kind === "company") return null;
  const needsAttention = connection?.status === "error";
  const disconnected = Boolean(connection) && !needsAttention;
  const savedCredentials = kind === "credentials" && connectorReconnectsWithSavedCredentials(connector, connection);
  const writable = connectorWritableCredentials(connector);
  const primary = (label: string, onClick: () => void, pending: boolean) => (
    <button type="button" disabled={busy} onClick={onClick} className={actionClass({ variant: "primary", size: "md" })}>
      {pending ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <PlugZap className="size-4" />} {label}
    </button>
  );
  const checkAgain = needsAttention ? (
    <ConnectorAction disabled={busy} onClick={() => void onCheck()}
      title={`Check ${name} connection`} aria-label={`Check ${name} connection`}>
      {checking ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Check again
    </ConnectorAction>
  ) : null;
  const title = needsAttention ? `${name} isn't working` : disconnected ? `Reconnect ${name}` : `Connect ${name}`;
  const why = needsAttention ? connection?.error || "The connection needs to be authorized again." : null;

  let body: ReactNode;
  let action: ReactNode;
  if (kind === "github") {
    body = why ?? (disconnected
      ? "Reconnect to bring back repository access for this Space."
      : "Install the xMatrix GitHub App on an account or organization and choose the repositories it may reach.");
    action = (
      <div className="flex flex-wrap items-center gap-2">
        {primary(disconnected || needsAttention ? "Reconnect" : "Connect GitHub", () => onConnect(), connecting)}
        {!disconnected && !needsAttention ? (
          <ConnectorAction disabled={busy} onClick={() => onConnect({ mode: "add" })}>Already installed? Find my GitHub accounts</ConnectorAction>
        ) : null}
      </div>
    );
  } else if (kind === "oauth") {
    body = why ?? (disconnected ? `Sign in with ${name} again to resume channel delivery and commands.`
      : `Sign in with ${name} and approve what xMatrix may reach.`);
    action = (
      <div className="space-y-3">
        {primary(disconnected || needsAttention ? "Reconnect" : `Connect with ${name}`, () => onConnect(), connecting)}
        {writable.length > 0 ? (
          <ConnectorFold summary="Paste credentials instead">
            <div className="pt-2"><ConnectorCredentialForm {...credentials} /></div>
          </ConnectorFold>
        ) : null}
      </div>
    );
  } else if (kind === "credentials") {
    body = why ?? (savedCredentials ? "Its saved credentials are still here; reconnecting checks them again."
      : `Paste the credentials below. xMatrix checks them with ${name} before it connects.`);
    action = savedCredentials ? (
      <div className="space-y-3">
        <button type="button" disabled={busy} onClick={() => void onCheck()} className={actionClass({ variant: "primary", size: "md" })}
          title={`Reconnect ${name} with its saved credentials`}>
          {checking ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <PlugZap className="size-4" />} Reconnect
        </button>
        <ConnectorFold summary="Use other credentials">
          <div className="pt-2"><ConnectorCredentialForm {...credentials} /></div>
        </ConnectorFold>
      </div>
    ) : <ConnectorCredentialForm {...credentials} />;
  } else if (kind === "generated") {
    body = why ?? (disconnected ? "Reconnect to resume channel delivery."
      : connectorGeneratesCredentials(connector)
        ? `xMatrix makes the URL ${name} delivers its events to, then checks the connection.`
        : `xMatrix checks that it can reach ${name}, then it is ready in every channel.`);
    action = primary(disconnected || needsAttention ? "Reconnect" : "Connect", () => onConnect(), connecting);
  } else {
    body = `One-click sign-in for ${name} isn't set up on this Hub yet.`;
    action = null;
  }
  return (
    <ConnectorBlock lead tone={needsAttention ? "alert" : "plain"} title={title} note={body} action={checkAgain}
      testId="connector-lead">
      {action}
    </ConnectorBlock>
  );
}

function chatLinkTitle(id: NativeChat): string {
  return id === "teams" ? "Teams conversation" : id === "googlechat" ? "Google Chat space" : id === "telegram" ? "Telegram groups" : "Feishu groups";
}

function manualTitle(id: string): string {
  return id === "wecom" ? "Manual group robot" : id === "googlechat" || id === "teams" ? "Manual webhook"
    : id === "telegram" ? "Your own bot" : "Your own app";
}

function manualNote(id: string): string {
  if (id === "googlechat" || id === "teams") {
    return `Saving a manual ${id === "teams" ? "Workflows" : "incoming"} webhook replaces the linked app connection.`;
  }
  if (id === "feishu") return "Saving your own app credentials or generating a manual ingress URL replaces all linked company app groups.";
  if (id === "telegram") return "Saving your own bot credentials or generating a manual ingress URL replaces all linked company bot groups.";
  if (id === "wecom") return "Saving a group robot webhook key replaces the company installation and its member range. Group robots support outbound messages only.";
  return "Saving your own credentials replaces the company installation.";
}

/** The command that brings the app's events into a channel, ready to paste. */
function ConnectorUseInChannel({ connector }: { connector: AppConnectorManifest }) {
  const subscribe = connector.id === "github"
    ? { command: "@github:subscribe:OWNER/REPO all",
        note: "Post this in a channel to receive a repository's commits, issues, pull requests, comments and reviews." }
    : connector.events
      ? { command: `@${connector.id}:subscribe:${connector.events.source.placeholder}`,
          note: `Post this in a channel to receive ${connector.name} events. ${connector.events.source.description}` }
      : null;
  if (!subscribe) return null;
  return (
    <ConnectorSection title="Use it in a channel" note={subscribe.note} testId="connector-use-in-channel">
      <ConnectorCopyLine value={subscribe.command} label="subscribe command" />
    </ConnectorSection>
  );
}

/** Every command the app takes: reference, so it stays folded until asked for. */
function ConnectorCommands({ connector }: { connector: AppConnectorManifest }) {
  if (connector.actions.length === 0) return null;
  return (
    <ConnectorSection title="Commands" testId="connector-commands-section"
      note={`What Agents and people can run in a channel, such as @${connector.id}:${connector.actions[0]!.id}.`}>
      <ConnectorFold summary={`Show all ${connector.actions.length} commands`} testId="connector-commands-fold">
        <ConnectorRows testId="connector-commands">
          {connector.actions.map((action) => (
            <ConnectorRow key={action.id} title={action.label} meta={action.description}>
              {action.usage ? (
                <code className="mt-1 block break-all font-mono text-[12px] text-muted-foreground">@{connector.id}:{action.id}:{action.usage}</code>
              ) : null}
            </ConnectorRow>
          ))}
        </ConnectorRows>
        <p className="mt-3 flex gap-2 text-[12px] leading-5 text-muted-foreground">
          <Shield className="mt-0.5 size-3.5 shrink-0" />
          Credentials stay out of chat: commands run with scoped provider authorization and short-lived credentials.
        </p>
      </ConnectorFold>
    </ConnectorSection>
  );
}

/** GitHub's own settings: the repository a short reference means, and the workflows Agents may dispatch. */
function GitHubSettings({ connection, onSave }: {
  connection: SerializedAppConnectorConnection;
  onSave: (metadata: Record<string, unknown>) => Promise<void>;
}) {
  const metadata = connection.metadata || {};
  const text = (key: string) => typeof metadata[key] === "string" ? metadata[key] as string : "";
  const initial = {
    repository: text("repository") || text("githubRepository"),
    workflows: Array.isArray(metadata.actionsWorkflowIds)
      ? metadata.actionsWorkflowIds.filter((value): value is string => typeof value === "string").join("\n") : "",
  };
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const dirty = draft.repository !== initial.repository || draft.workflows !== initial.workflows;
  async function save() {
    const actionsWorkflowIds = Array.from(new Set(draft.workflows.split(/[\r\n,]+/u).map((value) => value.trim()).filter(Boolean)));
    if (actionsWorkflowIds.length > 32 || actionsWorkflowIds.some((value) =>
      value.length > 128 || !/^(?:[1-9][0-9]*|[A-Za-z0-9_.-]+\.ya?ml)$/u.test(value))) {
      setProblem("List at most 32 workflows, each a numeric id or a .yml/.yaml file name.");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await onSave({ ...metadata, repository: draft.repository.trim(), actionsWorkflowIds });
    } catch (caught) {
      setProblem(userErrorMessage(caught, "Couldn't save the app settings", "Couldn't save the GitHub settings"));
    } finally {
      setSaving(false);
    }
  }
  return (
    <ConnectorSection title="Settings" testId="github-settings">
      <form className="mt-1 space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <ConnectorField label="Default repository" help={<>Used when a command names only a number, such as <code>#42</code>.</>}>
          <Input id="github-default-repository" value={draft.repository} placeholder="owner/repository"
            pattern="[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+"
            onChange={(event) => setDraft((current) => ({ ...current, repository: event.target.value }))} />
        </ConnectorField>
        <ConnectorField label="Workflows Agents may dispatch"
          help="One workflow file name or numeric id per line. Every workflow not listed stays off; whether agents may dispatch is set under Permissions.">
          <Textarea value={draft.workflows} rows={3} placeholder={"production-release-request.yml\n123456"}
            onChange={(event) => setDraft((current) => ({ ...current, workflows: event.target.value }))} />
        </ConnectorField>
        {problem ? <p role="alert" className="text-[13px] font-medium text-destructive">{problem}</p> : null}
        {dirty ? (
          <div className="flex items-center gap-1">
            <button type="submit" disabled={saving} className={actionClass({ variant: "secondary", size: "sm" })}>
              {saving ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : null} Save settings
            </button>
            <ConnectorAction disabled={saving} onClick={() => { setDraft(initial); setProblem(null); }}>Cancel</ConnectorAction>
          </div>
        ) : null}
      </form>
    </ConnectorSection>
  );
}
