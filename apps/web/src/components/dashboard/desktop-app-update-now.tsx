"use client";

import { useEffect } from "react";
import { CircleArrowUp, RefreshCw } from "lucide-react";
import { getDesktopBridge, type DesktopUpdateStatus } from "@/lib/desktop/bridge";
import { actionClass } from "@/components/ui/action-tone";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { cn } from "@/lib/utils";
import { NotUpdated, VersionNote } from "./workspace-admin-views";
import { formatVersion } from "./workspace-shell-formatters";

/* Releases this page already asked the App to check for: one quiet check per
   release per page, however many places show the version. */
const checkedReleases = new Set<string>();

/* This machine's App behind its channel's newest release. Seeing that starts
   one update check at once; after that the mark shows only what the App's
   updater reports, so "Downloading" is a download really running. */
export function DesktopAppBehind({ latestVersion, status, checking, onCheck, onInstall }: {
  latestVersion: string;
  /** The updater's state; null on an App build that does not stream it. */
  status: DesktopUpdateStatus | null;
  checking: boolean;
  onCheck: () => void;
  onInstall: () => void;
}) {
  // Absent on App builds from before quiet checks.
  const checkQuietly = getDesktopBridge()?.checkForUpdatesQuietly;
  const resting = status?.enabled === true && (status.state === "idle" || status.state === "not-available");
  const asked = checkedReleases.has(latestVersion);
  useEffect(() => {
    if (!resting || !checkQuietly || checkedReleases.has(latestVersion)) return;
    checkedReleases.add(latestVersion);
    void checkQuietly();
  }, [resting, checkQuietly, latestVersion]);

  const next = formatVersion(status?.version || latestVersion);
  const button = actionClass({ variant: "secondary", size: "sm" });
  const checkButton = (
    <span className="mt-1 block">
      <button type="button" className={button} onClick={onCheck} disabled={checking}>
        <AnimatedIcon icon={RefreshCw} className={cn("size-4", checking && "animate-spin")} />
        {checking ? "Checking…" : "Check for updates"}
      </button>
    </span>
  );
  if (!status) {
    return <NotUpdated>This App build updates only when it restarts. Quit and reopen xMatrix to update to {next}.</NotUpdated>;
  }
  if (!status.enabled || status.state === "disabled") {
    return <NotUpdated label="Update">
      Automatic updates are off for this App{status.message ? `: ${status.message}` : "."} Download {next} from xmatrix.sh/download.
    </NotUpdated>;
  }
  switch (status.state) {
    case "checking":
      return <VersionNote busy>Checking for updates</VersionNote>;
    case "available":
    case "downloading":
      return <VersionNote busy>
        Downloading {next}{status.percent === undefined ? "" : ` · ${Math.round(status.percent)}%`}
      </VersionNote>;
    case "downloaded":
      return <>
        <VersionNote>{next} downloaded</VersionNote>
        <button type="button" onClick={onInstall}
          className="inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-xs font-semibold text-foreground hover:bg-muted">
          <CircleArrowUp className="size-3.5" />Restart to update
        </button>
      </>;
    case "installing":
      return <VersionNote busy>Restarting to update to {next}</VersionNote>;
    case "error":
      return <NotUpdated>{status.message || "The App could not fetch its update."}{checkButton}</NotUpdated>;
    default:
      // Resting: the check this view starts is a moment away, unless it already ran.
      if (checkQuietly && !asked) return <VersionNote busy>Checking for updates</VersionNote>;
      return <NotUpdated>
        {checkQuietly ? `The App's update feed does not offer ${next} yet.` : `This App has not fetched ${next} yet.`}{checkButton}
      </NotUpdated>;
  }
}
