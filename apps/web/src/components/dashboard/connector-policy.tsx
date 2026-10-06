"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { WEB_PROXY_ROUTES, type SerializedChannel } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { channelTitle } from "@/components/dashboard/channel-links";

/* Per-Channel action policy (docs/design/connector-platform.md §3.5): which
   write actions are allowed or denied in which Channel. Space admins edit it;
   the Hub reads it at execution time. */

interface PolicyRow { channelId: string; actionId: string; mode: "allow" | "deny" }

export function connectorWriteActions(connector: AppConnectorManifest) {
  return connector.actions.filter((action) => action.effect === "write");
}

export function ConnectorPolicy({ connector, channels, spaceId, token, userId }: {
  connector: AppConnectorManifest;
  channels: SerializedChannel[];
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
    mutationFn: (body: { channelId: string; actionId: string; mode: "allow" | "deny" | null }) =>
      xmatrixApiRequest({ url, method: "PUT", token, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const actions = connectorWriteActions(connector);
  const [actionId, setActionId] = useState(actions[0]?.id ?? "");
  const [channelId, setChannelId] = useState("");
  const [mode, setMode] = useState<"allow" | "deny">("allow");
  const channelName = (id: string) => { const channel = channels.find((candidate) => candidate.id === id); return channel ? channelTitle(channel) : id; };
  const action = (id: string) => actions.find((candidate) => candidate.id === id);
  const selectClassName = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm";

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        A Human&apos;s own command runs a write action unless the channel denies it. Agents need an allow here,
        except actions marked <strong>agents allowed by default</strong>, which a channel can still deny.
        Actions marked <strong>off by default</strong> run only in channels that allow them.
      </p>
      {write.error || policies.error ? (
        <p className="text-sm font-medium text-destructive">{(write.error ?? policies.error)?.message}</p>
      ) : null}
      <ul className="divide-y divide-border/60 text-sm">
        {(policies.data ?? []).map((row) => (
          <li key={`${row.actionId}:${row.channelId}`} className="flex items-center gap-2 py-2">
            <span className="flex-1">
              <span className="font-bold">{action(row.actionId)?.label ?? row.actionId}</span>
              {" · "}#{channelName(row.channelId)}
            </span>
            <span className={row.mode === "deny" ? "text-destructive" : "text-foreground"}>{row.mode}</span>
            <Button size="xs" variant="ghost" aria-label={`Reset ${row.actionId} in ${channelName(row.channelId)}`}
              disabled={write.isPending}
              onClick={() => write.mutate({ channelId: row.channelId, actionId: row.actionId, mode: null })}>
              <Trash2 />
            </Button>
          </li>
        ))}
        {policies.data?.length === 0 ? <li className="py-2 text-muted-foreground">Every action uses its default.</li> : null}
      </ul>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
        <GlassSelect className={selectClassName} value={actionId} aria-label="Action" onChange={setActionId}
          options={actions.map((candidate) => ({ value: candidate.id,
            label: `${candidate.label}${candidate.defaultPolicy === "deny" ? " (off by default)"
              : candidate.defaultPolicy === "allow" ? " (agents allowed by default)" : ""}` }))} />
        <GlassSelect className={selectClassName} value={channelId} placeholder="Channel" aria-label="Channel"
          onChange={setChannelId} options={channels.map((channel) => ({ value: channel.id, label: `#${channelTitle(channel)}` }))} />
        <GlassSelect className={selectClassName} value={mode} aria-label="Policy"
          onChange={(value) => setMode(value === "deny" ? "deny" : "allow")}
          options={[{ value: "allow", label: "Allow" }, { value: "deny", label: "Deny" }]} />
        <Button size="sm" type="button" disabled={!actionId || !channelId || write.isPending}
          onClick={() => write.mutate({ channelId, actionId, mode })}>
          {write.isPending ? <Loader2 className="animate-spin" /> : <Plus />} Set
        </Button>
      </div>
    </div>
  );
}
