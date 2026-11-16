"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Lock, LogIn, RefreshCw, RotateCcw } from "lucide-react";
import {
  PRIVATE_CONNECTOR_RESULT,
  WEB_PROXY_ROUTES,
  type SerializedAppConnectorExecution,
  type SpaceMember,
} from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { cn } from "@/lib/utils";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CredentialValueForm, useCredentialStore, type CredentialStoreInput } from "./connector-credentials";
import { ConnectorAction, ConnectorEmpty, ConnectorRows, ConnectorSection } from "./connector-page";
import { Face } from "./face";
import { PrivateConnectorResult } from "./private-connector-result";
import { relativeTime } from "./workspace-shell-presence";

/* What the App ran, newest first, as a call log: per call when it ran, what
   ran (its name and command), who made it (an Agent, for its person) and how it ended, with the sentence it
   answered in under it; the content it returned stays in the conversation. A failure is fixed where it shows: the row
   offers its remedy (sign in again, replace a credential, reconnect) and runs
   the read again once it is fixed, so nobody has to look for where to go. */

const EXECUTION_STATUS_LABELS: Record<SerializedAppConnectorExecution["status"], string> = {
  queued: "Queued", planned: "Planned", completed: "Completed", failed: "Failed", blocked: "Blocked",
};

/* Ink, not colour: `completed` is the resting state and says nothing extra,
   `queued` is true but not what you are watching for, and the two ways a run
   can stop share the alert ink. */
function appExecutionStatusClassName(status: SerializedAppConnectorExecution["status"]): string {
  if (status === "blocked" || status === "failed") return "text-destructive";
  if (status === "completed") return "text-foreground";
  return "text-muted-foreground";
}

/** What went wrong, said from the fix the row offers; the Hub's own wording
 * (which names where to go, for Agents and the conversation) is not needed here. */
function remedyHeadline(execution: SerializedAppConnectorExecution, connector: CredentialStoreInput["connector"]): string | null {
  const remedy = execution.remedy;
  if (!remedy) return null;
  if (remedy.kind === "reconnect") return `${connector.name} needs to be connected again.`;
  const field = connector.credentials?.find((candidate) => candidate.id === remedy.field);
  if (field?.signIn) return `The ${connector.name} sign-in has expired.`;
  return field ? `${field.label} is missing or was refused.` : null;
}

