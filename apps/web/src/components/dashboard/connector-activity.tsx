"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, LogIn, RefreshCw, RotateCcw } from "lucide-react";
import {
  PRIVATE_CONNECTOR_RESULT,
  WEB_PROXY_ROUTES,
  type SerializedAppConnectorExecution,
  type SpaceMember,
} from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { Input } from "@/components/ui/input";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { cn } from "@/lib/utils";
import { userErrorMessage } from "@/lib/user-facing-error";
import { useCredentialStore, type CredentialStoreInput } from "./connector-credentials";
import { ConnectorAction, ConnectorEmpty, ConnectorRows, ConnectorSection } from "./connector-page";
import { PrivateConnectorResult } from "./private-connector-result";
import { relativeTime } from "./workspace-shell-presence";

/* What the App ran, newest first, as an audit list: one line per run saying
   what ran, who asked, when and how it ended; what it returned stays in the
   conversation it ran in. A failure is fixed where it shows: the row
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
      <ConnectorRows>
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
  const when = relativeTime(execution.createdAt);
  return (
    <li className="py-1.5" data-testid="connector-execution">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 text-[13px] sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)_5.5rem_5rem]">
        <span className="truncate text-sm font-semibold">{execution.actionLabel || execution.actionId || "Default action"}</span>
        <span className="truncate text-muted-foreground max-sm:hidden">{who}</span>
        <time className="truncate text-muted-foreground max-sm:hidden" dateTime={execution.createdAt} title={execution.createdAt}>{when}</time>
        <span className={cn("font-semibold sm:text-right", ranAgain ? "text-foreground" : appExecutionStatusClassName(execution.status))}>
          {ranAgain ? "Fixed" : EXECUTION_STATUS_LABELS[execution.status] ?? execution.status}
        </span>
        <span className="col-span-full truncate text-muted-foreground sm:hidden">{who} · {when}</span>
      </div>
      {/* Only a run that stopped says more: why, and its fix. A private call is private from the
          rest of the Space, not from the person it ran for. */}
      {stopped && !ranAgain ? (
        <div className="mt-0.5 text-[13px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]">
          {headline ? <span className="block">{headline}</span> : masked ? (
            <PrivateConnectorResult compact channelId={execution.channelId} token={credentials.token}
              messageId={`system:${execution.messageId}:${execution.providerId}`.slice(0, 200)}
              ownerUserId={execution.requestedBy} ownerName={who} />
          ) : execution.reason ? <span className="block first-letter:uppercase">
            {/^[a-z_]+$/u.test(execution.reason) ? execution.reason.replace(/_/g, " ") : execution.reason}</span> : null}
        </div>
      ) : null}
      {ranAgain ? (
        <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.45] text-muted-foreground [overflow-wrap:anywhere]" data-testid="connector-execution-rerun">
          Ran again: {ranAgain}
        </p>
      ) : stopped ? (
        <ExecutionFix execution={execution} credentials={credentials} retrying={retry.isPending}
          onFixed={() => { if (execution.retryable) retry.mutate(); }} onRetry={() => retry.mutate()} onReconnect={onReconnect} />
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
  const [value, setValue] = useState<string | null>(null);
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
        ) : field && value === null ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={() => setValue("")}>
            {field.signIn ? `Sign in to ${connector.name} again` : `Replace ${field.label}`}
          </button>
        ) : remedy?.kind === "reconnect" ? (
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={onReconnect}>
            Reconnect {connector.name}
          </button>
        ) : null}
        {execution.retryable && value === null ? (
          <ConnectorAction disabled={busy} onClick={onRetry}>
            {retrying ? spinner : <RotateCcw className="size-3.5" />} Retry
          </ConnectorAction>
        ) : null}
      </div>
      {field && value !== null ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          if (!value.trim()) return;
          save.mutate({ fields: { [field.id]: value } }, { onSuccess: () => { setValue(null); onFixed(); } });
        }}>
          <Input type="password" autoComplete="off" autoFocus value={value} aria-label={field.label} placeholder={field.label}
            className="min-w-0 flex-1 basis-56" onChange={(event) => setValue(event.target.value)} />
          <button type="submit" disabled={busy || !value.trim()} className={actionClass({ variant: "secondary", size: "sm" })}>
            {save.isPending ? spinner : null} {execution.retryable ? "Save and retry" : "Save"}
          </button>
          <ConnectorAction onClick={() => setValue(null)}>Cancel</ConnectorAction>
          {field.description ? <p className="basis-full text-[12px] leading-[1.45] text-muted-foreground">{field.description}</p> : null}
        </form>
      ) : null}
      {error ? <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p> : null}
    </div>
  );
}
