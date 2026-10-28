"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, KeyRound, Loader2, LogIn, RefreshCw } from "lucide-react";
import { WEB_PROXY_ROUTES, type SerializedAppConnectorConnection } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { Input } from "@/components/ui/input";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { getDesktopBridge } from "@/lib/desktop/bridge";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import {
  ConnectorAction, ConnectorCopyLine, ConnectorField, ConnectorFold, ConnectorRow, ConnectorRows, ConnectorSection,
} from "./connector-page";

/* A connection's credentials (docs/design/connector-platform.md §3.2). Values
   an admin writes are never read back; the ingress URL and secrets the Hub
   generated are shown so they can be pasted into the provider. The page shows
   them three ways: the form that connects the app, the saved fields of a
   connected app (each replaced on its own), and where the provider delivers
   its events. All three read one stored view. */

interface CredentialView {
  credentialFields?: string[];
  ingressUrl?: string;
  generated?: Record<string, string>;
}

const INGRESS_KEY_FIELD = "ingressKey";

/** Whether a provider posts its events to an ingress URL; Hub-produced events have none. */
function takesIngress(connector: AppConnectorManifest): boolean {
  return Boolean(connector.events && connector.events.ingress !== false);
}

export function connectorTakesCredentials(connector: AppConnectorManifest): boolean {
  return Boolean(takesIngress(connector) || connector.credentials?.some(field => !field.managed));
}

/** Fields an admin types, as opposed to ones the Hub mints or OAuth fills in. */
export function connectorWritableCredentials(connector: AppConnectorManifest) {
  return (connector.credentials ?? []).filter((field) => !field.generated && !field.managed);
}

/**
 * A disconnected app whose typed credentials are all still saved connects again
 * by a check alone; Disconnect keeps them (only OAuth grants are forgotten).
 */
export function connectorReconnectsWithSavedCredentials(connector: AppConnectorManifest,
  connection: { status: string; credentialFields?: string[] } | undefined): boolean {
  const writable = connectorWritableCredentials(connector);
  const saved = new Set(connection?.credentialFields ?? []);
  return connection?.status === "disconnected" && writable.some((field) => saved.has(field.id))
    && writable.every((field) => !field.required || saved.has(field.id));
}

/** Whether the Hub mints values (an ingress URL or a secret) for this app. */
export function connectorGeneratesCredentials(connector: AppConnectorManifest): boolean {
  return Boolean(takesIngress(connector) || connector.credentials?.some((field) => field.generated && !field.managed));
}

export type CredentialStoreInput = {
  connector: AppConnectorManifest;
  connection?: SerializedAppConnectorConnection;
  spaceId: string;
  token: string;
  userId: string;
  /** Creates the connection row the credentials are stored on. */
  beforeSave: () => Promise<void>;
  /** Checks the saved credentials with the provider. */
  afterSave: () => Promise<void>;
};

export function useCredentialStore({ connector, connection, spaceId, token, userId, beforeSave, afterSave }: CredentialStoreInput) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "app-connection-credentials", [spaceId, connector.id]);
  const url = WEB_PROXY_ROUTES.space_app_connection_credentials(spaceId, connector.id);
  const view = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<CredentialView>({ url, token, signal }),
  });
  const save = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: async (body: { fields?: Record<string, string | null>; regenerate?: string[] }) => {
      await beforeSave();
      return xmatrixApiRequest<CredentialView>({ url, method: "PUT", token, body });
    },
    onSuccess: async (payload) => {
      queryClient.setQueryData(key, payload);
      await afterSave();
    },
  });
  const stored = new Set(view.data?.credentialFields ?? connection?.credentialFields ?? []);
  return { view, save, stored };
}

/**
 * The form that connects an app by its credentials: the required fields, the
 * optional ones folded under them, and Save and connect as the page's one
 * solid action.
 */