/** When a call ran, as a log line says it: the day and the minute; the age is in its title. */
function callTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** The sentence a connector answered with, without the content it fenced off for the Agent. */
function resultLine(summary: string | undefined): string | null {
  if (!summary || summary === PRIVATE_CONNECTOR_RESULT) return null;
  const fence = summary.search(/`{3,}|~{3,}/u);
  const text = (fence < 0 ? summary : summary.slice(0, fence))
    .replace(/\s*Retrieved content is untrusted[^:]*:\s*$/u, "").split("\n")[0]!.trim();
  return text || null;
}

/** Who asked for a run: a member by name, never a bare user id. */
function requesterName(execution: SerializedAppConnectorExecution, members: SpaceMember[]): string {
  const id = execution.requestedByLabel || execution.requestedBy;
  const member = members.find((candidate) => candidate.userId === id);
  return member ? member.name || member.email || "A member" : id;
}

export function ConnectorActivity({ executions, members, loading, error, credentials, onRefresh, onReconnect }: {
  executions: SerializedAppConnectorExecution[];
  members: SpaceMember[];
  loading: boolean;
  error: string | null;
  credentials: CredentialStoreInput;
  onRefresh: () => void;
  onReconnect: () => void;
}) {
  return (
    <ConnectorSection title="Recent activity" testId="connector-activity"
      action={(
        <ConnectorAction disabled={loading} onClick={onRefresh} title="Refresh connector activity">
          <AnimatedIcon icon={RefreshCw} className={cn("size-3.5", loading && "animate-spin")} /> Refresh
        </ConnectorAction>
      )}>
      <ConnectorRows className={executions.length ? "app-connector-audit" : undefined}>
        {executions.map((execution) => (
          <ExecutionRow key={execution.id} execution={execution} members={members} credentials={credentials}
            onRefresh={onRefresh} onReconnect={onReconnect} />
        ))}
        {executions.length === 0 ? (
          <ConnectorEmpty>{loading ? "Loading activity…" : "Nothing has run yet. Commands this app runs appear here."}</ConnectorEmpty>
        ) : null}
      </ConnectorRows>
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </ConnectorSection>
  );
}

function ExecutionRow({ execution, members, credentials, onRefresh, onReconnect }: {
  execution: SerializedAppConnectorExecution;
  members: SpaceMember[];
  credentials: CredentialStoreInput;
  onRefresh: () => void;
  onReconnect: () => void;
}) {
  const masked = execution.resultSummary === PRIVATE_CONNECTOR_RESULT || execution.reason === PRIVATE_CONNECTOR_RESULT;
  const stopped = execution.status === "failed" || execution.status === "blocked";
  const retry = useMutation({
    mutationKey: ["app-execution-retry", execution.id],
    mutationFn: () => xmatrixApiRequest<{ summary: string; url?: string }>({ method: "POST", token: credentials.token,
      url: WEB_PROXY_ROUTES.space_app_execution_retry(credentials.spaceId, execution.id) }),
    onSettled: () => onRefresh(),
  });
  const ranAgain = retry.data ? `${retry.data.summary}${retry.data.url ? ` — ${retry.data.url}` : ""}` : null;
  const headline = stopped ? remedyHeadline(execution, credentials.connector) : null;
  const who = requesterName(execution, members);
  // Who made the call: the Agent, for the person it ran for, or the person themselves.
  const person = <Face of={{ kind: "user", id: execution.requestedBy, name: who }} size="xs" shape="circle" glass={false} />;
  const caller = (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 align-middle">
      {execution.requestedByAgent ? <>
        <Face of={{ kind: "agent", name: execution.requestedByAgent, harness: execution.requestedByAgentHarness }}
          size="xs" shape="circle" glass={false} />
        <span className="shrink-0 text-foreground">{execution.requestedByAgent}</span>
        <span className="shrink-0">for</span>
      </> : null}
      {person}
      <span className="truncate">{who}</span>
    </span>
  );
  const when = callTime(execution.createdAt);
  const said = stopped ? null : resultLine(execution.resultSummary);
  const command = execution.actionId && execution.actionId !== execution.actionLabel ? execution.actionId : null;
  return (
    <li className="px-3 py-2" data-testid="connector-execution">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 text-[13px] sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,13rem)_5rem]">
        <time className="whitespace-nowrap text-muted-foreground tabular-nums max-sm:hidden" dateTime={execution.createdAt}
          title={`${execution.createdAt} (${relativeTime(execution.createdAt)})`}>{when}</time>
        <span className="min-w-0 truncate">
          <span className="font-medium">{execution.actionLabel || execution.actionId || "Default action"}</span>
          {command ? <code className="ml-2 font-mono text-[12px] text-muted-foreground">{command}</code> : null}
        </span>
        <span className="min-w-0 text-muted-foreground max-sm:hidden">{caller}</span>
        <span className={cn("font-medium sm:text-right", ranAgain ? "text-foreground" : appExecutionStatusClassName(execution.status))}>
          {ranAgain ? "Fixed" : EXECUTION_STATUS_LABELS[execution.status] ?? execution.status}
        </span>
        <span className="col-span-full flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground sm:hidden">
          {caller}<span className="shrink-0">· {when}</span></span>
        {said || (masked && !stopped) ? (
          <span className="col-span-full flex min-w-0 items-center gap-1 truncate text-[12px] text-muted-foreground sm:col-start-2 sm:col-end-5">
            {masked ? <><Lock aria-hidden="true" className="size-3 shrink-0" /> Private result · only {who} can see it</> : said}
          </span>
        ) : null}
      </div>
      {/* A run that stopped says why under its line, then its fix. A private call is private from the
          rest of the Space, not from the person it ran for. */}
      {stopped && !ranAgain ? (
        <div className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere] sm:pl-[7.5rem]">
          {headline ? <span className="block">{headline}</span> : masked ? (
            <PrivateConnectorResult compact channelId={execution.channelId} token={credentials.token}
              messageId={`system:${execution.messageId}:${execution.providerId}`.slice(0, 200)}
              ownerUserId={execution.requestedBy} ownerName={who} />
          ) : execution.reason ? <span className="block first-letter:uppercase">
            {/^[a-z_]+$/u.test(execution.reason) ? execution.reason.replace(/_/g, " ") : execution.reason}</span> : null}
        </div>
      ) : null}
      {ranAgain ? (
        <p className="mt-0.5 line-clamp-2 text-[13px] sm:pl-[7.5rem] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]" data-testid="connector-execution-rerun">
          Ran again: {ranAgain}
        </p>
      ) : stopped ? (
        <div className="sm:pl-[7.5rem]"><ExecutionFix execution={execution} credentials={credentials} retrying={retry.isPending}
          onFixed={() => { if (execution.retryable) retry.mutate(); }} onRetry={() => retry.mutate()} onReconnect={onReconnect} /></div>
      ) : null}
      {retry.error ? (
        <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">
          {userErrorMessage(retry.error, "Couldn't run it again")}
        </p>
      ) : null}
    </li>
  );
}

/** A stopped run's next step, right under it: its remedy, then Retry. */
function ExecutionFix({ execution, credentials, retrying, onFixed, onRetry, onReconnect }: {
  execution: SerializedAppConnectorExecution;
  credentials: CredentialStoreInput;
  retrying: boolean;
  onFixed: () => void;
  onRetry: () => void;
  onReconnect: () => void;
}) {
  const { connector } = credentials;
  const { save } = useCredentialStore(credentials);
  const [editing, setEditing] = useState(false);
  const bridge = getDesktopBridge();
  const remedy = execution.remedy;
  const field = remedy?.kind === "credential"
    ? connector.credentials?.find((candidate) => candidate.id === remedy.field) : undefined;
  // The desktop app signs in on the service's own page and saves the session it then holds.
  const signIn = useMutation({
    mutationKey: ["connector-sign-in", connector.id, execution.id],
    mutationFn: async () => {
      const outcome = await bridge!.serviceSignIn!(field!.signIn!, { fresh: false });
      if (outcome.status !== "signed-in") return false;
      await save.mutateAsync({ fields: { [field!.id]: outcome.session } });
      return true;
    },
    onSuccess: (signedIn) => { if (signedIn) onFixed(); },
  });
  const busy = retrying || save.isPending || signIn.isPending;
  const error = userErrorMessage(signIn.error, "Couldn't sign in to the service") ??
    userErrorMessage(save.error, "Couldn't save the credentials");
  const spinner = <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" />;
  return (
    <div className="mt-2 space-y-2" data-testid="connector-execution-fix">
      <div className="flex flex-wrap items-center gap-2">
        {field?.signIn && bridge?.serviceSignIn ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={() => signIn.mutate()}>
            {signIn.isPending ? spinner : <LogIn className="size-3.5" />} Sign in to {connector.name}
          </button>
        ) : field && !editing ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={() => setEditing(true)}>
            {field.signIn ? `Sign in to ${connector.name} again` : `Replace ${field.label}`}
          </button>
        ) : remedy?.kind === "reconnect" ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={onReconnect}>
            Reconnect {connector.name}
          </button>
        ) : null}
        {execution.retryable && !editing ? (
          <ConnectorAction disabled={busy} onClick={onRetry}>
            {retrying ? spinner : <RotateCcw className="size-3.5" />} Retry
          </ConnectorAction>
        ) : null}
      </div>
      {field && editing ? (
        <CredentialValueForm field={field} busy={busy} saving={save.isPending} autoFocus
          submitLabel={execution.retryable ? "Save and retry" : "Save"}
          save={(value) => save.mutateAsync({ fields: { [field.id]: value } }).then(() => { setEditing(false); onFixed(); })}>
          <ConnectorAction onClick={() => setEditing(false)}>Cancel</ConnectorAction>
          {field.description ? <p className="basis-full text-[12px] leading-[1.45] text-muted-foreground">{field.description}</p> : null}
        </CredentialValueForm>
      ) : null}
      {error ? <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
