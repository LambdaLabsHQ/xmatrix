"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { WEB_PROXY_ROUTES, type SerializedAppConnectorConnection } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";

/* A connection's credentials (docs/design/connector-platform.md §3.2). Values
   an admin writes are never read back; the ingress URL and secrets the Hub
   generated are shown so they can be pasted into the provider. */

interface CredentialView {
  credentialFields?: string[];
  ingressUrl?: string;
  generated?: Record<string, string>;
}

const INGRESS_KEY_FIELD = "ingressKey";

export function connectorTakesCredentials(connector: AppConnectorManifest): boolean {
  return Boolean(connector.events || connector.credentials?.some(field => !field.managed));
}

/** Fields an admin types, as opposed to ones the Hub mints or OAuth fills in. */
export function connectorWritableCredentials(connector: AppConnectorManifest) {
  return (connector.credentials ?? []).filter((field) => !field.generated && !field.managed);
}

/** Whether the Hub mints values (an ingress URL or a secret) for this app. */
export function connectorGeneratesCredentials(connector: AppConnectorManifest): boolean {
  return Boolean(connector.events || connector.credentials?.some((field) => field.generated && !field.managed));
}

function CopyValue({ label, value, secret }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState(!secret);
  return (
    <div>
      <p className="mb-1 text-xs font-bold text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <Input readOnly value={revealed ? value : "•".repeat(24)} className="font-mono text-xs"
          aria-label={label} onFocus={(event) => event.currentTarget.select()} />
        {secret ? (
          <Button size="sm" variant="ghost" type="button" onClick={() => setRevealed((value) => !value)}>
            {revealed ? "Hide" : "Show"}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" type="button" aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          })}>
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
    </div>
  );
}

export function ConnectorCredentials({ connector, connection, connected, spaceId, token, userId, beforeSave, afterSave }: {
  connector: AppConnectorManifest;
  connection?: SerializedAppConnectorConnection;
  /** Before it is connected, saving is how the app connects. */
  connected: boolean;
  spaceId: string;
  token: string;
  userId: string;
  /** Creates the connection row the credentials are stored on. */
  beforeSave: () => Promise<void>;
  /** Checks the saved credentials with the provider. */
  afterSave: () => Promise<void>;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "app-connection-credentials", [spaceId, connector.id]);
  const url = WEB_PROXY_ROUTES.space_app_connection_credentials(spaceId, connector.id);
  const view = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<CredentialView>({ url, token, signal }),
  });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: async (body: { fields?: Record<string, string | null>; regenerate?: string[] }) => {
      await beforeSave();
      return xmatrixApiRequest<CredentialView>({ url, method: "PUT", token, body });
    },
    onSuccess: async (payload) => {
      queryClient.setQueryData(key, payload);
      setDraft({});
      await afterSave();
    },
  });
  const writable = connectorWritableCredentials(connector);
  const generated = (connector.credentials ?? []).filter((field) => field.generated && !field.managed);
  const stored = new Set(view.data?.credentialFields ?? connection?.credentialFields ?? []);
  const missingIngress = connector.events && !view.data?.ingressUrl;
  const pending = save.isPending || view.isFetching;
  const error = save.error?.message ?? view.error?.message;

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
      {connector.events ? (
        view.data?.ingressUrl ? (
          <div className="space-y-2">
            <CopyValue label="Ingress URL" value={view.data.ingressUrl} secret />
            <p className="text-xs leading-5 text-muted-foreground">
              Paste this into {connector.name} as the webhook URL. Anyone with it can post events, so treat it as a secret.
            </p>
          </div>
        ) : (
          <p className="text-xs leading-5 text-muted-foreground">
            Generate an ingress URL to start receiving {connector.name} events.
          </p>
        )
      ) : null}
      {generated.map((field) => view.data?.generated?.[field.id] ? (
        <div key={field.id} className="space-y-1">
          <CopyValue label={field.label} value={view.data.generated[field.id]!} secret />
          <p className="text-xs leading-5 text-muted-foreground">{field.description}</p>
        </div>
      ) : null)}
      {writable.length > 0 ? (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          const fields = Object.fromEntries(Object.entries(draft).filter(([, value]) => value.trim()));
          if (Object.keys(fields).length > 0) save.mutate({ fields });
        }}>
          {writable.map((field) => (
            <label key={field.id} className="block">
              <span className="mb-1 flex items-center gap-2 text-xs font-bold text-muted-foreground">
                {field.label}{field.required ? " *" : ""}
                {stored.has(field.id) ? <span className="font-normal">· saved</span> : null}
              </span>
              <Input type="password" autoComplete="off" value={draft[field.id] ?? ""}
                placeholder={stored.has(field.id) ? "Saved — enter a new value to replace it" : ""}
                onChange={(event) => setDraft((current) => ({ ...current, [field.id]: event.target.value }))} />
              <span className="mt-1 block text-xs leading-5 text-muted-foreground">{field.description}</span>
            </label>
          ))}
          <Button size="sm" type="submit" disabled={pending || !Object.values(draft).some((value) => value.trim())}>
            {save.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} {connected ? "Save credentials" : "Save and connect"}
          </Button>
        </form>
      ) : null}
      {connector.events || generated.length > 0 ? (
        <Button size="sm" variant="outline" type="button" disabled={pending}
          onClick={() => {
            if (missingIngress) return save.mutate({});
            if (!window.confirm(`Rotate the ${connector.name} ingress URL and secrets? The provider stops delivering until you paste the new values.`)) return;
            save.mutate({ regenerate: [...(connector.events ? [INGRESS_KEY_FIELD] : []), ...generated.map((field) => field.id)] });
          }}>
          {save.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {missingIngress ? "Generate ingress URL" : "Rotate URL and secrets"}
        </Button>
      ) : null}
    </div>
  );
}