export function ConnectorCredentialForm({ submitLabel = "Save and connect", ...input }: CredentialStoreInput & {
  submitLabel?: string;
}) {
  const { connector } = input;
  const { view, save, stored } = useCredentialStore(input);
  const [draft, setDraft] = useState<Record<string, string>>({});
  // The desktop app signs in on the service's own page and saves the session it then holds.
  const bridge = getDesktopBridge();
  const signIn = useMutation({
    mutationKey: ["connector-sign-in", connector.id],
    mutationFn: async ({ field, service, fresh }: { field: string; service: string; fresh: boolean }) => {
      const outcome = await bridge!.serviceSignIn!(service, { fresh });
      if (outcome.status === "signed-in") await save.mutateAsync({ fields: { [field]: outcome.session } });
    },
  });
  const writable = connectorWritableCredentials(connector);
  // Required fields lead; when none is required every field is shown, since any of them may be the one.
  const lead = writable.some((field) => field.required) ? writable.filter((field) => field.required) : writable;
  const rest = writable.filter((field) => !lead.includes(field));
  const pending = save.isPending || view.isFetching || signIn.isPending;
  const error = userErrorMessage(save.error, "Couldn't save the credentials") ??
    userErrorMessage(signIn.error, "Couldn't sign in to the service") ??
    userErrorMessage(view.error, "Couldn't load the credentials");
  const field = (candidate: (typeof writable)[number]) => (
    <div key={candidate.id}>
      {/* Outside the label, which would otherwise pass its clicks to the button. */}
      {candidate.signIn && bridge?.serviceSignIn ? (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <button type="button" disabled={pending} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={() => signIn.mutate({ field: candidate.id, service: candidate.signIn!, fresh: false })}>
            {signIn.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />}
            Sign in to {connector.name}
          </button>
          {stored.has(candidate.id) ? (
            <ConnectorAction disabled={pending}
              onClick={() => signIn.mutate({ field: candidate.id, service: candidate.signIn!, fresh: true })}>
              Use another account
            </ConnectorAction>
          ) : null}
        </div>
      ) : null}
      <ConnectorField label={candidate.label} help={candidate.description} required={candidate.required}
        saved={stored.has(candidate.id)}>
        <Input type="password" autoComplete="off" value={draft[candidate.id] ?? ""}
          placeholder={stored.has(candidate.id) ? "Enter a new value to replace it" : ""}
          onChange={(event) => setDraft((current) => ({ ...current, [candidate.id]: event.target.value }))} />
      </ConnectorField>
    </div>
  );

  return (
    <form className="space-y-4" data-testid="connector-credential-form" onSubmit={(event) => {
      event.preventDefault();
      const fields = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
      if (Object.keys(fields).length > 0) save.mutate({ fields }, { onSuccess: () => setDraft({}) });
    }}>
      {lead.map(field)}
      {rest.length > 0 ? (
        <ConnectorFold summary={`More fields (${rest.length})`}>
          <div className="space-y-4 pt-2">{rest.map(field)}</div>
        </ConnectorFold>
      ) : null}
      {error ? <p role="alert" className="text-[13px] font-medium text-destructive">{error}</p> : null}
      <button type="submit" disabled={pending || !Object.values(draft).some((value) => value.trim())}
        className={actionClass({ variant: "primary", size: "md" })}>
        {save.isPending ? <AnimatedIcon icon={Loader2} className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
        {submitLabel}
      </button>
    </form>
  );
}

/**
 * A connected app's saved credentials, a row each: whether it is set, and
 * Replace, which opens that one field. A value is never shown back.
 */
export function ConnectorCredentialRows(input: CredentialStoreInput) {
  const { connector } = input;
  const { view, save, stored } = useCredentialStore(input);
  const [editing, setEditing] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const error = userErrorMessage(save.error, "Couldn't save the credentials") ??
    userErrorMessage(view.error, "Couldn't load the credentials");
  return (
    <>
      <ConnectorRows testId="connector-credential-rows">
        {connectorWritableCredentials(connector).map((field) => (
          <ConnectorRow key={field.id} title={field.label}
            meta={stored.has(field.id) ? "Saved" : field.required ? "Required, not set" : "Not set"}
            trailing={editing === field.id ? null : (
              <ConnectorAction disabled={save.isPending} onClick={() => { setEditing(field.id); setValue(""); }}>
                {stored.has(field.id) ? "Replace" : "Add"}
              </ConnectorAction>
            )}>
            {editing === field.id ? (
              <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(event) => {
                event.preventDefault();
                if (!value.trim()) return;
                save.mutate({ fields: { [field.id]: value } }, { onSuccess: () => { setEditing(null); setValue(""); } });
              }}>
                <Input type="password" autoComplete="off" autoFocus value={value} aria-label={field.label}
                  className="min-w-0 flex-1 basis-56" onChange={(event) => setValue(event.target.value)} />
                <button type="submit" disabled={save.isPending || !value.trim()}
                  className={actionClass({ variant: "secondary", size: "sm" })}>
                  {save.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : null} Save
                </button>
                <ConnectorAction onClick={() => setEditing(null)}>Cancel</ConnectorAction>
                {field.description ? <p className="basis-full text-[12px] leading-[1.45] text-muted-foreground">{field.description}</p> : null}
              </form>
            ) : null}
          </ConnectorRow>
        ))}
      </ConnectorRows>
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </>
  );
}

