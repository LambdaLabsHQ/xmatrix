"use client";

import { CircleArrowUp, Loader2, RefreshCw } from "lucide-react";
import type { DesktopUpdateStatus } from "@/lib/desktop/bridge";
import { actionClass } from "@/components/ui/action-tone";
import { AnimatedIcon } from "@/components/ui/animated-icon";
import { cn } from "@/lib/utils";

/* This machine's App, updated where its version is marked: the App's own
   updater downloads in the background and installs on restart, so the step
   left for the person is the restart (or a check, when nothing is fetched). */
export function DesktopAppUpdateNow({ status, checking, onCheck, onInstall }: {
  /** The updater's state; null on an App build that does not stream it. */
  status: DesktopUpdateStatus | null;
  checking: boolean;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const button = actionClass({ variant: "secondary", size: "sm" });
  if (!status) {
    return <>This App build installs updates when it restarts. Quit and reopen xMatrix to update it.</>;
  }
  if (!status.enabled) {
    return <>Updates are turned off for this App build. Download the latest xMatrix from xmatrix.sh/download.</>;
  }
  const next = status.version ? ` v${status.version.replace(/^v/u, "")}` : "";
  switch (status.state) {
    case "downloaded":
      return <button type="button" className={button} onClick={onInstall}>
        <CircleArrowUp className="size-4" />Restart to update to{next || " the new version"}
      </button>;
    case "available":
      return <button type="button" className={button} onClick={onInstall}>
        <CircleArrowUp className="size-4" />Download{next}
      </button>;
    case "installing":
      return <span className="inline-flex items-center gap-1.5"><AnimatedIcon icon={Loader2} className="size-4 animate-spin" />Restarting…</span>;
    case "downloading":
      return <span className="inline-flex items-center gap-1.5">
        <AnimatedIcon icon={Loader2} className="size-4 animate-spin" />
        Downloading{next}{status.percent === undefined ? "…" : ` · ${Math.round(status.percent)}%`}
      </span>;
    default: {
      const busy = checking || status.state === "checking";
      return <span className="inline-flex flex-wrap items-center gap-2">
        <button type="button" className={button} onClick={onCheck} disabled={busy}>
          <AnimatedIcon icon={RefreshCw} className={cn("size-4", busy && "animate-spin")} />
          {busy ? "Checking…" : "Check for updates"}
        </button>
        {status.state === "error" && status.message && <span role="alert" className="text-destructive">{status.message}</span>}
      </span>;
    }
  }
}
