"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { WEB_PROXY_ROUTES, type ConnectorActionPolicy, type ChannelSnapshot } from "@xmatrix/protocol";
import { GlassSelect } from "@/components/ui/glass-select";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { channelTitle } from "@/components/dashboard/channel-links";
import { ConnectorAction, ConnectorEmpty, ConnectorFold, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";

/* Action policy (docs/design/connector-platform.md §3.5): whether each write
   action runs, asks for approval or is off. Space admins set it once for the
   connection; a write action nobody set keeps the app's own default. Channel
   rules are no longer made: one written before still overrides the setting in
   its Channel, so it stays listed until someone removes it. */

interface PolicyRow { channelId: string; actionId: string; mode: ConnectorActionPolicy }
/** A write action's connection default; `inherited` when it is still the app's own. */
interface DefaultRow { actionId: string; mode: ConnectorActionPolicy; inherited: boolean }

const RULE_LABELS: Record<ConnectorActionPolicy, string> = { allow: "Allowed", ask: "Asks first", disallow: "Disallowed" };
const CHOICE_LABELS: Record<ConnectorActionPolicy, string> = { allow: "Allow", ask: "Ask first", disallow: "Disallow" };
export function connectorWriteActions(connector: AppConnectorManifest) {
  return connector.actions.filter((action) => action.effect === "write");
}

/** One mode for several actions, or null when they differ. */
function sharedMode(rows: DefaultRow[]): ConnectorActionPolicy | null {
  return rows.every((row) => row.mode === rows[0]?.mode) ? rows[0]?.mode ?? null : null;
}

export function ConnectorPolicy({ connector, channels, spaceId, token, userId }: {
  connector: AppConnectorManifest;
  channels: ChannelSnapshot[];
  spaceId: string;
  token: string;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "app-connection-policies", [spaceId, connector.id]);
  const url = WEB_PROXY_ROUTES.space_app_connection_policies(spaceId, connector.id);
  const policies = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<{ policies?: PolicyRow[]; defaults?: DefaultRow[] }>({ url, token, signal })
      .then((payload) => {
        if (!payload.defaults) throw new Error("The Hub did not report this app's connection defaults");
        return { rules: payload.policies ?? [], defaults: payload.defaults };
      }),
  });
  const write = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: (body: { channelId: string; actionId: string; mode: ConnectorActionPolicy | null }
      | { scope: "connection"; actionIds: string[]; mode: ConnectorActionPolicy | null }) =>
      xmatrixApiRequest({ url, method: "PUT", token, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const actions = connectorWriteActions(connector);
  const channelName = (id: string) => { const channel = channels.find((candidate) => candidate.id === id); return channel ? channelTitle(channel) : id; };
  const action = (id: string) => actions.find((candidate) => candidate.id === id);
  const modes: ConnectorActionPolicy[] = ["allow", ...(connector.id === "github" ? [] : ["ask" as const]), "disallow"];
  const defaults = policies.data?.defaults ?? [];
  const rules = policies.data?.rules ?? [];
  const everywhere = sharedMode(defaults);
  const setDefault = (actionIds: string[], value: ConnectorActionPolicy | null) =>
    write.mutate({ scope: "connection", actionIds, mode: value });
  const modeOptions = modes.map((value) => ({ value, label: CHOICE_LABELS[value] }));
  const defaultActionRow = (row: DefaultRow) => (
      <ConnectorRow key={row.actionId} testId="connector-policy-default" title={action(row.actionId)?.label ?? row.actionId}
        meta={row.inherited ? "The app's default" : "Set for this Space"}
        trailing={<>
          <GlassSelect value={row.mode} aria-label={action(row.actionId)?.label ?? row.actionId} disabled={write.isPending}
            onChange={(value) => setDefault([row.actionId], value as ConnectorActionPolicy)} options={modeOptions} />
          {row.inherited ? null : (
            <ConnectorAction title="Back to the app's default" disabled={write.isPending} onClick={() => setDefault([row.actionId], null)}>Reset</ConnectorAction>
          )}
        </>} />
  );
  const error = userErrorMessage(write.error ?? policies.error, "Couldn't save the app settings");

  return (
    <ConnectorSection title="Permissions" testId="connector-policy"
      note={`What agents may do with ${connector.name}. Ask first sends each request to a Space admin to approve.`}>
      <ConnectorRows testId="connector-policy-defaults">
        {defaults.length > 1 ? (
          <ConnectorRow title="Every action" meta={actions.map((candidate) => candidate.label).join(", ")}
            trailing={(
              <GlassSelect value={everywhere ?? ""} placeholder="Mixed" aria-label="Every action" disabled={write.isPending}
                onChange={(value) => setDefault(defaults.map((row) => row.actionId), value as ConnectorActionPolicy)} options={modeOptions} />
            )} />
        ) : null}
      </ConnectorRows>
      {defaults.length > 1 ? (
        <ConnectorFold summary="Set each action" testId="connector-policy-each">
          <ConnectorRows>{defaults.map(defaultActionRow)}</ConnectorRows>
        </ConnectorFold>
      ) : <ConnectorRows>{defaults.map(defaultActionRow)}</ConnectorRows>}
      {rules.length ? (
        <ConnectorRows testId="connector-policy-rules">
          <ConnectorEmpty>Older channel rules still override the setting above in their channel. Remove them to use it everywhere.</ConnectorEmpty>
          {rules.map((row) => (
            <ConnectorRow key={`${row.actionId}:${row.channelId}`} testId="connector-policy-rule"
              title={action(row.actionId)?.label ?? row.actionId}
              meta={<>In #{channelName(row.channelId)} · <span className={row.mode === "disallow" ? "text-destructive" : "text-foreground"}>
                {RULE_LABELS[row.mode]}</span></>}
              trailing={(
                <ConnectorAction aria-label={`Remove the ${row.actionId} rule in ${channelName(row.channelId)}`}
                  disabled={write.isPending}
                  onClick={() => write.mutate({ channelId: row.channelId, actionId: row.actionId, mode: null })}>
                  <X className="size-3.5" /> Remove
                </ConnectorAction>
              )} />
          ))}
        </ConnectorRows>
      ) : null}
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </ConnectorSection>
  );
}
