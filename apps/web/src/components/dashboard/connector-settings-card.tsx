"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, LogIn } from "lucide-react";
import {
  appViewAddress, connectorFixSettled, connectorReceiptFixesOf, SETTINGS_REQUEST_KEY, settingAddress, WEB_PROXY_ROUTES,
  type ConnectorReceiptFix, type SerializedAppConnectorConnection,
} from "@xmatrix/protocol";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { actionClass } from "@/components/ui/action-tone";
import { APP_CONNECTORS } from "@/lib/app-connectors";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { CredentialValueForm, useCredentialStore } from "./connector-credentials";

/** While a fix is open, everyone's card notices it being made elsewhere (the Apps page, another card). */
const OPEN_REFRESH_MS = 30_000;

/** A card an Agent posted to ask for settings: who asked, why, and the settings. Read only from the Hub's own metadata. */
export function settingsRequestOf(metadata: Record<string, unknown> | undefined):
  { agentName: string; reason?: string; fixes: ConnectorReceiptFix[] } | null {
  const value = metadata?.[SETTINGS_REQUEST_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fixes = connectorReceiptFixesOf(metadata);
  if (!fixes.length) return null;
  const request = value as Record<string, unknown>;
  const text = (field: unknown, limit: number) => typeof field === "string" && field.trim() ? field.trim().slice(0, limit) : undefined;
  const reason = text(request.reason, 500);
  return { agentName: text(request.agentName, 120) ?? "", ...(reason ? { reason } : {}), fixes };
}

/**
 * The setting a stopped connector command needs, as its own card under the
 * receipt: what to fix, where it stands now, and the control that fixes it.
 * Values go straight to the connection's credential store and are checked
 * there; the conversation only ever shows the outcome. People who cannot
 * change the connection see who can.
 */
export function ConnectorSettingsCard({ fix, receiptSentAt, spaceId, token, userId, suggestedBy }: {
  fix: ConnectorReceiptFix;
  /** The Agent whose suggested value the card offers for a plain field. */
  suggestedBy?: string;
  receiptSentAt: string;
  spaceId: string;
  token: string;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const connector = APP_CONNECTORS.find((candidate) => candidate.id === fix.providerId);
  const connectionKey = xmatrixQueryKeys.domain({ userId }, "app-connections", [spaceId]);
  const connections = useQuery({
    queryKey: connectionKey,
    queryFn: ({ signal }) => xmatrixApiRequest<{ connections?: SerializedAppConnectorConnection[] }>({
      url: WEB_PROXY_ROUTES.space_app_connections(spaceId), token, signal,
    }).then((payload) => payload.connections ?? []),
    refetchInterval: (query) => connectorFixSettled(fix,
      query.state.data?.find((candidate) => candidate.providerId === fix.providerId), receiptSentAt) ? false : OPEN_REFRESH_MS,
  });
  const connection = connections.data?.find((candidate) => candidate.providerId === fix.providerId);
  const settled = connectorFixSettled(fix, connection, receiptSentAt);
  const check = useMutation({
    mutationKey: ["connector-settings-check", fix.executionId],
    mutationFn: () => xmatrixApiRequest<{ connection?: SerializedAppConnectorConnection }>({ method: "POST", token,
      url: WEB_PROXY_ROUTES.space_app_connection_check(spaceId, fix.providerId) }),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: connectionKey }); },
  });
  const rerun = useMutation({
    mutationKey: ["connector-settings-rerun", fix.executionId],
    mutationFn: (executionId: string) => xmatrixApiRequest<{ summary: string }>({ method: "POST", token,
      url: WEB_PROXY_ROUTES.space_app_execution_retry(spaceId, executionId) }),
  });
  const credentials = useCredentialStore({ connector: connector!, connection, spaceId, token, userId,
    // An Agent may ask for an App not yet connected: its credentials need the connection's row first.
    beforeSave: async () => {
      if (connection) return;
      await xmatrixApiRequest({ method: "PATCH", token, url: WEB_PROXY_ROUTES.space_app_connection(spaceId, fix.providerId),
        body: { providerId: fix.providerId, providerName: connector!.name, status: "disconnected" } });
    },
    afterSave: async () => {
      const checked = await check.mutateAsync();
      // A read runs again by itself once the connection passes; anything else waits for its caller.
      if (checked.connection?.status === "configured" && fix.executionId) rerun.mutate(fix.executionId);
    } });
  const bridge = getDesktopBridge();
  const field = fix.remedy.kind === "credential"
    ? connector?.credentials?.find((candidate) => candidate.id === (fix.remedy as { field: string }).field) : undefined;
  const signIn = useMutation({
    mutationKey: ["connector-settings-sign-in", fix.executionId],
    mutationFn: async () => {
      const outcome = await bridge!.serviceSignIn!(field!.signIn!, { fresh: false });
      if (outcome.status !== "signed-in") return;
      await credentials.save.mutateAsync({ fields: { [field!.id]: outcome.session } });
    },
  });
  if (!connector) return null;
  // Only a Space admin may read or change a connection's credentials.
  const canChange = credentials.view.isSuccess;
  const busy = credentials.save.isPending || check.isPending || signIn.isPending;
  const error = userErrorMessage(signIn.error, "Couldn't sign in to the service") ??
    userErrorMessage(credentials.save.error, "Couldn't save the credentials") ??
    (check.data?.connection?.status === "error" ? check.data.connection.error ?? `${connector.name} refused it` : null);
  const what = fix.remedy.kind === "reconnect" ? `Connect ${connector.name} again`
    : field?.signIn ? `Sign in to ${connector.name}` : `${connector.name} needs ${field?.label ?? "a credential"}`;
  const address = settingAddress(fix);
  const current = field?.plain ? credentials.view.data?.plain?.[field.id] : undefined;
  const state = settled ? current ?? "Checked" : busy ? "Checking…" : fix.remedy.kind === "reconnect" ? "Not connected"
    : field?.signIn ? "Not signed in" : "Missing";
  const spinner = <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" />;
  return (
    <section className="app-paper-card app-settings-card mt-2 w-full max-w-2xl" data-settings-card={settled ? "settled" : "open"}
      aria-label={what}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-[14px] font-semibold">{settled ? `${connector.name} is ready` : what}</p>
        <span className="text-[12px] text-muted-foreground">Settings{fix.executionId ? ` · ${fix.actionId}` : ""}</span>
      </div>
      <div className="app-settings-card-row mt-2">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">{fix.remedy.kind === "reconnect" ? "Connection" : field?.label ?? fix.remedy.field}</p>
            <p className="truncate font-mono text-[11.5px] text-muted-foreground">{address}</p>
          </div>
          <span className="app-settings-card-state inline-flex items-center gap-1.5 text-[12.5px] font-semibold"
            data-settled={settled ? "true" : "false"} role="status">
            <span aria-hidden="true" className="app-settings-card-dot" />{state}
          </span>
        </div>
        {!settled && canChange ? (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {fix.remedy.kind === "reconnect" ? (
              <a className={actionClass({ variant: "primary", size: "sm" })} href={appViewAddress(spaceId, "apps", connector.id)}>
                Reconnect {connector.name}
              </a>
            ) : field?.signIn && bridge?.serviceSignIn ? (
              <button type="button" disabled={busy} className={actionClass({ variant: "primary", size: "sm" })}
                onClick={() => signIn.mutate()}>
                {signIn.isPending ? spinner : <LogIn className="size-3.5" />} Sign in to {connector.name}
              </button>
            ) : field ? (
              <CredentialValueForm field={field} busy={busy} saving={credentials.save.isPending || check.isPending}
                submitLabel={fix.proposed ? "Confirm and check" : "Save and check"} variant="primary"
                className="flex min-w-0 flex-1 flex-wrap items-center gap-2" plain={field.plain}
                initialValue={fix.proposed ?? current} key={fix.proposed ?? current ?? ""}
                save={(value) => credentials.save.mutateAsync({ fields: { [field.id]: value } })}>
                {fix.proposed ? (
                  <p className="basis-full text-[12px] text-muted-foreground">
                    Suggested by {suggestedBy || "the Agent"}; it is saved only when you confirm.
                  </p>
                ) : null}
              </CredentialValueForm>
            ) : null}
            {field?.signIn ? (
              <p className="basis-full text-[12px] text-muted-foreground">
                {bridge?.serviceSignIn ? `You sign in on ${connector.name}'s own page; your password never reaches xMatrix.`
                  : `Sign in from the xMatrix app, or paste the Cookie header of a signed-in ${connector.name} page.`}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
      {!settled && !canChange && !credentials.view.isPending ? (
        <p className="mt-2 text-[13px] text-muted-foreground">A Space admin can fix this.</p>
      ) : null}
      {settled && rerun.data ? <p className="mt-2 text-[13px] text-muted-foreground">Ran it again: {rerun.data.summary}</p> : null}
      {error ? <p role="alert" className="mt-2 text-[13px] font-medium text-destructive">{error}</p> : null}
    </section>
  );
}
