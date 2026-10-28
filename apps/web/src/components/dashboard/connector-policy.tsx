"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { WEB_PROXY_ROUTES } from "@xmatrix/protocol";
import { GlassSelect } from "@/components/ui/glass-select";
import { type AppConnectorManifest } from "@/lib/app-connectors";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { xmatrixQueryKeys } from "@/lib/query/query-keys";
import { userErrorMessage } from "@/lib/user-facing-error";
import { ConnectorRow, ConnectorRows, ConnectorSection } from "./connector-page";

/* An app's permission (docs/design/connector-platform.md §3.5): one choice
   per connected app, the same in every Channel. Reading is always allowed; the
   choice is what its write actions do: none run, each waits for a Space admin,
   or they run. */

type AppPermission = "read" | "ask" | "write";

const CHOICES: Record<AppPermission, { label: string; meta: string }> = {
  read: { label: "Read only", meta: "Agents read; they never change anything" },
  ask: { label: "Ask first", meta: "Agents read; each change waits for a Space admin to approve it" },
  write: { label: "Read and write", meta: "Agents read and make changes directly" },
};

export function connectorWriteActions(connector: AppConnectorManifest) {
  return connector.actions.filter((action) => action.effect === "write");
}

export function ConnectorPolicy({ connector, spaceId, token, userId }: {
  connector: AppConnectorManifest;
  spaceId: string;
  token: string;
  userId: string;
}) {
  const queryClient = useQueryClient();
  const key = xmatrixQueryKeys.domain({ userId }, "app-connection-policies", [spaceId, connector.id]);
  const url = WEB_PROXY_ROUTES.space_app_connection_policies(spaceId, connector.id);
  const permission = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => xmatrixApiRequest<{ mode: AppPermission; inherited: boolean }>({ url, token, signal }),
  });
  const write = useMutation({
    mutationKey: [...key, "put"],
    mutationFn: (mode: AppPermission) => xmatrixApiRequest({ url, method: "PUT", token, body: { mode } }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: key }),
  });
  const modes: AppPermission[] = ["read", ...(connector.id === "github" ? [] : ["ask" as const]), "write"];
  const mode = permission.data?.mode;
  const error = userErrorMessage(write.error ?? permission.error, "Couldn't save the app settings");

  return (
    <ConnectorSection title="Permissions" testId="connector-policy">
      <ConnectorRows>
        <ConnectorRow title="Agents may" meta={mode ? CHOICES[mode].meta : null}
          trailing={(
            <GlassSelect value={mode ?? ""} aria-label="Agents may" disabled={write.isPending || !mode}
              onChange={(value) => write.mutate(value as AppPermission)}
              options={modes.map((value) => ({ value, label: CHOICES[value].label }))} />
          )} />
      </ConnectorRows>
      {error ? <p role="alert" className="mt-1 text-[13px] font-medium text-destructive">{error}</p> : null}
    </ConnectorSection>
  );
}
