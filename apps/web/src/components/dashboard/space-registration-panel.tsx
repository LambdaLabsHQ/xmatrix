"use client";

import { useState } from "react";
import { actionClass } from "@/components/ui/action-tone";
import { ListSkeleton } from "./content-skeleton";
import type { AgentRegistrationSummary } from "@xmatrix/protocol";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import { SetupCardHeader, SetupCardShell } from "./space-setup-card-chrome";
import { useAgentRegistrationCatalog } from "./agent-capability-select";
import { userErrorMessage } from "@/lib/user-facing-error";
import { registrationTupleId, useRegistrationCommand } from "./use-registration-command";
import { ErrorPanel } from "./workspace-admin-views";
import { agentAddCommand } from "./space-agent-setup-card";

export function SpaceRegistrationPanel({ spaceId, token }: { spaceId: string; token: string }) {
  const catalog = useAgentRegistrationCatalog(spaceId, token, Boolean(spaceId && token));
  const command = useRegistrationCommand(spaceId, token, () => void catalog.refetch());
  const installCommand = agentAddCommand(spaceId);
  const { copy, copied } = useCopyToClipboard(installCommand);
  const registrations = catalog.data?.registrations ?? [];
  return (
    <div className="mt-5">
    <SetupCardShell>
      <SetupCardHeader
        title="Registered execution locations"
        body="Add an installed harness to the Space with the machine owner's CLI. Owner and machine labels distinguish locations."
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <code className="text-xs">{installCommand}</code>
        <button type="button" className={actionClass({ variant: "secondary", size: "sm" })}
          onClick={() => void copy()}>
          {copied ? "Copied" : "Copy add command"}
        </button>
      </div>
      {catalog.isError ? (
        <div className="mt-3">
          <ErrorPanel title="Registered locations unavailable"
            error={userErrorMessage(catalog.error, "Couldn't load registered locations") ?? ""} />
        </div>
      ) : !catalog.data ? (
        <ListSkeleton label="Loading registered locations" rows={3} mark={false} className="mt-3 [--app-list-row-end:0px] [--app-list-row-start:0px]" />
      ) : !registrations.length ? (
        <p className="mt-3 text-sm text-muted-foreground">No locations are registered in this Space yet.</p>
      ) : null}
      <ul className="mt-3 grid gap-2">
        {registrations.map((location) => (
          <RegistrationRow key={registrationTupleId(location.key)} location={location}
            busy={command.pendingId === registrationTupleId(location.key)}
            onModel={(model) => void command.run(location.key, { kind: "configure", model })} />
        ))}
      </ul>
      {command.notice && <p role="status" className="mt-2 text-xs">{command.notice.text}</p>}
    </SetupCardShell>
    </div>
  );
}

function RegistrationRow({ location, busy, onModel }: {
  location: AgentRegistrationSummary; busy: boolean; onModel: (model: string) => void;
}) {
  const [model, setModel] = useState(location.models[0] ?? "");
  return (
    <li className="rounded-[16px] border border-border p-3 text-sm">
      <p className="font-semibold">{location.displayName}</p>
      <p className="text-xs text-muted-foreground">{location.ownerName} · {location.machineName} · {location.key.harness}</p>
      <p className="mt-1 text-xs">{location.routingReady ? "Ready for new work" : location.state}</p>
      {location.canConfigureSpace && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="text-xs">Default model
            <input className="mt-1 w-40 border border-border bg-background px-2 py-1" value={model}
              onChange={(event) => setModel(event.target.value)} />
          </label>
          <button type="button" disabled={busy} className={actionClass({ variant: "secondary", size: "sm" })}
            onClick={() => onModel(model)}>
            Save Space defaults
          </button>
        </div>
      )}
    </li>
  );
}
