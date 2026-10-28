"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { WEB_PROXY_ROUTES, type ConnectorActionPolicy, type ChannelSnapshot } from "@xmatrix/protocol";
import { actionClass } from "@/components/ui/action-tone";
import { GlassSelect } from "@/components/ui/glass-select";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { channelTitle } from "@/components/dashboard/channel-links";
import { ConnectorAction, ConnectorAddRow, ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";

/* Per-Channel action policy (docs/design/connector-platform.md §3.5): which
   write actions are allowed, ask for approval, or are disallowed in a Channel. Space admins edit it;
   the Hub reads it at execution time. Without a rule an action keeps its own
   default (`defaultPolicy`, else allow), so the page says the defaults in one
   sentence and lists only the rules that differ. */

interface PolicyRow { channelId: string; actionId: string; mode: ConnectorActionPolicy }

const RULE_LABELS: Record<ConnectorActionPolicy, string> = { allow: "Allowed", ask: "Asks first", disallow: "Disallowed" };
const CHOICE_LABELS: Record<ConnectorActionPolicy, string> = { allow: "Allow", ask: "Ask first", disallow: "Disallow" };
const DEFAULT_VERBS: Record<ConnectorActionPolicy, [one: string, many: string]> = {
  allow: ["runs", "run"], ask: ["asks for approval first", "ask for approval first"], disallow: ["is off", "are off"],
};

export function connectorWriteActions(connector: AppConnectorManifest) {
  return connector.actions.filter((action) => action.effect === "write");
}

/** "Unless a channel has a rule of its own, 9 actions run; Dispatch workflow is off." */
function connectorPolicyDefaults(connector: AppConnectorManifest): string {
  const actions = connectorWriteActions(connector);
  const modes = (["allow", "ask", "disallow"] as const).map((mode) => ({
    mode, named: actions.filter((action) => (action.defaultPolicy ?? "allow") === mode),
  })).filter(({ named }) => named.length > 0);
  if (modes.length === 1) {
    const [one] = DEFAULT_VERBS[modes[0]!.mode];
    return `${actions.length === 1 ? actions[0]!.label : "Every action"} ${one} unless a channel has a rule of its own.`;
  }
  const parts = modes.map(({ mode, named }) => {
    const [one, many] = DEFAULT_VERBS[mode];
    if (named.length === 1) return `${named[0]!.label} ${one}`;
    return named.length === 2 ? `${named.map((action) => action.label).join(" and ")} ${many}` : `${named.length} actions ${many}`;
  });
  return `Unless a channel has a rule of its own, ${parts.join("; ")}.`;
}

/** Connecting an app is not consent to its writes: say how an action that asks can run without asking. */
function connectorPolicyNote(connector: AppConnectorManifest): string {
  const defaults = connectorPolicyDefaults(connector);
  return connectorWriteActions(connector).some((action) => action.defaultPolicy === "ask")
    ? `${defaults} To let agents act without asking in a channel, add a rule there set to Allow.`
    : defaults;
}

/** The action select's choice that writes one rule for each write action. */
const EVERY_ACTION = "*";

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
    queryFn: ({ signal }) => xmatrixApiRequest<{ policies?: PolicyRow[] }>({ url, token, signal })
      .then((payload) => payload.policies ?? []),
  });
  const write = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: (body: { channelId: string; actionId: string; mode: ConnectorActionPolicy | null }) =>
      xmatrixApiRequest({ url, method: "PUT", token, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const actions = connectorWriteActions(connector);
  const [adding, setAdding] = useState(false);
  const [actionId, setActionId] = useState(actions.length > 1 ? EVERY_ACTION : actions[0]?.id ?? "");
  const [channelId, setChannelId] = useState("");
  const [mode, setMode] = useState<ConnectorActionPolicy>(connector.id === "gmail" ? "ask" : "allow");
  const channelName = (id: string) => { const channel = channels.find((candidate) => candidate.id === id); return channel ? channelTitle(channel) : id; };
  const action = (id: string) => actions.find((candidate) => candidate.id === id);
  const modes: ConnectorActionPolicy[] = ["allow", ...(connector.id === "github" ? [] : ["ask" as const]), "disallow"];
  const error = userErrorMessage(write.error ?? policies.error, "Couldn't save the app settings");
  /* One rule per action, so each stays its own row to change or remove later. */
  async function saveRule() {
    for (const id of actionId === EVERY_ACTION ? actions.map((candidate) => candidate.id) : [actionId]) {
      await write.mutateAsync({ channelId, actionId: id, mode });
    }
    setAdding(false); setChannelId("");
  }

  return (
    <ConnectorSection title="Permissions" testId="connector-policy"
      note={connectorPolicyNote(connector)}>
      <ConnectorRows>
        {(policies.data ?? []).map((row) => (
          <ConnectorRow key={`${row.actionId}:${row.channelId}`} testId="connector-policy-rule"
            title={action(row.actionId)?.label ?? row.actionId}
            meta={<>In #{channelName(row.channelId)} · <span className={row.mode === "disallow" ? "text-destructive" : "text-foreground"}>
              {RULE_LABELS[row.mode]}</span></>}
            trailing={(
              <ConnectorAction aria-label={`Reset ${row.actionId} in ${channelName(row.channelId)}`} title="Back to the default"
                disabled={write.isPending}
                onClick={() => write.mutate({ channelId: row.channelId, actionId: row.actionId, mode: null })}>
                <X className="size-3.5" /> Remove
              </ConnectorAction>
            )} />
        ))}
        {adding ? (
          <li className="py-2.5">
            <div className="grid gap-2 sm:grid-cols-[1.3fr_1fr_0.8fr]">
              <GlassSelect value={actionId} aria-label="Action" onChange={setActionId}
                options={[...(actions.length > 1 ? [{ value: EVERY_ACTION, label: "Every action" }] : []),
                  ...actions.map((candidate) => ({ value: candidate.id, label: candidate.label }))]} />
              <GlassSelect value={channelId} placeholder="Channel" aria-label="Channel" onChange={setChannelId}
                options={channels.map((channel) => ({ value: channel.id, label: `#${channelTitle(channel)}` }))} />
              <GlassSelect value={mode} aria-label="Policy" onChange={(value) => setMode(value as ConnectorActionPolicy)}
                options={modes.map((value) => ({ value, label: CHOICE_LABELS[value] }))} />
            </div>
            <div className="mt-2 flex items-center gap-1">
              <button type="button" disabled={!actionId || !channelId || write.isPending}
                className={actionClass({ variant: "secondary", size: "sm" })}
                onClick={() => void saveRule().catch(() => undefined)}>
                {write.isPending ? <AnimatedIcon icon={Loader2} className="size-3.5 animate-spin" /> : null} Save rule
              </button>
              <ConnectorAction onClick={() => setAdding(false)}>Cancel</ConnectorAction>
            </div>
          </li>
        ) : (
          <ConnectorAddRow label="Add a channel rule" onClick={() => setAdding(true)} testId="connector-policy-add" />
        )}
      </ConnectorRows>
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </ConnectorSection>
  );
}
