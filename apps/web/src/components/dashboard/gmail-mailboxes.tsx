"use client";

import { AnimatedIcon } from "@/components/ui/animated-icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { WEB_PROXY_ROUTES, type SpaceMember } from "@xmatrix/protocol";
import { Button } from "@/components/ui/button";
import { GlassSelect } from "@/components/ui/glass-select";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { useAgentRegistrationCatalog } from "./agent-capability-select";

/* The Gmail connection's mailboxes and who each belongs to: one member (and
   their Agents' Runs) or one Agent registration. Only the owner may use a
   mailbox; Space admins reassign or remove them here, and Connect adds one. */

interface MailboxRow { address: string; owner: string }

function agentOwner(key: { ownerUserId: string; machineId: string; harness: string }) {
  return `agent:${[key.ownerUserId, key.machineId, key.harness].map(encodeURIComponent).join("/")}`;
}

export function GmailMailboxes({ spaceId, token, userId, members, adding, onAdd }: {
  spaceId: string;
  token: string;
  userId: string;
  members: SpaceMember[];
  adding: boolean;
  onAdd: () => void;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "gmail-mailboxes", [spaceId]);
  const url = WEB_PROXY_ROUTES.space_app_connection_gmail_mailboxes(spaceId);
  const mailboxes = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<{ mailboxes?: MailboxRow[] }>({ url, token, signal })
      .then((payload) => payload.mailboxes ?? []),
  });
  const agents = useAgentRegistrationCatalog(spaceId, token, true);
  const write = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: (body: { address: string; owner: string | null }) => xmatrixApiRequest({ url, method: "PUT", token, body }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const owners = [
    ...members.map((member) => ({ value: `user:${member.userId}`, label: member.name || member.email || member.userId })),
    ...(agents.data?.registrations ?? []).filter((registration) => registration.state === "enabled")
      .map((registration) => ({ value: agentOwner(registration.key), label: `${registration.displayName} · ${registration.machineName}` })),
  ];
  const ownerOptions = (current: string) => owners.some((option) => option.value === current)
    ? owners : [...owners, { value: current, label: "No longer in this Space" }];
  const selectClassName = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm";

  return (
    <div className="space-y-3">
      <p className="text-xs leading-5 text-muted-foreground">
        Each mailbox is used only by the member it belongs to and their Agents, or by the one Agent it belongs to.
      </p>
      {write.error || mailboxes.error ? (
        <p className="text-sm font-medium text-destructive">{(write.error ?? mailboxes.error)?.message}</p>
      ) : null}
      <ul className="divide-y divide-border/60 text-sm">
        {(mailboxes.data ?? []).map((row) => (
          <li key={row.address} className="grid items-center gap-2 py-2 sm:grid-cols-[1fr_1fr_auto]">
            <span className="truncate font-bold">{row.address}</span>
            <GlassSelect className={selectClassName} value={row.owner} aria-label={`Owner of ${row.address}`}
              onChange={(owner) => write.mutate({ address: row.address, owner })} options={ownerOptions(row.owner)} />
            <Button size="xs" variant="ghost" aria-label={`Remove ${row.address}`} disabled={write.isPending}
              onClick={() => write.mutate({ address: row.address, owner: null })}>
              <Trash2 />
            </Button>
          </li>
        ))}
        {mailboxes.data?.length === 0 ? <li className="py-2 text-muted-foreground">No mailbox is connected.</li> : null}
      </ul>
      <Button size="sm" type="button" disabled={adding} onClick={onAdd}>
        {adding ? <AnimatedIcon icon={Loader2} className="animate-spin" /> : <Plus />} Add mailbox
      </Button>
    </div>
  );
}
