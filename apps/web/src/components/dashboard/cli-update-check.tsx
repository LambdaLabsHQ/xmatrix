"use client";

import { useQuery } from "@tanstack/react-query";
import {
  parseMachineCliUpdateStatus,
  type MachineCliUpdateCheckResponse,
  type MachineCliUpdateStatus,
  type SerializedMachineDaemon,
} from "@xmatrix/protocol";
import { xmatrixApiRequest } from "@/lib/query/api-client";
import { ComponentUpdateSteps, NotUpdated, ReleaseAge, VersionNote } from "./workspace-admin-views";
import { formatVersion } from "./workspace-shell-formatters";

const CLI_UPDATE_CHECK = "/api/xmatrix/machine-daemons/cli-update-check";

/* A Machine's CLI behind its channel. Seeing that asks its daemon to check for
   an update once (per Machine and release, per page: the query never goes
   stale, and the Hub joins any request within a minute), then shows only what
   the daemon reports doing. */
export function CliBehind({ token, machineId, daemon, latestVersion, publishedAt }: {
  token: string | null | undefined;
  machineId: string | undefined;
  daemon: SerializedMachineDaemon | undefined;
  latestVersion: string;
  publishedAt?: string;
}) {
  const ask = useQuery({
    queryKey: ["cli-update-check", machineId, latestVersion],
    enabled: Boolean(token && machineId),
    staleTime: Infinity,
    gcTime: Infinity,
    retry: false,
    queryFn: () => xmatrixApiRequest<MachineCliUpdateCheckResponse>({
      url: CLI_UPDATE_CHECK, token: token!, method: "POST", body: { machineId },
    }),
  });
  const next = formatVersion(latestVersion);
  // Not this person's Machine to ask, or no answer yet worth more than the release's age.
  if (!token || !machineId || ask.isError) return <ReleaseAge component="cli" latest={{ version: latestVersion, publishedAt }} />;
  if (!ask.data) return <VersionNote busy>Checking for updates</VersionNote>;
  const daemonVersion = ask.data.daemonVersion ? formatVersion(ask.data.daemonVersion) : "This daemon";
  switch (ask.data.outcome) {
    case "offline":
      if (!ask.data.cliUpdate) return <VersionNote>Offline · checks for {next} when it reconnects</VersionNote>;
      break;
    case "unsupported":
      return <NotUpdated>{daemonVersion} cannot be asked to update from here. <ComponentUpdateSteps component="cli" /></NotUpdated>;
    case "self_update_disabled":
      return <NotUpdated label="Update">
        Automatic updates are off for this daemon (XMATRIX_SKIP_DAEMON_SELF_UPDATE). <ComponentUpdateSteps component="cli" />
      </NotUpdated>;
  }
  const status = newest(ask.data.cliUpdate, parseMachineCliUpdateStatus(daemon?.metadata?.cliUpdate));
  switch (status?.state) {
    case "installing":
      return <VersionNote busy>Installing {status.version ? formatVersion(status.version) : next}</VersionNote>;
    case "failed":
      return <NotUpdated>{status.error} <ComponentUpdateSteps component="cli" /></NotUpdated>;
    case "current":
      return <NotUpdated>
        The daemon checked and its update feed does not offer {next} yet. <ComponentUpdateSteps component="cli" />
      </NotUpdated>;
    default:
      return <VersionNote busy>Checking for updates</VersionNote>;
  }
}

function newest(left?: MachineCliUpdateStatus, right?: MachineCliUpdateStatus) {
  if (!left || !right) return left ?? right;
  return Date.parse(right.at) >= Date.parse(left.at) ? right : left;
}