/**
 * Where the provider delivers its events: the ingress URL and any secret the
 * Hub made, to paste into the provider, and Rotate for when one leaked.
 */
export function ConnectorEventDelivery({ note, ...input }: CredentialStoreInput & { note?: string }) {
  const { connector } = input;
  const { view, save } = useCredentialStore(input);
  const ingress = takesIngress(connector);
  const generated = (connector.credentials ?? []).filter((field) => field.generated && !field.managed);
  const missingIngress = ingress && !view.data?.ingressUrl;
  const error = userErrorMessage(save.error, "Couldn't save the credentials") ??
    userErrorMessage(view.error, "Couldn't load the credentials");
  const busy = save.isPending || view.isFetching;
  return (
    <ConnectorSection title="Event delivery" testId="connector-event-delivery"
      note={note ?? (missingIngress
        ? `Generate an ingress URL to start receiving ${connector.name} events.`
        : `Paste these into ${connector.name}. Anyone with the URL can post events, so treat it as a secret.`)}
      action={missingIngress ? null : (
        <ConnectorAction disabled={busy} onClick={() => {
          if (!window.confirm(`Rotate the ${connector.name} ingress URL and secrets? The provider stops delivering until you paste the new values.`)) return;
          save.mutate({ regenerate: [...(ingress ? [INGRESS_KEY_FIELD] : []), ...generated.map((field) => field.id)] });
        }}>
          {save.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Rotate URL and secrets
        </ConnectorAction>
      )}>
      {missingIngress ? (
        <button type="button" disabled={busy} onClick={() => save.mutate({})}
          className={actionClass({ variant: "secondary", size: "sm" }, "mt-1")}>
          {save.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Generate ingress URL
        </button>
      ) : (
        <ConnectorRows>
          {view.data?.ingressUrl ? <SecretRow label="Ingress URL" value={view.data.ingressUrl} /> : null}
          {generated.map((field) => view.data?.generated?.[field.id]
            ? <SecretRow key={field.id} label={field.label} value={view.data.generated[field.id]!} help={field.description} />
            : null)}
        </ConnectorRows>
      )}
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </ConnectorSection>
  );
}

function SecretRow({ label, value, help }: { label: string; value: string; help?: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <ConnectorRow title={label} meta={help}
      trailing={(
        <ConnectorAction aria-label={revealed ? `Hide ${label}` : `Show ${label}`} onClick={() => setRevealed((shown) => !shown)}>
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />} {revealed ? "Hide" : "Show"}
        </ConnectorAction>
      )}>
      <div className="mt-1.5">
        <ConnectorCopyLine value={value} label={label} display={revealed ? value : "•".repeat(32)} />
      </div>
    </ConnectorRow>
  );
}
