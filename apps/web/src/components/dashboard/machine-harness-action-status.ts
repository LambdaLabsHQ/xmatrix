import { HARNESS_ACTION_CLAIM_TTL_MS, type HarnessAction, type HarnessActionStatus } from "@xmatrix/protocol";

export const HARNESS_ACTION_LABELS: Record<HarnessAction, string> = {
  install: "Install", update: "Update", uninstall: "Uninstall", auto_update_on: "Enable automatic updates",
  auto_update_off: "Disable automatic updates", refresh: "Refresh inventory", release: "Check for a new release",
  login_start: "Sign in", login_finish: "Finish sign-in", login_cancel: "Cancel sign-in",
};

/** A connected daemon picks an action up within seconds of its wake. */
const HARNESS_ACTION_PICKUP_EXPECTED_MS = 60_000;

export type HarnessActionTone = "pending" | "done" | "warning" | "error";

/**
 * What the owner reads about one harness action. Hub's status is the only
 * fact; this only words it, including the case where an install or update
 * "succeeded" yet the re-probe still finds no launcher.
 */
export function describeHarnessAction(status: HarnessActionStatus | undefined, input: {
  displayName: string; now: number; requestedAt?: number;
}): { text: string; tone: HarnessActionTone } {
  if (!status) return { text: "Sending to the machine…", tone: "pending" };
  const requested = status.requestedAt ? Date.parse(status.requestedAt) : input.requestedAt;
  switch (status.status) {
    case "queued": {
      const waited = requested === undefined ? 0 : input.now - requested;
      if (waited < HARNESS_ACTION_PICKUP_EXPECTED_MS) return { text: "Waiting for the machine to start it…", tone: "pending" };
      const minutes = Math.max(1, Math.floor(waited / 60_000));
      return { tone: "warning", text: `The machine has not picked this up for ${minutes} min. It may not be connected; `
        + `the action is cancelled if it is not picked up within ${HARNESS_ACTION_CLAIM_TTL_MS / 60_000} minutes.` };
    }
    case "running": return { text: "Running on the machine…", tone: "pending" };
    case "succeeded": {
      const item = status.result?.item;
      if ((status.action === "install" || status.action === "update") && item && !item.installed) {
        return { tone: "warning", text: `${HARNESS_ACTION_LABELS[status.action]} finished, but ${input.displayName} `
          + "was not found on this machine's PATH. The daemon may need to be restarted to see it, or the install did not complete." };
      }
      if (status.action === "uninstall" && item?.installed) {
        return { tone: "warning", text: `Uninstall finished, but ${input.displayName} is still found on this machine.` };
      }
      return { text: "Done", tone: "done" };
    }
    case "failed": return { text: "Failed", tone: "error" };
    case "unsupported": return { text: "Not available on this machine", tone: "error" };
    case "expired": return { text: "Not completed", tone: "error" };
  }
}
